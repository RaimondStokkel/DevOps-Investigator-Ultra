import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerBuildLogTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "get_build_log",
    "Get the raw log text for a specific task in a build. Use get_build_timeline first to find the logId of the failing task. Supports line ranges to avoid overwhelming context with large logs.",
    {
      buildId: z.number().describe("The build ID"),
      logId: z.number().describe("The log ID from the timeline record"),
      startLine: z.number().optional().describe("Start line (1-based). Omit to start from beginning."),
      endLine: z.number().optional().describe("End line (1-based). Omit to read to end."),
    },
    async ({ buildId, logId, startLine, endLine }) => {
      const logText = await client.getBuildLog(buildId, logId, startLine, endLine);

      // Truncate if extremely large (> 50KB)
      const maxLength = 50_000;
      const truncated = logText.length > maxLength;
      const text = truncated
        ? logText.slice(0, maxLength) + `\n\n... [TRUNCATED - showing first ${maxLength} chars of ${logText.length}. Use startLine/endLine to read specific sections.]`
        : logText;

      return {
        content: [
          {
            type: "text",
            text: `Build ${buildId}, Log ${logId}${startLine ? ` (lines ${startLine}-${endLine ?? "end"})` : ""}:\n\n${text}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_build_log_summary",
    "Get the last 200 lines of a build log, where errors typically appear. A quick way to see what went wrong without reading the entire log.",
    {
      buildId: z.number().describe("The build ID"),
      logId: z.number().describe("The log ID from the timeline record"),
    },
    async ({ buildId, logId }) => {
      const fullLog = await client.getBuildLog(buildId, logId);
      const lines = fullLog.split("\n");
      const tailLines = lines.slice(-200);
      const totalLines = lines.length;

      return {
        content: [
          {
            type: "text",
            text: `Build ${buildId}, Log ${logId} (last 200 of ${totalLines} lines):\n\n${tailLines.join("\n")}`,
          },
        ],
      };
    }
  );
}
