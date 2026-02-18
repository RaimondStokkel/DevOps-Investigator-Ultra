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
const DEFAULT_SEARCH_CHUNK_SIZE = 2_000;
const MAX_SEARCH_CHUNK_SIZE = 10_000;
const MIN_SEARCH_CHUNK_SIZE = 200;
const DEFAULT_MAX_SEARCH_MATCHES = 25;
const MAX_SEARCH_MATCHES = 200;
const DEFAULT_MAX_SCANNED_LINES = 120_000;
const MAX_MAX_SCANNED_LINES = 1_000_000;
const DEFAULT_CONTEXT_LINES = 4;
const MAX_CONTEXT_LINES = 20;

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

function normalizePositiveInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function createSearchRegex(searchText?: string, useRegex?: boolean): RegExp {
  if (!searchText || !searchText.trim()) {
    return ERROR_LINE_REGEX;
  }

  if (!useRegex) {
    const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }

  try {
    return new RegExp(searchText, "i");
  } catch {
    const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }
}

async function scanBuildLogMatches(
  client: AzureDevOpsClient,
  params: {
    buildId: number;
    logId: number;
    searchRegex: RegExp;
    chunkSize: number;
    maxMatches: number;
    maxScannedLines: number;
  }
): Promise<{
  matches: Array<{ lineNumber: number; text: string }>;
  linesScanned: number;
  chunksScanned: number;
  reachedEndOfLog: boolean;
  maxScanLimitHit: boolean;
  maxMatchesHit: boolean;
}> {
  const { buildId, logId, searchRegex, chunkSize, maxMatches, maxScannedLines } = params;
  const matches: Array<{ lineNumber: number; text: string }> = [];
  let nextStartLine = 1;
  let linesScanned = 0;
  let chunksScanned = 0;
  let reachedEndOfLog = false;

  while (linesScanned < maxScannedLines && matches.length < maxMatches) {
    const remaining = maxScannedLines - linesScanned;
    const linesToFetch = Math.min(chunkSize, remaining);
    const chunkRaw = await client.getBuildLog(
      buildId,
      logId,
      nextStartLine,
      nextStartLine + linesToFetch - 1
    );
    chunksScanned += 1;

    const normalizedChunk = normalizeLogText(chunkRaw).normalizedText;
    const chunkLines = normalizedChunk ? normalizedChunk.split("\n") : [];

    if (chunkLines.length === 0) {
      reachedEndOfLog = true;
      break;
    }

    for (let idx = 0; idx < chunkLines.length; idx++) {
      const line = sanitizeLine(chunkLines[idx]);
      if (!line.trim()) continue;
      if (searchRegex.test(line)) {
        if (!WARNING_ONLY_REGEX.test(line) || /error/i.test(line) || searchRegex !== ERROR_LINE_REGEX) {
          matches.push({
            lineNumber: nextStartLine + idx,
            text: shortenLine(line),
          });
          if (matches.length >= maxMatches) break;
        }
      }
    }

    linesScanned += chunkLines.length;
    nextStartLine += chunkLines.length;

    if (chunkLines.length < linesToFetch) {
      reachedEndOfLog = true;
      break;
    }
  }

  return {
    matches,
    linesScanned,
    chunksScanned,
    reachedEndOfLog,
    maxScanLimitHit: linesScanned >= maxScannedLines,
    maxMatchesHit: matches.length >= maxMatches,
  };
}

async function loadMatchContexts(
  client: AzureDevOpsClient,
  params: {
    buildId: number;
    logId: number;
    matches: Array<{ lineNumber: number; text: string }>;
    contextLines: number;
    maxContexts: number;
  }
): Promise<Array<{ startLine: number; endLine: number; excerpt: string }>> {
  const { buildId, logId, matches, contextLines, maxContexts } = params;
  const contexts: Array<{ startLine: number; endLine: number; excerpt: string }> = [];

  for (const match of matches.slice(0, maxContexts)) {
    const startLine = Math.max(1, match.lineNumber - contextLines);
    const endLine = Math.max(startLine, match.lineNumber + contextLines * 2);
    const rawContext = await client.getBuildLog(buildId, logId, startLine, endLine);
    const normalizedContext = normalizeLogText(rawContext).normalizedText;
    const excerptRaw = normalizedContext
      .split("\n")
      .map((line) => shortenLine(line))
      .join("\n");

    contexts.push({
      startLine,
      endLine,
      excerpt: boundText(excerptRaw, MAX_CONTEXT_CHARS, "match context"),
    });
  }

  return contexts;
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
    "search_build_log_errors",
    "Search a build log for error messages without loading the full log at once. Scans the log in line-range chunks and returns matching lines with focused context.",
    {
      buildId: z.number().describe("The build ID"),
      logId: z.number().describe("The log ID from the timeline record"),
      searchText: z.string().optional().describe("Optional search text. Omit to use default error pattern matching."),
      useRegex: z.boolean().optional().describe("When true, interpret searchText as a regular expression."),
      chunkSize: z.number().optional().describe("How many lines to fetch per request (default: 2000, max: 10000)."),
      maxMatches: z.number().optional().describe("Maximum matching lines to return (default: 25, max: 200)."),
      maxScannedLines: z.number().optional().describe("Maximum total lines to scan before stopping (default: 120000, max: 1000000)."),
      contextLines: z.number().optional().describe("Context lines around each match for excerpts (default: 4, max: 20)."),
    },
    async ({
      buildId,
      logId,
      searchText,
      useRegex,
      chunkSize,
      maxMatches,
      maxScannedLines,
      contextLines,
    }) => {
      const safeChunkSize = normalizePositiveInt(
        chunkSize,
        DEFAULT_SEARCH_CHUNK_SIZE,
        MIN_SEARCH_CHUNK_SIZE,
        MAX_SEARCH_CHUNK_SIZE
      );
      const safeMaxMatches = normalizePositiveInt(
        maxMatches,
        DEFAULT_MAX_SEARCH_MATCHES,
        1,
        MAX_SEARCH_MATCHES
      );
      const safeMaxScannedLines = normalizePositiveInt(
        maxScannedLines,
        DEFAULT_MAX_SCANNED_LINES,
        safeChunkSize,
        MAX_MAX_SCANNED_LINES
      );
      const safeContextLines = normalizePositiveInt(
        contextLines,
        DEFAULT_CONTEXT_LINES,
        1,
        MAX_CONTEXT_LINES
      );

      const searchRegex = createSearchRegex(searchText, useRegex);
      const scanResult = await scanBuildLogMatches(client, {
        buildId,
        logId,
        searchRegex,
        chunkSize: safeChunkSize,
        maxMatches: safeMaxMatches,
        maxScannedLines: safeMaxScannedLines,
      });

      const contexts = await loadMatchContexts(client, {
        buildId,
        logId,
        matches: scanResult.matches,
        contextLines: safeContextLines,
        maxContexts: MAX_CONTEXT_BLOCKS,
      });

      const payload = {
        buildId,
        logId,
        search: {
          mode: searchText?.trim() ? (useRegex ? "regex" : "text") : "default-error-pattern",
          searchText: searchText?.trim() || null,
          regex: searchRegex.source,
        },
        scan: {
          chunkSize: safeChunkSize,
          maxMatches: safeMaxMatches,
          maxScannedLines: safeMaxScannedLines,
          linesScanned: scanResult.linesScanned,
          chunksScanned: scanResult.chunksScanned,
          reachedEndOfLog: scanResult.reachedEndOfLog,
          maxScanLimitHit: scanResult.maxScanLimitHit,
          maxMatchesHit: scanResult.maxMatchesHit,
        },
        matchCount: scanResult.matches.length,
        matches: scanResult.matches,
        contexts,
        nextStep:
          scanResult.matches.length > 0
            ? "Use get_build_log with startLine/endLine around the first match to inspect full untruncated details."
            : "No matches found in scanned range. Increase maxScannedLines or use a broader searchText.",
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
