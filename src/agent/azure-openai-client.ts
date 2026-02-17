import type { AgentConfig } from "../server/config.js";
import type { ReasoningMode } from "../server/config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface FunctionDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
}

export class AzureOpenAIClient {
  private profiles: AgentConfig["reasoningProfiles"];
  private apiKey: string;
  private defaultReasoningMode: ReasoningMode;
  private static readonly O4_MIN_MIN_API_VERSION = "2024-12-01-preview";

  constructor(config: AgentConfig) {
    this.profiles = config.reasoningProfiles;
    this.apiKey = config.azureOpenAiKey;
    this.defaultReasoningMode = config.defaultReasoningMode;
  }

  private getProfile(reasoningMode?: ReasoningMode) {
    const mode = reasoningMode ?? this.defaultReasoningMode;
    return this.profiles[mode] ?? this.profiles.base;
  }

  private extractApiDate(apiVersion: string): string | null {
    const match = apiVersion.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] ?? null;
  }

  private normalizeApiVersion(deployment: string, apiVersion: string): string {
    if (!deployment.toLowerCase().startsWith("o4-mini")) return apiVersion;
    const currentDate = this.extractApiDate(apiVersion);
    const minDate = this.extractApiDate(AzureOpenAIClient.O4_MIN_MIN_API_VERSION);
    if (!currentDate || !minDate || currentDate < minDate) {
      return AzureOpenAIClient.O4_MIN_MIN_API_VERSION;
    }
    return apiVersion;
  }

  private isO4MiniApiVersionError(errorBody: string): boolean {
    const msg = errorBody.toLowerCase();
    return msg.includes("model o4-mini is enabled only for api versions")
      || msg.includes("2024-12-01-preview and later");
  }

  async chatCompletion(
    messages: ChatMessage[],
    tools?: FunctionDefinition[],
    maxTokens?: number,
    signal?: AbortSignal,
    reasoningMode?: ReasoningMode
  ): Promise<ChatCompletionResponse> {
    const profile = this.getProfile(reasoningMode);
    let apiVersion = this.normalizeApiVersion(profile.deployment, profile.apiVersion);
    let url = `${profile.endpoint}/openai/deployments/${profile.deployment}/chat/completions?api-version=${apiVersion}`;

    const body: Record<string, unknown> = {
      messages,
      max_completion_tokens: maxTokens ?? 4096,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      let errorBody = await response.text();
      if (
        response.status === 400
        && this.isO4MiniApiVersionError(errorBody)
        && profile.deployment.toLowerCase().startsWith("o4-mini")
        && apiVersion !== AzureOpenAIClient.O4_MIN_MIN_API_VERSION
      ) {
        apiVersion = AzureOpenAIClient.O4_MIN_MIN_API_VERSION;
        url = `${profile.endpoint}/openai/deployments/${profile.deployment}/chat/completions?api-version=${apiVersion}`;
        response = await fetch(url, {
          method: "POST",
          headers: {
            "api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          errorBody = await response.text();
        }
      }

      if (!response.ok) {
        throw new Error(`Azure OpenAI API error ${response.status}: ${errorBody}`);
      }
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: ToolCall[];
        };
        finish_reason: string;
      }>;
    };

    const choice = data.choices[0];
    return {
      content: choice.message.content,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason as ChatCompletionResponse["finishReason"],
    };
  }

  async chatCompletionStream(
    messages: ChatMessage[],
    tools?: FunctionDefinition[],
    maxTokens?: number,
    onContent?: (chunk: string) => void,
    onToolCall?: (toolCall: ToolCall) => void,
    signal?: AbortSignal,
    reasoningMode?: ReasoningMode
  ): Promise<ChatCompletionResponse> {
    const profile = this.getProfile(reasoningMode);
    let apiVersion = this.normalizeApiVersion(profile.deployment, profile.apiVersion);
    let url = `${profile.endpoint}/openai/deployments/${profile.deployment}/chat/completions?api-version=${apiVersion}`;

    const body: Record<string, unknown> = {
      messages,
      max_completion_tokens: maxTokens ?? 4096,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      let errorBody = await response.text();
      if (
        response.status === 400
        && this.isO4MiniApiVersionError(errorBody)
        && profile.deployment.toLowerCase().startsWith("o4-mini")
        && apiVersion !== AzureOpenAIClient.O4_MIN_MIN_API_VERSION
      ) {
        apiVersion = AzureOpenAIClient.O4_MIN_MIN_API_VERSION;
        url = `${profile.endpoint}/openai/deployments/${profile.deployment}/chat/completions?api-version=${apiVersion}`;
        response = await fetch(url, {
          method: "POST",
          headers: {
            "api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          errorBody = await response.text();
        }
      }

      if (!response.ok) {
        throw new Error(`Azure OpenAI API error ${response.status}: ${errorBody}`);
      }
    }

    // Parse SSE stream
    let fullContent = "";
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: ChatCompletionResponse["finishReason"] = "stop";

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{
              delta: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
          };

          const delta = parsed.choices[0]?.delta;
          if (!delta) continue;

          // Content chunks
          if (delta.content) {
            fullContent += delta.content;
            onContent?.(delta.content);
          }

          // Tool call chunks (reconstructed by index)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallsMap.get(tc.index);
              if (!existing) {
                toolCallsMap.set(tc.index, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          }

          if (parsed.choices[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason as ChatCompletionResponse["finishReason"];
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    // Build final tool calls
    const toolCalls: ToolCall[] = Array.from(toolCallsMap.values())
      .sort((a, b) => {
        // Maintain order by map insertion order (index)
        return 0;
      })
      .map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

    // Notify about completed tool calls
    for (const tc of toolCalls) {
      onToolCall?.(tc);
    }

    return {
      content: fullContent || null,
      toolCalls,
      finishReason,
    };
  }
}
