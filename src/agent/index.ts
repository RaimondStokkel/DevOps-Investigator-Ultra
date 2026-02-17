import { loadServerConfig, loadAgentConfig } from "../server/config.js";
import { AzureOpenAIClient } from "./azure-openai-client.js";
import { McpClient } from "./mcp-client.js";
import { LocalTools } from "./local-tools.js";
import { ToolExecutor } from "./tool-executor.js";
import { AgentLoop } from "./agent-loop.js";
import { getSystemPrompt } from "./prompts/system-prompt.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import type { ReasoningMode } from "../server/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function parseArgs(args: string[]): {
  buildId?: number;
  latestFailure?: boolean;
  pipeline?: string;
  investigate?: string;
  verbose?: boolean;
  maxTurns?: number;
  reasoning?: ReasoningMode;
} {
  const result: ReturnType<typeof parseArgs> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--build":
      case "-b":
        result.buildId = parseInt(args[++i]);
        break;
      case "--latest-failure":
      case "-l":
        result.latestFailure = true;
        break;
      case "--pipeline":
      case "-p":
        result.pipeline = args[++i];
        break;
      case "--investigate":
      case "-i":
        result.investigate = args[++i];
        break;
      case "--verbose":
      case "-v":
        result.verbose = true;
        break;
      case "--max-turns":
        result.maxTurns = parseInt(args[++i]);
        break;
      case "--reasoning": {
        const value = (args[++i] ?? "").toLowerCase();
        result.reasoning = value === "expert" ? "expert" : "base";
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
DevOps Build Investigation Agent
=================================

Usage:
  npx tsx src/agent/index.ts [options]

Options:
  --build, -b <id>           Investigate a specific build by ID
  --latest-failure, -l       Find and investigate the most recent failing build
  --pipeline, -p <name>      Filter by pipeline name (used with --latest-failure)
  --investigate, -i <query>  Free-form investigation query
  --verbose, -v              Show detailed tool call logs
  --max-turns <n>            Maximum agent turns (default: 30)
  --reasoning <mode>         Reasoning profile: base | expert (default from env)
  --help, -h                 Show this help message

Examples:
  npx tsx src/agent/index.ts --build 205432
  npx tsx src/agent/index.ts --latest-failure
  npx tsx src/agent/index.ts --latest-failure --pipeline "AL-CI"
  npx tsx src/agent/index.ts --investigate "Why did the last full build fail?"
  npx tsx src/agent/index.ts --latest-failure --reasoning expert
  npx tsx src/agent/index.ts -i "Show me recent failures and their patterns"
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.buildId && !args.latestFailure && !args.investigate) {
    printHelp();
    console.error("\nError: Please specify --build, --latest-failure, or --investigate");
    process.exit(1);
  }

  // Load configs
  const serverConfig = loadServerConfig();
  const agentConfig = loadAgentConfig();

  console.error("Connecting to Azure DevOps MCP server...");

  // Start MCP client (connects to our server)
  const distServerScript = resolve(__dirname, "..", "..", "dist", "server", "index.js");
  const srcServerScript = resolve(__dirname, "..", "server", "index.ts");
  const useDistServer = existsSync(distServerScript);
  const mcpClient = new McpClient(
    useDistServer ? "node" : "npx",
    useDistServer ? [distServerScript] : ["tsx", srcServerScript],
    {
    ADO_PAT: serverConfig.pat,
    ADO_ORG: serverConfig.organization,
    ADO_PROJECT: serverConfig.project,
    }
  );

  try {
    await mcpClient.connect();
    const tools = mcpClient.getTools();
    console.error(`Connected. ${tools.length} Azure DevOps tools available.`);

    // Initialize local tools
    const localTools = new LocalTools(
      agentConfig.repoBasePath,
      agentConfig.repoLookupPaths,
      agentConfig.repoIndexPath
    );
    console.error(
      `Local tools ready. Repo base: ${agentConfig.repoBasePath}. Lookup roots: ${agentConfig.repoLookupPaths.length}`
    );

    // Create tool executor
    const toolExecutor = new ToolExecutor(mcpClient, localTools);

    // Create Azure OpenAI client
    const openaiClient = new AzureOpenAIClient(agentConfig);
    console.error(
      `Azure OpenAI: base=${agentConfig.reasoningProfiles.base.deployment}, expert=${agentConfig.reasoningProfiles.expert.deployment}, default=${agentConfig.defaultReasoningMode}`
    );

    // Build the user prompt
    let userPrompt: string;

    if (args.buildId) {
      userPrompt = `Investigate build ${args.buildId}. Find out what went wrong, identify the root cause, find the relevant code in the local repository, and fix it if possible.`;
    } else if (args.latestFailure) {
      const pipelineFilter = args.pipeline
        ? ` for the pipeline matching "${args.pipeline}"`
        : "";
      userPrompt = `Find the most recent failing build${pipelineFilter}. Investigate the failure, identify the root cause, find the relevant code in the local repository, and fix it if possible.`;
    } else {
      userPrompt = args.investigate!;
    }

    // Run agent loop
    const selectedReasoning = args.reasoning ?? agentConfig.defaultReasoningMode;
    const loopLimits = getLoopLimits(selectedReasoning);
    const agentLoop = new AgentLoop(openaiClient, toolExecutor, {
      verbose: args.verbose ?? true,
      maxTurns: args.maxTurns,
      systemPrompt: getSystemPrompt(serverConfig.projectUrl),
      reasoningMode: selectedReasoning,
      ...loopLimits,
    });

    const result = await agentLoop.run(userPrompt);

    if (result) {
      console.log("\n" + result);
    }
  } finally {
    await mcpClient.disconnect();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
