import { AzureOpenAIClient, type ChatMessage, type ToolCall } from "./azure-openai-client.js";
import { ToolExecutor } from "./tool-executor.js";
import { SYSTEM_PROMPT } from "./prompts/system-prompt.js";
import type { ReasoningMode } from "../server/config.js";

export interface AgentLoopOptions {
  maxTurns?: number;
  maxTokens?: number;
  verbose?: boolean;
  onEvent?: (event: AgentLoopEvent) => void;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  maxContextChars?: number;
  maxToolResultChars?: number;
  maxAssistantMessageChars?: number;
  reasoningMode?: ReasoningMode;
  maxToolCallArgsChars?: number;
}

export type AgentLoopEvent =
  | { type: "start"; userPrompt: string }
  | { type: "turn"; turn: number; maxTurns: number }
  | { type: "assistant_chunk"; chunk: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; content: string }
  | { type: "debug"; payload: Record<string, unknown> }
  | { type: "complete"; result: string }
  | { type: "canceled" }
  | { type: "max_turns" };

/**
 * Core agent loop: Azure OpenAI + function calling + tool execution.
 *
 * 1. Build messages: [system_prompt, user_message]
 * 2. Call Azure OpenAI with all tool definitions
 * 3. If response has tool_calls:
 *    a. Execute each tool call via tool-executor
 *    b. Append tool results to messages
 *    c. Go to step 2
 * 4. If response is text: output to user, done
 * 5. Repeat until no more tool calls or max turns reached
 */
export class AgentLoop {
  private messages: ChatMessage[] = [];
  private turnCount = 0;

  constructor(
    private openaiClient: AzureOpenAIClient,
    private toolExecutor: ToolExecutor,
    private options: AgentLoopOptions = {}
  ) {
    this.options.maxTurns = options.maxTurns ?? 30;
    this.options.maxTokens = options.maxTokens ?? 4096;
    this.options.maxContextChars = options.maxContextChars ?? this.getEnvNumber("AGENT_MAX_CONTEXT_CHARS", 120_000);
    this.options.maxToolResultChars = options.maxToolResultChars ?? this.getEnvNumber("AGENT_MAX_TOOL_RESULT_CHARS", 12_000);
    this.options.maxAssistantMessageChars = options.maxAssistantMessageChars ?? this.getEnvNumber("AGENT_MAX_ASSISTANT_CHARS", 20_000);
    this.options.maxToolCallArgsChars = options.maxToolCallArgsChars ?? this.getEnvNumber("AGENT_MAX_TOOL_CALL_ARGS_CHARS", 4_000);
  }

  async run(userPrompt: string): Promise<string> {
    // Initialize conversation
    this.messages = [
      { role: "system", content: this.options.systemPrompt ?? SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    const tools = this.toolExecutor.getAllToolDefinitions();
    this.turnCount = 0;

    this.log("\n========================================");
    this.log("  DevOps Build Investigation Agent");
    this.log("========================================\n");
    this.log(`User: ${userPrompt}\n`);
    this.options.onEvent?.({ type: "start", userPrompt });

    try {
      while (this.turnCount < this.options.maxTurns!) {
        if (this.options.abortSignal?.aborted) {
          this.options.onEvent?.({ type: "canceled" });
          return "Investigation cancelled by user.";
        }

        this.turnCount++;
        this.log(`--- Turn ${this.turnCount}/${this.options.maxTurns} ---`);
        this.options.onEvent?.({
          type: "turn",
          turn: this.turnCount,
          maxTurns: this.options.maxTurns!,
        });

        this.enforceContextBudget();

      // Call Azure OpenAI
        let retriedForContext = false;
        let response;

        while (true) {
          try {
            response = await this.openaiClient.chatCompletionStream(
              this.messages,
              tools,
              this.options.maxTokens,
              // Stream content to console
              (chunk) => {
                process.stdout.write(chunk);
                this.options.onEvent?.({ type: "assistant_chunk", chunk });
              },
              // Log tool calls
              (tc) => {
                this.log(`\n[Tool Call] ${tc.function.name}(${this.truncate(tc.function.arguments, 200)})`);
                this.options.onEvent?.({
                  type: "tool_call",
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                });
              },
              this.options.abortSignal,
              this.options.reasoningMode
            );
            break;
          } catch (error) {
            if (!retriedForContext && this.isContextLengthError(error)) {
              retriedForContext = true;
              this.log("[Context] Token limit exceeded. Compacting conversation and retrying...");
              this.compactConversationAggressively();
              continue;
            }
            throw error;
          }
        }

      // If there's text content, add it to messages
        if (response.content) {
          const boundedAssistantContent = this.boundContent(
            response.content,
            this.options.maxAssistantMessageChars!,
            "assistant response"
          );
          const boundedToolCalls = this.boundToolCalls(response.toolCalls);
          this.messages.push({
            role: "assistant",
            content: boundedAssistantContent,
            tool_calls: boundedToolCalls.length > 0 ? boundedToolCalls : undefined,
          });
        } else if (response.toolCalls.length > 0) {
          const boundedToolCalls = this.boundToolCalls(response.toolCalls);
          this.messages.push({
            role: "assistant",
            content: null,
            tool_calls: boundedToolCalls,
          });
        }

      // If no tool calls, we're done
        if (response.toolCalls.length === 0 || response.finishReason === "stop") {
          this.log("\n\n--- Investigation Complete ---\n");
          const result = response.content ?? "";
          this.options.onEvent?.({ type: "complete", result });
          return result;
        }

      // Execute tool calls
        this.log("");
        const results = await this.toolExecutor.executeToolCalls(response.toolCalls);

        for (const result of results) {
          const boundedToolContent = this.boundContent(
            result.content,
            this.options.maxToolResultChars!,
            "tool result"
          );

          this.log(`[Tool Result] ${this.truncate(boundedToolContent, 300)}`);
          this.options.onEvent?.({ type: "tool_result", content: boundedToolContent });

          this.messages.push({
            role: "tool",
            tool_call_id: result.tool_call_id,
            content: boundedToolContent,
          });
        }

        this.log("");
      }
    } catch (error) {
      if (this.isAbortError(error)) {
        this.options.onEvent?.({ type: "canceled" });
        return "Investigation cancelled by user.";
      }
      throw error;
    }

    this.log("\n--- Max turns reached ---\n");
    this.options.onEvent?.({ type: "max_turns" });
    return "Investigation stopped: maximum turns reached.";
  }

  private log(message: string): void {
    if (this.options.verbose) {
      console.error(message);
    }
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + "...";
  }

  private isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybeError = error as { name?: string; message?: string };
    return maybeError.name === "AbortError" || maybeError.message?.includes("aborted") === true;
  }

  private isContextLengthError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybeError = error as { message?: string };
    const message = maybeError.message?.toLowerCase() ?? "";
    return message.includes("context_length_exceeded")
      || message.includes("input tokens exceed")
      || message.includes("configured limit");
  }

  private getEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
  }

  private contentLength(message: ChatMessage): number {
    let len = 0;
    if (typeof message.content === "string") len += message.content.length;
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        len += call.function.name.length;
        len += call.function.arguments.length;
      }
    }
    return len + 32;
  }

  private totalContextChars(): number {
    return this.messages.reduce((total, msg) => total + this.contentLength(msg), 0);
  }

  private enforceContextBudget(): void {
    this.shrinkMessagesInPlace();

    const maxChars = this.options.maxContextChars!;
    if (this.messages.length <= 2) return;

    while (this.totalContextChars() > maxChars && this.messages.length > 2) {
      this.messages.splice(1, 1);
    }

    if (this.totalContextChars() > maxChars) {
      this.shrinkMessagesInPlace(true);
    }
  }

  private compactConversationAggressively(): void {
    if (this.messages.length <= 2) return;

    const system = this.messages[0];
    const tail = this.messages.slice(-8).map((message) => {
      if (typeof message.content === "string") {
        return {
          ...message,
          content: this.boundContent(message.content, 4_000, `${message.role} message`),
        };
      }
      return message;
    });

    this.messages = [system, ...tail];
    this.shrinkMessagesInPlace(true);
    this.enforceContextBudget();
  }

  private boundToolCalls(toolCalls: ToolCall[]): ToolCall[] {
    return toolCalls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: this.boundContent(
          call.function.arguments,
          this.options.maxToolCallArgsChars!,
          `tool call args (${call.function.name})`
        ),
      },
    }));
  }

  private shrinkMessagesInPlace(aggressive = false): void {
    const toolLimit = aggressive
      ? Math.min(this.options.maxToolResultChars!, 6_000)
      : this.options.maxToolResultChars!;
    const assistantLimit = aggressive
      ? Math.min(this.options.maxAssistantMessageChars!, 8_000)
      : this.options.maxAssistantMessageChars!;
    const userLimit = aggressive ? 4_000 : 8_000;
    const initialUserLimit = aggressive ? 6_000 : 12_000;

    this.messages = this.messages.map((message, index) => {
      let content = message.content;
      if (typeof content === "string") {
        if (message.role === "tool") {
          content = this.boundContent(content, toolLimit, "tool message");
        } else if (message.role === "assistant") {
          content = this.boundContent(content, assistantLimit, "assistant message");
        } else if (message.role === "user") {
          const limit = index === 1 ? initialUserLimit : userLimit;
          content = this.boundContent(content, limit, "user message");
        }
      }

      const toolCalls = message.tool_calls
        ? this.boundToolCalls(message.tool_calls)
        : undefined;

      return {
        ...message,
        content,
        tool_calls: toolCalls,
      };
    });
  }

  private boundContent(content: string, maxChars: number, label: string): string {
    if (content.length <= maxChars) return content;
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = Math.max(0, maxChars - headLen);
    const head = content.slice(0, headLen);
    const tail = tailLen > 0 ? content.slice(-tailLen) : "";
    return `${head}\n\n[${label} truncated from ${content.length} to ${maxChars} chars]\n\n${tail}`;
  }
}
