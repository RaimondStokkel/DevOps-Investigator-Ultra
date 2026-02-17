import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerRepositoryTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "list_repositories",
    "List all Git repositories in the Azure DevOps project.",
    {},
    async () => {
      const repos = await client.listRepositories();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              repos.map((r) => ({
                id: r.id,
                name: r.name,
                defaultBranch: r.defaultBranch,
                size: r.size,
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
    "get_file_content_remote",
    "Get the content of a file from an Azure DevOps Git repository. Useful to compare remote version with local C:\\Repo\\ or when local repo is out of date.",
    {
      repositoryId: z.string().describe("Repository ID or name"),
      path: z.string().describe("File path within the repository (e.g. '/extensions/MyApp/src/MyFile.al')"),
      branch: z.string().optional().describe("Branch name (default: repository default branch)"),
    },
    async ({ repositoryId, path, branch }) => {
      const content = await client.getFileContent(repositoryId, path, branch);
      return {
        content: [
          {
            type: "text",
            text: `File: ${path} (repo: ${repositoryId}${branch ? `, branch: ${branch}` : ""}):\n\n${content}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_repository_tree",
    "Browse the directory structure of an Azure DevOps Git repository. Returns files and folders at the specified path.",
    {
      repositoryId: z.string().describe("Repository ID or name"),
      path: z.string().optional().describe("Directory path to browse (default: root)"),
      branch: z.string().optional().describe("Branch name (default: repository default branch)"),
    },
    async ({ repositoryId, path, branch }) => {
      const tree = await client.getRepositoryTree(repositoryId, path, branch);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              tree.value.map((item) => ({
                path: item.relativePath,
                type: item.gitObjectType,
                size: item.size,
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
