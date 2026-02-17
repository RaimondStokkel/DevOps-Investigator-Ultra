import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  organization: string;
  project: string;
  projectUrl: string;
  pat: string;
  baseUrl: string;
}

export interface AgentConfig {
  azureOpenAiKey: string;
  azureOpenAiApiVersion: string;
  reasoningProfiles: Record<ReasoningMode, ReasoningProfile>;
  defaultReasoningMode: ReasoningMode;
  repoBasePath: string;
  repoLookupPaths: string[];
  repoIndexPath: string;
}

export type ReasoningMode = "base" | "expert";

export interface ReasoningProfile {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

interface RepoIndexConfig {
  basePath?: string;
  lookupPaths?: string[];
}

const DEFAULT_BASE_REASONING_URL =
  "https://your-resource.openai.azure.com/openai/deployments/o4-mini/chat/completions?api-version=2024-12-01-preview";

const O4_MIN_API_MIN_DATE = "2024-12-01";

function extractApiDate(apiVersion: string): string | null {
  const match = apiVersion.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function ensureCompatibleApiVersion(deployment: string, apiVersion: string): string {
  if (!deployment.toLowerCase().startsWith("o4-mini")) return apiVersion;
  const currentDate = extractApiDate(apiVersion);
  if (!currentDate || currentDate < O4_MIN_API_MIN_DATE) {
    return "2024-12-01-preview";
  }
  return apiVersion;
}

function parseAzureDeploymentUrl(
  rawUrl: string,
  fallbackApiVersion: string
): ReasoningProfile {
  const parsed = new URL(rawUrl);
  const deploymentsIndex = parsed.pathname.indexOf("/openai/deployments/");
  if (deploymentsIndex < 0) {
    throw new Error(`Invalid Azure OpenAI deployment URL: ${rawUrl}`);
  }

  const tail = parsed.pathname.slice(deploymentsIndex + "/openai/deployments/".length);
  const deployment = tail.split("/")[0];
  if (!deployment) {
    throw new Error(`Could not parse deployment name from URL: ${rawUrl}`);
  }

  const requestedApiVersion = parsed.searchParams.get("api-version") ?? fallbackApiVersion;
  const compatibleApiVersion = ensureCompatibleApiVersion(deployment, requestedApiVersion);

  return {
    endpoint: parsed.origin,
    deployment,
    apiVersion: compatibleApiVersion,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadServerConfig(): ServerConfig {
  const organization = process.env.ADO_ORG ?? "cegekadsa";
  const project = process.env.ADO_PROJECT ?? "DynamicsEmpire";
  const projectUrl = process.env.ADO_PROJECT_URL ?? `https://dev.azure.com/${organization}/${project}/`;
  const pat = requireEnv("ADO_PAT");

  return {
    organization,
    project,
    projectUrl,
    pat,
    baseUrl: `https://dev.azure.com/${organization}/${project}/_apis`,
  };
}

export function loadAgentConfig(): AgentConfig {
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-05-01-preview";

  const repoIndexPath = resolve(
    process.env.REPO_INDEX_PATH ?? resolve(__dirname, "..", "..", "configs", "repo-index.json")
  );

  let repoBasePath = process.env.REPO_BASE_PATH ?? "C:\\Repo";
  let repoLookupPaths: string[] = [repoBasePath];

  if (existsSync(repoIndexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(repoIndexPath, "utf-8")) as RepoIndexConfig;
      if (!process.env.REPO_BASE_PATH && parsed.basePath) {
        repoBasePath = parsed.basePath;
      }

      if (Array.isArray(parsed.lookupPaths) && parsed.lookupPaths.length > 0) {
        repoLookupPaths = parsed.lookupPaths;
      }
    } catch {
      // Fall back to env/default values when index file is invalid
    }
  }

  repoLookupPaths = Array.from(
    new Set([repoBasePath, ...repoLookupPaths].map((p) => resolve(p)))
  );

  const endpointFallback = process.env.AZURE_OPENAI_ENDPOINT;
  const deploymentFallback = process.env.AZURE_OPENAI_DEPLOYMENT;

  const baseUrlRaw = process.env.AZURE_OPENAI_BASE_URL
    ?? (
      endpointFallback && deploymentFallback
        ? `${endpointFallback.replace(/\/$/, "")}/openai/deployments/${deploymentFallback}/chat/completions?api-version=${encodeURIComponent(
          ensureCompatibleApiVersion(deploymentFallback, apiVersion)
        )}`
        : DEFAULT_BASE_REASONING_URL
    );
  const baseProfile = parseAzureDeploymentUrl(baseUrlRaw, apiVersion);

  const expertUrlRaw = process.env.AZURE_OPENAI_EXPERT_URL;

  let expertProfile: ReasoningProfile = baseProfile;
  if (expertUrlRaw) {
    expertProfile = parseAzureDeploymentUrl(expertUrlRaw, apiVersion);
  } else if (endpointFallback && deploymentFallback) {
    const compatibleApiVersion = ensureCompatibleApiVersion(deploymentFallback, apiVersion);
    expertProfile = {
      endpoint: endpointFallback,
      deployment: deploymentFallback,
      apiVersion: compatibleApiVersion,
    };
  }

  const defaultReasoningModeRaw = (process.env.AZURE_OPENAI_DEFAULT_REASONING ?? "base").toLowerCase();
  const defaultReasoningMode: ReasoningMode =
    defaultReasoningModeRaw === "expert" ? "expert" : "base";

  return {
    azureOpenAiKey: requireEnv("AZURE_OPENAI_KEY"),
    azureOpenAiApiVersion: apiVersion,
    reasoningProfiles: {
      base: baseProfile,
      expert: expertProfile,
    },
    defaultReasoningMode,
    repoBasePath: resolve(repoBasePath),
    repoLookupPaths,
    repoIndexPath,
  };
}
