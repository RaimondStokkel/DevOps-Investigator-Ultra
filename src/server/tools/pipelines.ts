import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerPipelineTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "list_pipelines",
    "List pipeline definitions in the Azure DevOps project. Optionally filter by name.",
    {
      nameFilter: z.string().optional().describe("Filter pipelines by name (case-insensitive contains match)"),
      top: z.number().optional().describe("Maximum number of pipelines to return"),
    },
    async ({ nameFilter, top }) => {
      const pipelines = await client.listPipelines(nameFilter, top);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              pipelines.map((p) => ({
                id: p.id,
                name: p.name,
                folder: p.folder,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_pipeline",
    "Get details of a specific pipeline definition by ID.",
    {
      pipelineId: z.number().describe("The pipeline definition ID"),
    },
    async ({ pipelineId }) => {
      const pipeline = await client.getPipeline(pipelineId);
      return {
        content: [{ type: "text", text: JSON.stringify(pipeline, null, 2) }],
      };
    }
  );
}
