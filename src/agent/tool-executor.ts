import type { ToolCall, FunctionDefinition } from "./azure-openai-client.js";
import type { McpClient } from "./mcp-client.js";
import type { LocalTools } from "./local-tools.js";

export interface ToolResult {
  tool_call_id: string;
  content: string;
}

/**
 * Routes tool calls from Azure OpenAI to the right handler:
 * - Tools prefixed ado_* -> MCP client (Azure DevOps server)
 * - Tools prefixed local_* -> local file tools
 */
export class ToolExecutor {
  constructor(
    private mcpClient: McpClient,
    private localTools: LocalTools
  ) {}

  getAllToolDefinitions(): FunctionDefinition[] {
    return [
      ...this.mcpClient.getToolsAsOpenAIFunctions(),
      ...this.localTools.getToolDefinitions(),
    ];
  }

  async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    const { name } = toolCall.function;
    let args: Record<string, unknown>;

    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return {
        tool_call_id: toolCall.id,
        content: `Error: Could not parse arguments: ${toolCall.function.arguments}`,
      };
    }

    try {
      let result: string;

      if (name.startsWith("ado_")) {
        // Strip the ado_ prefix and route to MCP server
        const mcpToolName = name.slice(4);
        result = await this.mcpClient.executeTool(mcpToolName, args);
      } else if (name.startsWith("local_")) {
        // Route to local file tools
        result = await this.localTools.executeTool(name, args);
      } else {
        result = `Error: Unknown tool prefix. Expected ado_* or local_*. Got: ${name}`;
      }

      return {
        tool_call_id: toolCall.id,
        content: result,
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        tool_call_id: toolCall.id,
        content: `Error executing ${name}: ${error.message}`,
      };
    }
  }

  async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    // Execute tool calls sequentially to avoid race conditions
    const results: ToolResult[] = [];
    for (const toolCall of toolCalls) {
      const result = await this.executeToolCall(toolCall);
      results.push(result);
    }
    return results;
  }
}
