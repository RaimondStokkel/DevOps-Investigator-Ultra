import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";
import type { ErrorCategory, BuildErrorClassification, TimelineRecord } from "../types/azure-devops.js";

const CLASSIFY_CHUNK_SIZE = 2_000;
const CLASSIFY_MAX_SCANNED_LINES = 120_000;

// Error pattern definitions for the DynamicsEmpire build system
const ERROR_PATTERNS: Array<{
  category: ErrorCategory;
  patterns: RegExp[];
  extractFile?: (match: RegExpMatchArray, logText: string) => { file?: string; line?: number; code?: string };
}> = [
  {
    category: "al_compilation_error",
    patterns: [
      /error (AL\d{4}):/i,
      /error (BC\d+):/i,
      /The type '.*' does not contain a definition for/i,
      /The name '.*' does not exist in the current context/i,
      /Cannot implicitly convert type/i,
      /Member already defines a member called/i,
      /The target '.*' for the event subscription/i,
      /Table '.*' does not contain a field named/i,
      /Page '.*' does not contain a field named/i,
    ],
    extractFile: (match, logText) => {
      // AL compiler errors typically look like: "path/file.al(line,col): error ALXXXX: message"
      const fileMatch = logText.match(/([^\s"]+\.al)\((\d+),\d+\):\s*error\s+(AL\d{4}|BC\d+):/i);
      return {
        file: fileMatch?.[1],
        line: fileMatch?.[2] ? parseInt(fileMatch[2]) : undefined,
        code: fileMatch?.[3] ?? match[1],
      };
    },
  },
  {
    category: "test_failure",
    patterns: [
      /Test codeunit .* failed/i,
      /FAILED\s*:/i,
      /\[FAILED\]/i,
      /TestRunner.*OnAfterTestRun.*Success='false'/i,
      /Test Function.*Result.*Failure/i,
    ],
  },
  {
    category: "container_error",
    patterns: [
      /Failed to create container/i,
      /Docker error/i,
      /BcContainerHelper.*error/i,
      /Restore-NavContainerDatabases.*failed/i,
      /Container .* exited with error/i,
      /Unable to start container/i,
      /New-BcContainer.*failed/i,
    ],
  },
  {
    category: "powershell_script_error",
    patterns: [
      /Exception calling/i,
      /FullyQualifiedErrorId/i,
      /cdsa\.build\.al.*error/i,
      /cdsa\.devops.*error/i,
      /The term '.*' is not recognized as the name of a cmdlet/i,
      /Import-Module.*failed/i,
      /ScriptHalted/i,
    ],
  },
  {
    category: "dependency_error",
    patterns: [
      /The dependency '.*' could not be found/i,
      /Could not find app .* as dependency/i,
      /Missing dependency/i,
      /Unable to resolve dependency/i,
    ],
  },
  {
    category: "timeout",
    patterns: [
      /The job running on agent .* has exceeded the maximum execution time/i,
      /exceeded the time limit/i,
      /timed out/i,
      /TimeoutException/i,
    ],
  },
  {
    category: "infrastructure_error",
    patterns: [
      /Agent .* is not running/i,
      /No agent found/i,
      /TF\d+:/,
      /VSTS\.Agent.*error/i,
      /Azure subscription .* not found/i,
      /Access denied/i,
      /401 Unauthorized/i,
      /403 Forbidden/i,
    ],
  },
];

function classifyLogText(logText: string): BuildErrorClassification {
  for (const pattern of ERROR_PATTERNS) {
    for (const regex of pattern.patterns) {
      const match = regex.exec(logText);
      if (match) {
        const details = pattern.extractFile?.(match, logText);

        // Extract a meaningful error message (the line containing the match + surrounding context)
        const lines = logText.split("\n");
        const matchLineIdx = lines.findIndex((l) => regex.test(l));
        const contextStart = Math.max(0, matchLineIdx - 2);
        const contextEnd = Math.min(lines.length, matchLineIdx + 5);
        const errorContext = lines.slice(contextStart, contextEnd).join("\n");

        return {
          category: pattern.category,
          failingStep: "",
          errorMessage: match[0],
          affectedFile: details?.file,
          lineNumber: details?.line,
          errorCode: details?.code,
          logExcerpt: errorContext,
        };
      }
    }
  }

  // No pattern matched - extract the last error-like lines
  const lines = logText.split("\n");
  const errorLines = lines.filter(
    (l) => /error|exception|fail|##\[error\]/i.test(l) && !/warning/i.test(l)
  );
  const excerpt = errorLines.length > 0 ? errorLines.slice(-10).join("\n") : lines.slice(-20).join("\n");

  return {
    category: "unknown",
    failingStep: "",
    errorMessage: errorLines[errorLines.length - 1] ?? "Unknown error",
    logExcerpt: excerpt,
  };
}

function normalizeLogChunk(rawLog: string): string {
  const trimmed = rawLog.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { value?: unknown };
      if (Array.isArray(parsed.value) && parsed.value.every((item) => typeof item === "string")) {
        return (parsed.value as string[]).join("\n");
      }
    } catch {
      // Fall back to plain text when parsing fails
    }
  }
  return rawLog;
}

function hasErrorSignal(logText: string): boolean {
  return logText
    .split("\n")
    .some((line) => /error|exception|fail|##\[error\]/i.test(line) && !/warning/i.test(line));
}

async function classifyFailedTaskLog(
  client: AzureDevOpsClient,
  buildId: number,
  logId: number
): Promise<BuildErrorClassification> {
  let nextStartLine = 1;
  let scannedLines = 0;
  let firstUnknownWithSignal: BuildErrorClassification | null = null;

  while (scannedLines < CLASSIFY_MAX_SCANNED_LINES) {
    const remaining = CLASSIFY_MAX_SCANNED_LINES - scannedLines;
    const linesToFetch = Math.min(CLASSIFY_CHUNK_SIZE, remaining);
    const rawChunk = await client.getBuildLog(
      buildId,
      logId,
      nextStartLine,
      nextStartLine + linesToFetch - 1
    );
    const normalizedChunk = normalizeLogChunk(rawChunk);
    if (!normalizedChunk.trim()) break;

    const chunkLines = normalizedChunk.split("\n");
    const scannedThisChunk = chunkLines.length;
    if (scannedThisChunk === 0) break;

    const classification = classifyLogText(normalizedChunk);
    if (classification.category !== "unknown") {
      return classification;
    }

    if (!firstUnknownWithSignal && hasErrorSignal(normalizedChunk)) {
      firstUnknownWithSignal = classification;
    }

    scannedLines += scannedThisChunk;
    nextStartLine += scannedThisChunk;

    if (scannedThisChunk < linesToFetch) break;
  }

  if (firstUnknownWithSignal) {
    return firstUnknownWithSignal;
  }

  return {
    category: "unknown",
    failingStep: "",
    errorMessage: "Unknown error",
    logExcerpt: "No error-like lines found in scanned build log range.",
  };
}

function findFirstFailedTask(records: TimelineRecord[]): TimelineRecord | undefined {
  // Find tasks that failed, ordered by start time
  return records
    .filter((r) => r.type === "Task" && r.result === "failed")
    .sort((a, b) => {
      const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
      const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
      return aTime - bTime;
    })[0];
}

export function registerBuildAnalysisTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "classify_build_error",
    "Automatically classify a build failure by analyzing the timeline and logs. Uses chunked log scanning for large logs and returns the error category (al_compilation_error, test_failure, container_error, etc.), the failing step, error message, and optionally the affected file and line number.",
    {
      buildId: z.number().describe("The build ID to analyze"),
    },
    async ({ buildId }) => {
      // 1. Get the timeline
      const timeline = await client.getBuildTimeline(buildId);

      // 2. Find the first failed task
      const failedTask = findFirstFailedTask(timeline.records);
      if (!failedTask) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  category: "unknown",
                  failingStep: "none",
                  errorMessage: "No failed tasks found in the timeline",
                  logExcerpt: "",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // 3. Read and classify the failed task log using chunked scanning
      const classification = failedTask.log?.id
        ? await classifyFailedTaskLog(client, buildId, failedTask.log.id)
        : {
            category: "unknown" as const,
            failingStep: "",
            errorMessage: "No build log is associated with the failed task",
            logExcerpt: "",
          };

      // 4. Attach failing step metadata
      classification.failingStep = failedTask.name;

      // Also include any inline issues from the timeline record
      if (failedTask.issues && failedTask.issues.length > 0) {
        const issueMessages = failedTask.issues
          .filter((i) => i.type === "error")
          .map((i) => i.message);
        if (issueMessages.length > 0 && classification.category === "unknown") {
          classification.errorMessage = issueMessages[0];
          classification.logExcerpt = issueMessages.join("\n");
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(classification, null, 2) }],
      };
    }
  );

  server.tool(
    "get_recent_failures",
    "Get recent failed builds with a quick classification for each. Useful for triage and finding patterns across multiple failures.",
    {
      pipelineId: z.number().optional().describe("Filter by pipeline definition ID"),
      top: z.number().optional().describe("Number of recent failures to return (default: 5)"),
    },
    async ({ pipelineId, top }) => {
      const builds = await client.listBuilds({
        definitions: pipelineId,
        resultFilter: "failed",
        top: top ?? 5,
      });

      const results = [];
      for (const build of builds) {
        // Quick classification: get timeline, find failed task
        let failingStep = "unknown";
        let category: ErrorCategory = "unknown";
        try {
          const timeline = await client.getBuildTimeline(build.id);
          const failedTask = findFirstFailedTask(timeline.records);
          if (failedTask) {
            failingStep = failedTask.name;
            // Quick categorize based on step name
            if (/compile/i.test(failedTask.name)) category = "al_compilation_error";
            else if (/test|unittest/i.test(failedTask.name)) category = "test_failure";
            else if (/container|prepare/i.test(failedTask.name)) category = "container_error";
          }
        } catch {
          // Skip classification errors
        }

        results.push({
          buildId: build.id,
          buildNumber: build.buildNumber,
          pipeline: build.definition.name,
          branch: build.sourceBranch,
          finishTime: build.finishTime,
          failingStep,
          quickCategory: category,
          requestedBy: build.requestedFor?.displayName,
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );
}
