import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadServerConfig } from "./config.js";
import { AzureDevOpsClient } from "./azure-devops-client.js";
import { registerPipelineTools } from "./tools/pipelines.js";
import { registerPipelineRunTools } from "./tools/pipeline-runs.js";
import { registerBuildTimelineTools } from "./tools/build-timeline.js";
import { registerBuildLogTools } from "./tools/build-logs.js";
import { registerBuildArtifactTools } from "./tools/build-artifacts.js";
import { registerRepositoryTools } from "./tools/repositories.js";
import { registerBuildAnalysisTools } from "./tools/build-analysis.js";
import { registerWorkItemTools } from "./tools/work-items.js";
import { registerTestRunTools } from "./tools/test-runs.js";

async function main() {
  const config = loadServerConfig();
  const client = new AzureDevOpsClient(config);

  const server = new McpServer({
    name: "devops-build-investigator",
    version: "1.0.0",
  });

  // Register all tool groups
  registerPipelineTools(server, client);
  registerPipelineRunTools(server, client);
  registerBuildTimelineTools(server, client);
  registerBuildLogTools(server, client);
  registerBuildArtifactTools(server, client);
  registerRepositoryTools(server, client);
  registerBuildAnalysisTools(server, client);
  registerWorkItemTools(server, client);
  registerTestRunTools(server, client);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
