import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadAgentConfig, loadServerConfig } from "../server/config.js";
import { AzureDevOpsClient } from "../server/azure-devops-client.js";
import { McpClient } from "../agent/mcp-client.js";
import { LocalTools } from "../agent/local-tools.js";
import { ToolExecutor } from "../agent/tool-executor.js";
import { AzureOpenAIClient } from "../agent/azure-openai-client.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { getSystemPrompt } from "../agent/prompts/system-prompt.js";
import type { ReasoningMode } from "../server/config.js";
import type { OpenAIDiagnosticsEvent } from "../agent/azure-openai-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "public");
const htmlPath = resolve(publicDir, "index.html");

const serverConfig = loadServerConfig();
const adoClient = new AzureDevOpsClient(serverConfig);

let isInvestigating = false;
let activeAbortController: AbortController | null = null;
let lastInvestigationResult = "";

function getEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function getLoopLimits(mode: ReasoningMode) {
  if (mode === "base") {
    return {
      maxContextChars: getEnvInt("AGENT_BASE_MAX_CONTEXT_CHARS") ?? 80_000,
      maxToolResultChars: getEnvInt("AGENT_BASE_MAX_TOOL_RESULT_CHARS") ?? 8_000,
      maxAssistantMessageChars: getEnvInt("AGENT_BASE_MAX_ASSISTANT_CHARS") ?? 12_000,
      maxToolCallArgsChars: getEnvInt("AGENT_BASE_MAX_TOOL_CALL_ARGS_CHARS") ?? 2_500,
    };
  }

  return {
    maxContextChars: getEnvInt("AGENT_EXPERT_MAX_CONTEXT_CHARS"),
    maxToolResultChars: getEnvInt("AGENT_EXPERT_MAX_TOOL_RESULT_CHARS"),
    maxAssistantMessageChars: getEnvInt("AGENT_EXPERT_MAX_ASSISTANT_CHARS"),
    maxToolCallArgsChars: getEnvInt("AGENT_EXPERT_MAX_TOOL_CALL_ARGS_CHARS"),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf-8");
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function getContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function tryServeStatic(urlPath: string, res: ServerResponse): Promise<boolean> {
  if (urlPath === "/" || urlPath.startsWith("/api/")) return false;

  const relativePath = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const fullPath = resolve(publicDir, relativePath);
  const normalizedPublicDir = publicDir.toLowerCase();
  const normalizedFullPath = fullPath.toLowerCase();

  if (!normalizedFullPath.startsWith(normalizedPublicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }

  if (!existsSync(fullPath)) return false;

  const content = await readFile(fullPath);
  res.statusCode = 200;
  res.setHeader("Content-Type", getContentType(fullPath));
  res.end(content);
  return true;
}

function createMcpClient(): McpClient {
  const distServerScript = resolve(__dirname, "..", "server", "index.js");
  const srcServerScript = resolve(__dirname, "..", "server", "index.ts");
  const useDistServer = existsSync(distServerScript);

  return new McpClient(
    useDistServer ? "node" : "npx",
    useDistServer ? [distServerScript] : ["tsx", srcServerScript],
    {
      ADO_PAT: serverConfig.pat,
      ADO_ORG: serverConfig.organization,
      ADO_PROJECT: serverConfig.project,
    }
  );
}

async function runInvestigation(userPrompt: string): Promise<string> {
  return runInvestigationWithEvents(userPrompt);
}

async function runInvestigationWithEvents(
  userPrompt: string,
  onEvent?: (event: unknown) => void,
  abortSignal?: AbortSignal,
  reasoningMode?: ReasoningMode,
  debugMode = false
): Promise<string> {
  const agentConfig = loadAgentConfig();
  const selectedReasoning = reasoningMode ?? agentConfig.defaultReasoningMode;
  const loopLimits = getLoopLimits(selectedReasoning);
  const mcpClient = createMcpClient();
  const abortHandler = () => {
    void mcpClient.disconnect();
  };

  abortSignal?.addEventListener("abort", abortHandler, { once: true });

  try {
    await mcpClient.connect();

    const localTools = new LocalTools(
      agentConfig.repoBasePath,
      agentConfig.repoLookupPaths,
      agentConfig.repoIndexPath
    );
    const toolExecutor = new ToolExecutor(mcpClient, localTools);
    const openaiClient = new AzureOpenAIClient(agentConfig);

    if (debugMode) {
      const allTools = toolExecutor.getAllToolDefinitions();
      openaiClient.setDiagnosticsListener((payload: OpenAIDiagnosticsEvent) => {
        onEvent?.({ type: "debug", payload });
      });

      onEvent?.({
        type: "debug",
        payload: {
          stage: "session_start",
          reasoningMode: selectedReasoning,
          modelDeployment: agentConfig.reasoningProfiles[selectedReasoning].deployment,
          apiVersion: agentConfig.reasoningProfiles[selectedReasoning].apiVersion,
          toolCount: allTools.length,
          tools: allTools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
          })),
        },
      });
    }

    const agentLoop = new AgentLoop(openaiClient, toolExecutor, {
      verbose: false,
      maxTurns: 30,
      onEvent: (event) => onEvent?.(event),
      abortSignal,
      systemPrompt: getSystemPrompt(serverConfig.projectUrl),
      reasoningMode: selectedReasoning,
      ...loopLimits,
    });

    return await agentLoop.run(userPrompt);
  } finally {
    abortSignal?.removeEventListener("abort", abortHandler);
    await mcpClient.disconnect();
  }
}

interface RepoEntry {
  name: string;
  path: string;
  hasGit: boolean;
}

interface RepoIndex {
  basePath: string;
  generatedAt: string;
  lookupPaths: string[];
  repositories: RepoEntry[];
}

async function generateRepoIndex(basePath: string): Promise<RepoIndex> {
  const entries = await readdir(basePath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const repositories: RepoEntry[] = [];

  for (const directoryName of directories) {
    const repoPath = resolve(basePath, directoryName);
    const gitPath = join(repoPath, ".git");

    let hasGit = false;
    try {
      const gitStat = await stat(gitPath);
      hasGit = gitStat.isDirectory() || gitStat.isFile();
    } catch {
      hasGit = false;
    }

    repositories.push({
      name: directoryName,
      path: repoPath,
      hasGit,
    });
  }

  const lookupPaths = repositories
    .filter((repo) => !repo.name.startsWith("."))
    .map((repo) => repo.path);

  return {
    basePath,
    generatedAt: new Date().toISOString(),
    lookupPaths,
    repositories,
  };
}

async function handleGetRepoIndex(res: ServerResponse): Promise<void> {
  try {
    const { repoIndexPath } = loadAgentConfig();
    const content = await readFile(repoIndexPath, "utf-8");
    let basePath: string | undefined;
    try {
      const parsed = JSON.parse(content) as Partial<RepoIndex>;
      if (typeof parsed.basePath === "string") {
        basePath = parsed.basePath;
      }
    } catch {
      // Keep raw content response even if JSON is malformed
    }

    sendJson(res, 200, { path: repoIndexPath, content, basePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  }
}

async function handleSetRepoBasePath(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const payload = (body ?? {}) as { basePath?: string };
  const basePathRaw = payload.basePath?.trim();
  if (!basePathRaw) {
    sendJson(res, 400, { error: "basePath is required." });
    return;
  }

  const normalizedBasePath = resolve(basePathRaw);

  try {
    const { repoIndexPath } = loadAgentConfig();

    let existing: RepoIndex = {
      basePath: normalizedBasePath,
      generatedAt: new Date().toISOString(),
      lookupPaths: [],
      repositories: [],
    };

    if (existsSync(repoIndexPath)) {
      try {
        const content = await readFile(repoIndexPath, "utf-8");
        const parsed = JSON.parse(content) as Partial<RepoIndex>;
        existing = {
          basePath: typeof parsed.basePath === "string" ? parsed.basePath : normalizedBasePath,
          generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date().toISOString(),
          lookupPaths: Array.isArray(parsed.lookupPaths) ? parsed.lookupPaths : [],
          repositories: Array.isArray(parsed.repositories) ? parsed.repositories as RepoEntry[] : [],
        };
      } catch {
        // If current file is invalid, overwrite with a minimal valid structure
      }
    }

    existing.basePath = normalizedBasePath;
    existing.generatedAt = new Date().toISOString();

    await writeFile(repoIndexPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");

    sendJson(res, 200, {
      updated: true,
      basePath: normalizedBasePath,
      path: repoIndexPath,
      message: "Repository location updated. Run Rescan C:\\Repo (or your new path) to refresh lookup paths.",
      envOverride: Boolean(process.env.REPO_BASE_PATH),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  }
}

async function handleSaveRepoIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const payload = (body ?? {}) as { content?: string };
  if (!payload.content || typeof payload.content !== "string") {
    sendJson(res, 400, { error: "content is required." });
    return;
  }

  try {
    JSON.parse(payload.content);
  } catch {
    sendJson(res, 400, { error: "content must be valid JSON." });
    return;
  }

  try {
    const { repoIndexPath } = loadAgentConfig();
    await writeFile(repoIndexPath, payload.content, "utf-8");
    sendJson(res, 200, { saved: true, path: repoIndexPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  }
}

async function handleRescanRepoIndex(res: ServerResponse): Promise<void> {
  try {
    const { repoIndexPath, repoBasePath } = loadAgentConfig();
    const repoIndex = await generateRepoIndex(repoBasePath);
    await writeFile(repoIndexPath, JSON.stringify(repoIndex, null, 2) + "\n", "utf-8");
    sendJson(res, 200, {
      rescanned: true,
      path: repoIndexPath,
      basePath: repoBasePath,
      lookupCount: repoIndex.lookupPaths.length,
      repoCount: repoIndex.repositories.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  }
}

function sendSse(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function setSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}

function buildPrompt(
  mode?: string,
  buildIdRaw?: string,
  queryRaw?: string
): { prompt: string; error?: string } {
  if (mode === "selected") {
    const buildId = Number(buildIdRaw);
    if (!buildId || Number.isNaN(buildId)) {
      return { prompt: "", error: "buildId is required when mode is selected." };
    }

    return {
      prompt: `Investigate build ${buildId}. Find out what went wrong, identify the root cause, find the relevant code in the local repository, and fix it if possible.`,
    };
  }

  if (mode === "query") {
    const query = (queryRaw ?? "").trim();
    if (!query) {
      return { prompt: "", error: "query is required when mode is query." };
    }

    if (lastInvestigationResult.trim()) {
      const maxPrevChars = Number(process.env.GUI_FOLLOWUP_CONTEXT_CHARS ?? 12_000);
      const safeMax = Number.isFinite(maxPrevChars) && maxPrevChars > 0
        ? Math.floor(maxPrevChars)
        : 12_000;
      const prev = lastInvestigationResult;
      const boundedPrev = prev.length > safeMax
        ? `${prev.slice(0, Math.floor(safeMax * 0.6))}\n\n[previous investigation summary truncated from ${prev.length} to ${safeMax} chars]\n\n${prev.slice(-Math.ceil(safeMax * 0.4))}`
        : prev;

      return {
        prompt: `Continue from this previous investigation summary:\n\n${boundedPrev}\n\nFollow-up request: ${query}`,
      };
    }

    return {
      prompt: query,
    };
  }

  return {
    prompt:
      "Find the most recent failing build. Investigate the failure, identify the root cause, find the relevant code in the local repository, and fix it if possible.",
  };
}

async function handleFailures(res: ServerResponse): Promise<void> {
  try {
    const builds = await adoClient.listBuilds({
      resultFilter: "failed",
      top: 25,
    });

    const failures = builds.map((build) => ({
      id: build.id,
      buildNumber: build.buildNumber,
      pipeline: build.definition.name,
      branch: build.sourceBranch,
      finishTime: build.finishTime,
      status: build.status,
      result: build.result,
    }));

    sendJson(res, 200, { failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  }
}

async function handleInvestigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isInvestigating) {
    sendJson(res, 409, { error: "An investigation is already running. Please wait." });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const payload = (body ?? {}) as {
    mode?: "selected" | "latest" | "query";
    buildId?: number;
    query?: string;
    reasoning?: ReasoningMode;
    debug?: boolean;
  };

  const promptResult = buildPrompt(
    payload.mode,
    String(payload.buildId ?? ""),
    payload.query
  );
  if (promptResult.error) {
    sendJson(res, 400, { error: promptResult.error });
    return;
  }

  isInvestigating = true;
  activeAbortController = new AbortController();

  try {
    const result = await runInvestigationWithEvents(
      promptResult.prompt,
      undefined,
      activeAbortController.signal,
      payload.reasoning,
      payload.debug === true
    );
    lastInvestigationResult = result;
    sendJson(res, 200, { result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  } finally {
    isInvestigating = false;
    activeAbortController = null;
  }
}

async function handleInvestigateStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setSseHeaders(res);

  if (isInvestigating) {
    sendSse(res, { type: "error", message: "An investigation is already running. Please wait." });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const mode = url.searchParams.get("mode") ?? "latest";
  const buildId = url.searchParams.get("buildId") ?? "";
  const query = url.searchParams.get("query") ?? "";
  const reasoningRaw = (url.searchParams.get("reasoning") ?? "").toLowerCase();
  const reasoning: ReasoningMode = reasoningRaw === "expert" ? "expert" : "base";
  const debugMode = (url.searchParams.get("debug") ?? "").toLowerCase() === "1";
  const promptResult = buildPrompt(mode, buildId, query);

  if (promptResult.error) {
    sendSse(res, { type: "error", message: promptResult.error });
    res.end();
    return;
  }

  isInvestigating = true;
  activeAbortController = new AbortController();

  try {
    const result = await runInvestigationWithEvents(
      promptResult.prompt,
      (event) => {
      sendSse(res, event);
      },
      activeAbortController.signal,
      reasoning,
      debugMode
    );
    lastInvestigationResult = result;
    sendSse(res, { type: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendSse(res, { type: "error", message });
  } finally {
    isInvestigating = false;
    activeAbortController = null;
    res.end();
  }
}

async function handleDebugTools(res: ServerResponse): Promise<void> {
  const mcpClient = createMcpClient();
  try {
    const agentConfig = loadAgentConfig();
    await mcpClient.connect();
    const adoTools = mcpClient.getTools();

    const localTools = new LocalTools(
      agentConfig.repoBasePath,
      agentConfig.repoLookupPaths,
      agentConfig.repoIndexPath
    );
    const localToolDefs = localTools.getToolDefinitions().map((tool) => tool.function);

    sendJson(res, 200, {
      debug: true,
      adoTools: adoTools.map((tool) => ({
        name: `ado_${tool.name}`,
        description: tool.description,
      })),
      localTools: localToolDefs.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
      totals: {
        ado: adoTools.length,
        local: localToolDefs.length,
        combined: adoTools.length + localToolDefs.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  } finally {
    await mcpClient.disconnect();
  }
}

function handleStopInvestigation(res: ServerResponse): void {
  if (!isInvestigating || !activeAbortController) {
    sendJson(res, 200, { stopped: false, message: "No active investigation." });
    return;
  }

  activeAbortController.abort();
  sendJson(res, 200, { stopped: true });
}

async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method === "GET") {
    const served = await tryServeStatic(url.pathname, res);
    if (served) return;
  }

  if (method === "GET" && url.pathname === "/") {
    const html = await readFile(htmlPath, "utf-8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  if (method === "GET" && url.pathname === "/api/failures") {
    await handleFailures(res);
    return;
  }

  if (method === "GET" && url.pathname === "/api/debug/tools") {
    await handleDebugTools(res);
    return;
  }

  if (method === "GET" && url.pathname === "/api/repo-index") {
    await handleGetRepoIndex(res);
    return;
  }

  if (method === "PUT" && url.pathname === "/api/repo-index") {
    await handleSaveRepoIndex(req, res);
    return;
  }

  if (method === "POST" && url.pathname === "/api/repo-index/rescan") {
    await handleRescanRepoIndex(res);
    return;
  }

  if (method === "POST" && url.pathname === "/api/repo-index/base-path") {
    await handleSetRepoBasePath(req, res);
    return;
  }

  if (method === "POST" && url.pathname === "/api/investigate") {
    await handleInvestigate(req, res);
    return;
  }

  if (method === "GET" && url.pathname === "/api/investigate/stream") {
    await handleInvestigateStream(req, res);
    return;
  }

  if (method === "POST" && url.pathname === "/api/investigate/stop") {
    handleStopInvestigation(res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function main(): Promise<void> {
  const port = Number(process.env.GUI_PORT ?? 4230);

  const server = createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(res, 500, { error: message });
    });
  });

  server.listen(port, () => {
    console.log(`GUI available at http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
