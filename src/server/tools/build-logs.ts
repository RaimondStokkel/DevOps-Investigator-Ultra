import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../azure-devops-client.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ERROR_LINE_REGEX = /(##\[error\])|(^|\s)error(\s|:)|exception|(^|\s)failed(\s|:)|fatal/i;
const WARNING_ONLY_REGEX = /(^|\s)warning(\s|:)/i;
const MAX_PREVIEW_ERRORS = 8;
const MAX_CONTEXT_BLOCKS = 4;
const MAX_LINE_CHARS = 220;
const MAX_CONTEXT_CHARS = 1_000;
const MAX_SELECTED_TEXT_CHARS = 3_000;
const MAX_TAIL_LINES = 40;

interface NormalizedLogResult {
  normalizedText: string;
  sourceFormat: "plain" | "ado-json-lines";
}

function sanitizeLine(line: string): string {
  return line.replace(/\r$/, "");
}

function shortenLine(line: string, maxChars = MAX_LINE_CHARS): string {
  const clean = sanitizeLine(line);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)} ... [line truncated]`;
}

function normalizeLogText(rawLog: string): NormalizedLogResult {
  const trimmed = rawLog.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { value?: unknown };
      if (Array.isArray(parsed.value) && parsed.value.every((item) => typeof item === "string")) {
        return {
          normalizedText: (parsed.value as string[]).join("\n"),
          sourceFormat: "ado-json-lines",
        };
      }
    } catch {
      // Fall back to plain text when parsing fails
    }
  }

  return {
    normalizedText: rawLog,
    sourceFormat: "plain",
  };
}

function isErrorLine(line: string): boolean {
  if (!ERROR_LINE_REGEX.test(line)) return false;
  if (WARNING_ONLY_REGEX.test(line) && !/error/i.test(line)) return false;
  return true;
}

function extractErrors(lines: string[]): Array<{ lineNumber: number; text: string }> {
  const errors: Array<{ lineNumber: number; text: string }> = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = sanitizeLine(lines[idx]);
    if (!line.trim()) continue;
    if (isErrorLine(line)) {
      errors.push({ lineNumber: idx + 1, text: shortenLine(line) });
    }
  }
  return errors;
}

function buildErrorContexts(
  lines: string[],
  errors: Array<{ lineNumber: number; text: string }>
): Array<{ startLine: number; endLine: number; excerpt: string }> {
  const contexts: Array<{ startLine: number; endLine: number; excerpt: string }> = [];

  for (const error of errors.slice(0, MAX_CONTEXT_BLOCKS)) {
    const start = Math.max(1, error.lineNumber - 5);
    const end = Math.min(lines.length, error.lineNumber + 12);
    const excerptRaw = lines
      .slice(start - 1, end)
      .map((line) => shortenLine(line))
      .join("\n");
    const excerpt = boundText(excerptRaw, MAX_CONTEXT_CHARS, "context excerpt");
    contexts.push({
      startLine: start,
      endLine: end,
      excerpt,
    });
  }

  return contexts;
}

function boundText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = maxChars - headLen;
  return `${text.slice(0, headLen)}\n\n... [${label} truncated from ${text.length} to ${maxChars} chars] ...\n\n${text.slice(-tailLen)}`;
}

async function saveLogArtifacts(
  buildId: number,
  logId: number,
  rawLog: string,
  normalizedLog: string,
  errors: Array<{ lineNumber: number; text: string }>
): Promise<{ rawPath: string; normalizedPath: string; errorPath: string }> {
  const outputRoot = resolve(
    process.env.BUILD_LOG_ARTIFACTS_PATH ?? resolve(process.cwd(), "artifacts", "build-logs")
  );
  await mkdir(outputRoot, { recursive: true });

  const baseName = `build-${buildId}-log-${logId}`;
  const rawPath = resolve(outputRoot, `${baseName}.log`);
  const normalizedPath = resolve(outputRoot, `${baseName}.normalized.log`);
  const errorPath = resolve(outputRoot, `${baseName}.errors.log`);

  const errorFileContent = errors
    .map((error) => `[line ${error.lineNumber}] ${error.text}`)
    .join("\n");

  await writeFile(rawPath, rawLog, "utf-8");
  await writeFile(normalizedPath, normalizedLog, "utf-8");
  await writeFile(errorPath, errorFileContent + (errorFileContent ? "\n" : ""), "utf-8");

  return { rawPath, normalizedPath, errorPath };
}

export function registerBuildLogTools(server: McpServer, client: AzureDevOpsClient): void {
  server.tool(
    "get_build_log",
    "Get build log details for a specific task. Always saves the complete raw log to a local file first, extracts all error lines to a companion file, and then returns focused context or a requested line range.",
    {
      buildId: z.number().describe("The build ID"),
      logId: z.number().describe("The log ID from the timeline record"),
      startLine: z.number().optional().describe("Start line (1-based). Omit to start from beginning."),
      endLine: z.number().optional().describe("End line (1-based). Omit to read to end."),
    },
    async ({ buildId, logId, startLine, endLine }) => {
      const rawLog = await client.getBuildLog(buildId, logId);
      const normalized = normalizeLogText(rawLog);
      const lines = normalized.normalizedText.split("\n");
      const errors = extractErrors(lines);
      const contexts = buildErrorContexts(lines, errors);
      const { rawPath, normalizedPath, errorPath } = await saveLogArtifacts(
        buildId,
        logId,
        rawLog,
        normalized.normalizedText,
        errors
      );

      const safeStart = startLine && startLine > 0 ? Math.floor(startLine) : 1;
      const safeEnd = endLine && endLine > 0 ? Math.floor(endLine) : lines.length;
      const boundedStart = Math.min(safeStart, lines.length || 1);
      const boundedEnd = Math.max(boundedStart, Math.min(safeEnd, lines.length || boundedStart));

      let selectedText = "";
      if (lines.length > 0) {
        selectedText = lines
          .slice(boundedStart - 1, boundedEnd)
          .map((line) => shortenLine(line))
          .join("\n");
      }
      selectedText = boundText(selectedText, MAX_SELECTED_TEXT_CHARS, "selected log range");

      const payload = {
        buildId,
        logId,
        sourceFormat: normalized.sourceFormat,
        rawLogSavedTo: rawPath,
        normalizedLogSavedTo: normalizedPath,
        extractedErrorsSavedTo: errorPath,
        totalLines: lines.length,
        totalChars: normalized.normalizedText.length,
        rawChars: rawLog.length,
        errorCount: errors.length,
        errorPreview: errors.slice(0, MAX_PREVIEW_ERRORS),
        errorPreviewTruncated: errors.length > MAX_PREVIEW_ERRORS,
        errorContexts: contexts,
        selectedRange: {
          startLine: boundedStart,
          endLine: boundedEnd,
        },
        selectedText,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_build_log_summary",
    "Get a summary for a build log. Always saves the complete raw log and all extracted errors to files first, then returns error preview + last 200 lines.",
    {
      buildId: z.number().describe("The build ID"),
      logId: z.number().describe("The log ID from the timeline record"),
    },
    async ({ buildId, logId }) => {
      const rawLog = await client.getBuildLog(buildId, logId);
      const normalized = normalizeLogText(rawLog);
      const lines = normalized.normalizedText.split("\n");
      const tailLines = lines.slice(-MAX_TAIL_LINES);
      const totalLines = lines.length;
      const errors = extractErrors(lines);
      const { rawPath, normalizedPath, errorPath } = await saveLogArtifacts(
        buildId,
        logId,
        rawLog,
        normalized.normalizedText,
        errors
      );

      const payload = {
        buildId,
        logId,
        sourceFormat: normalized.sourceFormat,
        rawLogSavedTo: rawPath,
        normalizedLogSavedTo: normalizedPath,
        extractedErrorsSavedTo: errorPath,
        totalLines,
        totalChars: normalized.normalizedText.length,
        rawChars: rawLog.length,
        errorCount: errors.length,
        errorPreview: errors.slice(0, MAX_PREVIEW_ERRORS),
        errorPreviewTruncated: errors.length > MAX_PREVIEW_ERRORS,
        tailRange: {
          startLine: Math.max(1, totalLines - MAX_TAIL_LINES + 1),
          endLine: totalLines,
          previewLineCount: tailLines.length,
        },
        nextStep: "Use get_build_log with startLine/endLine from tailRange or errorPreview line numbers to inspect focused sections.",
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );
}
