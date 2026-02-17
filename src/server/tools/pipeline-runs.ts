import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerPipelineRunTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "list_pipeline_runs",
    "List pipeline runs (builds) with optional filters. Use result='failed' to find failing builds.",
    {
      pipelineId: z.number().optional().describe("Filter by pipeline definition ID"),
      branchName: z.string().optional().describe("Filter by branch name (e.g. 'refs/heads/master')"),
      result: z
        .enum(["succeeded", "partiallySucceeded", "failed", "canceled", "none"])
        .optional()
        .describe("Filter by build result"),
      status: z
        .enum(["none", "inProgress", "completed", "cancelling", "postponed", "notStarted", "all"])
        .optional()
        .describe("Filter by build status"),
      top: z.number().optional().describe("Maximum number of runs to return (default: 10)"),
    },
    async ({ pipelineId, branchName, result, status, top }) => {
      const builds = await client.listBuilds({
        definitions: pipelineId,
        branchName,
        resultFilter: result,
        statusFilter: status,
        top: top ?? 10,
      });

      const summary = builds.map((b) => ({
        id: b.id,
        buildNumber: b.buildNumber,
        status: b.status,
        result: b.result,
        pipeline: b.definition.name,
        sourceBranch: b.sourceBranch,
        startTime: b.startTime,
        finishTime: b.finishTime,
        requestedBy: b.requestedFor?.displayName ?? b.requestedBy?.displayName,
        reason: b.reason,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  server.tool(
    "get_pipeline_run",
    "Get detailed information about a specific build/pipeline run by its build ID.",
    {
      buildId: z.number().describe("The build ID"),
    },
    async ({ buildId }) => {
      const build = await client.getBuild(buildId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: build.id,
                buildNumber: build.buildNumber,
                status: build.status,
                result: build.result,
                pipeline: build.definition.name,
                pipelineId: build.definition.id,
                sourceBranch: build.sourceBranch,
                sourceVersion: build.sourceVersion,
                queueTime: build.queueTime,
                startTime: build.startTime,
                finishTime: build.finishTime,
                requestedFor: build.requestedFor?.displayName,
                requestedBy: build.requestedBy?.displayName,
                reason: build.reason,
                parameters: build.parameters ? JSON.parse(build.parameters) : undefined,
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
