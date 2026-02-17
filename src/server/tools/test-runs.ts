import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";

export function registerTestRunTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "list_test_runs",
    "List test runs. Use buildId to get test runs associated with a specific build.",
    {
      buildId: z.number().optional().describe("Optional build ID to filter test runs for one build"),
      top: z.number().optional().describe("Maximum number of runs to return (default: 20)"),
    },
    async ({ buildId, top }) => {
      const runs = await client.listTestRuns({
        buildId,
        top: top ?? 20,
      });

      const summary = runs.map((r) => ({
        id: r.id,
        name: r.name,
        state: r.state,
        outcome: r.outcome,
        totalTests: r.totalTests,
        passedTests: r.passedTests,
        incompleteTests: r.incompleteTests,
        buildId: r.build?.id,
        startedDate: r.startedDate,
        completedDate: r.completedDate,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  server.tool(
    "get_test_run_results",
    "Get test case results for a test run. Use outcome='failed' to retrieve failing tests with error and stack trace details.",
    {
      runId: z.number().describe("The test run ID"),
      outcome: z
        .enum(["passed", "failed", "notExecuted", "inconclusive", "timeout", "aborted", "blocked"])
        .optional()
        .describe("Optional outcome filter; use 'failed' for root-cause analysis"),
      top: z.number().optional().describe("Maximum number of test results to return (default: 200)"),
    },
    async ({ runId, outcome, top }) => {
      const results = await client.getTestRunResults(runId, {
        outcome,
        top: top ?? 200,
      });

      const summary = results.map((r) => ({
        id: r.id,
        testCaseTitle: r.testCaseTitle,
        automatedTestName: r.automatedTestName,
        automatedTestStorage: r.automatedTestStorage,
        outcome: r.outcome,
        state: r.state,
        durationInMs: r.durationInMs,
        startedDate: r.startedDate,
        completedDate: r.completedDate,
        errorMessage: r.errorMessage,
        stackTrace: r.stackTrace,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                runId,
                count: summary.length,
                outcomeFilter: outcome,
                results: summary,
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
    "get_failed_tests_for_build",
    "Get failed test results for a build in one call. Internally finds test runs for the build and returns failed test cases with error and stack trace details.",
    {
      buildId: z.number().describe("The build ID"),
      topRuns: z.number().optional().describe("Maximum number of test runs to inspect (default: 10)"),
      topResultsPerRun: z.number().optional().describe("Maximum failed test results per run (default: 200)"),
    },
    async ({ buildId, topRuns, topResultsPerRun }) => {
      const runs = await client.listTestRuns({
        buildId,
        top: topRuns ?? 10,
      });

      const failedByRun: Array<{
        runId: number;
        runName?: string;
        runState?: string;
        totalTests?: number;
        passedTests?: number;
        failedCount: number;
        results: Array<{
          id: number;
          testCaseTitle?: string;
          automatedTestName?: string;
          automatedTestStorage?: string;
          outcome?: string;
          state?: string;
          durationInMs?: number;
          startedDate?: string;
          completedDate?: string;
          errorMessage?: string;
          stackTrace?: string;
        }>;
      }> = [];

      for (const run of runs) {
        const failed = await client.getTestRunResults(run.id, {
          outcome: "failed",
          top: topResultsPerRun ?? 200,
        });

        if (failed.length === 0) continue;

        failedByRun.push({
          runId: run.id,
          runName: run.name,
          runState: run.state,
          totalTests: run.totalTests,
          passedTests: run.passedTests,
          failedCount: failed.length,
          results: failed.map((r) => ({
            id: r.id,
            testCaseTitle: r.testCaseTitle,
            automatedTestName: r.automatedTestName,
            automatedTestStorage: r.automatedTestStorage,
            outcome: r.outcome,
            state: r.state,
            durationInMs: r.durationInMs,
            startedDate: r.startedDate,
            completedDate: r.completedDate,
            errorMessage: r.errorMessage,
            stackTrace: r.stackTrace,
          })),
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                buildId,
                runCount: runs.length,
                runsWithFailures: failedByRun.length,
                failedByRun,
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
