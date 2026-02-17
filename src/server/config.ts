import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  organization: string;
  project: string;
  pat: string;
  baseUrl: string;
}

export interface AgentConfig {
  azureOpenAiKey: string;
  azureOpenAiEndpoint: string;
  azureOpenAiDeployment: string;
  azureOpenAiApiVersion: string;
  repoBasePath: string;
  repoLookupPaths: string[];
  repoIndexPath: string;
}

interface RepoIndexConfig {
  basePath?: string;
  lookupPaths?: string[];
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
  const pat = requireEnv("ADO_PAT");

  return {
    organization,
    project,
    pat,
    baseUrl: `https://dev.azure.com/${organization}/${project}/_apis`,
  };
}

export function loadAgentConfig(): AgentConfig {
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

  return {
    azureOpenAiKey: requireEnv("AZURE_OPENAI_KEY"),
    azureOpenAiEndpoint: requireEnv("AZURE_OPENAI_ENDPOINT"),
    azureOpenAiDeployment: requireEnv("AZURE_OPENAI_DEPLOYMENT"),
    azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-05-01-preview",
    repoBasePath: resolve(repoBasePath),
    repoLookupPaths,
    repoIndexPath,
  };
}
