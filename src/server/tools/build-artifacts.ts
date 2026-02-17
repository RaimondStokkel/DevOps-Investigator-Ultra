import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerBuildArtifactTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "list_build_artifacts",
    "List all artifacts published by a build (e.g. Apps, Assemblies, TestResults, deploymentpackage).",
    {
      buildId: z.number().describe("The build ID"),
    },
    async ({ buildId }) => {
      const artifacts = await client.listBuildArtifacts(buildId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              artifacts.map((a) => ({
                id: a.id,
                name: a.name,
                type: a.resource.type,
                downloadUrl: a.resource.downloadUrl,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
