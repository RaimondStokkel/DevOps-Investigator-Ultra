import { AzureOpenAIClient, type ChatMessage, type ToolCall } from "./azure-openai-client.js";
import { ToolExecutor } from "./tool-executor.js";
import { SYSTEM_PROMPT } from "./prompts/system-prompt.js";

export interface AgentLoopOptions {
  maxTurns?: number;
  maxTokens?: number;
  verbose?: boolean;
  onEvent?: (event: AgentLoopEvent) => void;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
}

export type AgentLoopEvent =
  | { type: "start"; userPrompt: string }
  | { type: "turn"; turn: number; maxTurns: number }
  | { type: "assistant_chunk"; chunk: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; content: string }
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

      // Call Azure OpenAI
        const response = await this.openaiClient.chatCompletionStream(
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
          this.options.abortSignal
        );

      // If there's text content, add it to messages
        if (response.content) {
          this.messages.push({
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
          });
        } else if (response.toolCalls.length > 0) {
          this.messages.push({
            role: "assistant",
            content: null,
            tool_calls: response.toolCalls,
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
          this.log(`[Tool Result] ${this.truncate(result.content, 300)}`);
          this.options.onEvent?.({ type: "tool_result", content: result.content });

          this.messages.push({
            role: "tool",
            tool_call_id: result.tool_call_id,
            content: result.content,
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
}
