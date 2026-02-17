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

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "public");
const htmlPath = resolve(publicDir, "index.html");

const serverConfig = loadServerConfig();
const adoClient = new AzureDevOpsClient(serverConfig);

let isInvestigating = false;
let activeAbortController: AbortController | null = null;
let lastInvestigationResult = "";

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
  abortSignal?: AbortSignal
): Promise<string> {
  const agentConfig = loadAgentConfig();
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

    const agentLoop = new AgentLoop(openaiClient, toolExecutor, {
      verbose: false,
      maxTurns: 30,
      onEvent: (event) => onEvent?.(event),
      abortSignal,
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
    sendJson(res, 200, { path: repoIndexPath, content });
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
      return {
        prompt: `Continue from this previous investigation summary:\n\n${lastInvestigationResult}\n\nFollow-up request: ${query}`,
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
      activeAbortController.signal
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
      activeAbortController.signal
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
