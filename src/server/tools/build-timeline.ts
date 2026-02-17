import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerBuildTimelineTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "get_build_timeline",
    "Get the execution timeline of a build showing all stages, jobs, and tasks with their status, result, duration, and log IDs. This is the key tool for understanding which step failed and getting the log ID needed to read the actual error.",
    {
      buildId: z.number().describe("The build ID"),
    },
    async ({ buildId }) => {
      const timeline = await client.getBuildTimeline(buildId);

      // Build a structured hierarchy
      const records = timeline.records
        .filter((r) => r.type === "Stage" || r.type === "Job" || r.type === "Task")
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((r) => ({
          id: r.id,
          parentId: r.parentId,
          type: r.type,
          name: r.name,
          state: r.state,
          result: r.result,
          startTime: r.startTime,
          finishTime: r.finishTime,
          logId: r.log?.id,
          errorCount: r.errorCount,
          warningCount: r.warningCount,
          issues: r.issues?.map((i) => ({
            type: i.type,
            message: i.message,
          })),
          workerName: r.workerName,
        }));

      // Find failed records for quick summary
      const failed = records.filter((r) => r.result === "failed");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                buildId,
                totalRecords: records.length,
                failedRecords: failed.length,
                failedSteps: failed.map((f) => ({
                  type: f.type,
                  name: f.name,
                  logId: f.logId,
                  errorCount: f.errorCount,
                  issues: f.issues,
                })),
                allRecords: records,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
