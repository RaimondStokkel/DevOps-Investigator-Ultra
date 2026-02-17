import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerWorkItemTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "get_work_item",
    "Get details of a specific work item by its ID, including all fields.",
    {
      workItemId: z.number().describe("The work item ID"),
    },
    async ({ workItemId }) => {
      const wi = await client.getWorkItem(workItemId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: wi.id,
                type: wi.fields["System.WorkItemType"],
                title: wi.fields["System.Title"],
                state: wi.fields["System.State"],
                assignedTo: (wi.fields["System.AssignedTo"] as { displayName?: string })?.displayName,
                description: wi.fields["System.Description"],
                areaPath: wi.fields["System.AreaPath"],
                iterationPath: wi.fields["System.IterationPath"],
                tags: wi.fields["System.Tags"],
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "search_work_items",
    "Search for work items by text query. Useful for finding related bugs, tasks, or user stories.",
    {
      searchText: z.string().describe("Search text"),
      top: z.number().optional().describe("Maximum results to return (default: 10)"),
    },
    async ({ searchText, top }) => {
      const results = await client.searchWorkItems(searchText, top);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: results.count,
                results: results.results.map((r) => ({
                  project: r.project.name,
                  fields: r.fields,
                  highlights: r.hits.map((h) => ({
                    field: h.fieldReferenceName,
                    matches: h.highlights,
                  })),
                })),
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
