import { spawn, type ChildProcess } from "child_process";
import type { FunctionDefinition } from "./azure-openai-client.js";

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCP Client that connects to our MCP server via stdio.
 * Implements the MCP JSON-RPC protocol for tool discovery and execution.
 * Pattern based on C:\Repo\MCP\index.js listServerTools().
 */
export class McpClient {
  private process: ChildProcess | null = null;
  private tools: McpTool[] = [];
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private buffer = "";

  constructor(
    private serverCommand: string,
    private serverArgs: string[],
    private serverEnv?: Record<string, string>
  ) {}

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.process = spawn(this.serverCommand, this.serverArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.serverEnv },
        shell: true,
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        this.handleData(data.toString());
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        // Log stderr but don't fail
        process.stderr.write(`[MCP Server] ${data.toString()}`);
      });

      this.process.on("error", (err) => {
        reject(new Error(`Failed to start MCP server: ${err.message}`));
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.error(`MCP server exited with code ${code}`);
        }
      });

      // Give the process a moment to start, then initialize
      setTimeout(async () => {
        try {
          await this.initialize();
          await this.discoverTools();
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 500);
    });
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Process complete JSON-RPC messages (line-delimited)
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed);
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
          const pending = this.pendingRequests.get(message.id)!;
          this.pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(new Error(`MCP error: ${JSON.stringify(message.error)}`));
          } else {
            pending.resolve(message.result);
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const data = JSON.stringify(message) + "\n";
      this.process?.stdin?.write(data);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "devops-build-investigator-agent",
        version: "1.0.0",
      },
    });

    // Send initialized notification (no id, no response expected)
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }) + "\n";
    this.process?.stdin?.write(notification);
  }

  private async discoverTools(): Promise<void> {
    const result = (await this.sendRequest("tools/list")) as {
      tools: McpTool[];
    };
    this.tools = result.tools;
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  /**
   * Convert MCP tools to OpenAI function definitions with ado_ prefix.
   */
  getToolsAsOpenAIFunctions(): FunctionDefinition[] {
    return this.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: `ado_${tool.name}`,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * Execute an MCP tool call.
   */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.sendRequest("tools/call", {
      name: toolName,
      arguments: args,
    })) as {
      content: Array<{ type: string; text: string }>;
    };

    return result.content.map((c) => c.text).join("\n");
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
  }
}
