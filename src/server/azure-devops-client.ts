import type { ServerConfig } from "./config.js";
import type {
  Build,
  BuildListResponse,
  BuildArtifact,
  BuildArtifactListResponse,
  BuildLogListResponse,
  PipelineDefinition,
  PipelineListResponse,
  Repository,
  RepositoryListResponse,
  Timeline,
  TreeResponse,
  WorkItem,
  WorkItemSearchResult,
} from "./types/azure-devops.js";

export class AzureDevOpsClient {
  private authHeader: string;
  private baseUrl: string;
  private orgBaseUrl: string;

  constructor(private config: ServerConfig) {
    // Auth pattern from Get-cdsaAzureDevOpsAuthorizationHeader.ps1:22-23
    // ":${PAT}" encoded as Base64
    const cred = `:${config.pat}`;
    const encoded = Buffer.from(cred, "ascii").toString("base64");
    this.authHeader = `Basic ${encoded}`;

    // URL pattern from Get-cdsaAzureDevOpsAPIUri.ps1:27
    this.baseUrl = `https://dev.azure.com/${config.organization}/${config.project}/_apis`;
    this.orgBaseUrl = `https://dev.azure.com/${config.organization}/_apis`;
  }

  private async request<T>(
    path: string,
    params?: Record<string, string>,
    options?: { baseUrl?: string; rawText?: boolean }
  ): Promise<T> {
    const base = options?.baseUrl ?? this.baseUrl;
    const url = new URL(`${base}/${path}`);
    url.searchParams.set("api-version", "7.1");
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Azure DevOps API error ${response.status}: ${body}`);
    }

    if (options?.rawText) {
      return (await response.text()) as T;
    }

    return (await response.json()) as T;
  }

  // --- Pipelines ---

  async listPipelines(nameFilter?: string, top?: number): Promise<PipelineDefinition[]> {
    const params: Record<string, string> = {};
    if (top) params["$top"] = String(top);
    const result = await this.request<PipelineListResponse>("pipelines", params);
    let pipelines = result.value;
    if (nameFilter) {
      const filter = nameFilter.toLowerCase();
      pipelines = pipelines.filter((p) => p.name.toLowerCase().includes(filter));
    }
    return pipelines;
  }

  async getPipeline(pipelineId: number): Promise<PipelineDefinition> {
    return this.request<PipelineDefinition>(`pipelines/${pipelineId}`);
  }

  // --- Builds / Pipeline Runs ---

  async listBuilds(query?: {
    definitions?: number;
    branchName?: string;
    resultFilter?: string;
    statusFilter?: string;
    top?: number;
  }): Promise<Build[]> {
    const params: Record<string, string> = {};
    if (query?.definitions) params.definitions = String(query.definitions);
    if (query?.branchName) params.branchName = query.branchName;
    if (query?.resultFilter) params.resultFilter = query.resultFilter;
    if (query?.statusFilter) params.statusFilter = query.statusFilter;
    if (query?.top) params["$top"] = String(query.top);
    const result = await this.request<BuildListResponse>("build/builds", params);
    return result.value;
  }

  async getBuild(buildId: number): Promise<Build> {
    return this.request<Build>(`build/builds/${buildId}`);
  }

  // --- Build Timeline ---

  async getBuildTimeline(buildId: number): Promise<Timeline> {
    return this.request<Timeline>(`build/builds/${buildId}/timeline`);
  }

  // --- Build Logs ---

  async getBuildLogs(buildId: number): Promise<BuildLogListResponse> {
    return this.request<BuildLogListResponse>(`build/builds/${buildId}/logs`);
  }

  async getBuildLog(
    buildId: number,
    logId: number,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const params: Record<string, string> = {};
    if (startLine !== undefined) params.startLine = String(startLine);
    if (endLine !== undefined) params.endLine = String(endLine);
    return this.request<string>(`build/builds/${buildId}/logs/${logId}`, params, {
      rawText: true,
    });
  }

  // --- Build Artifacts ---

  async listBuildArtifacts(buildId: number): Promise<BuildArtifact[]> {
    const result = await this.request<BuildArtifactListResponse>(
      `build/builds/${buildId}/artifacts`
    );
    return result.value;
  }

  // --- Repositories ---

  async listRepositories(): Promise<Repository[]> {
    const result = await this.request<RepositoryListResponse>("git/repositories");
    return result.value;
  }

  async getFileContent(
    repositoryId: string,
    path: string,
    branch?: string
  ): Promise<string> {
    const params: Record<string, string> = {
      path,
      includeContent: "true",
    };
    if (branch) params["versionDescriptor.version"] = branch;
    params["versionDescriptor.versionType"] = "branch";

    // Items endpoint returns file content
    const url = new URL(`${this.baseUrl}/git/repositories/${repositoryId}/items`);
    url.searchParams.set("api-version", "7.1");
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        Accept: "text/plain",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Azure DevOps API error ${response.status}: ${body}`);
    }

    return response.text();
  }

  async getRepositoryTree(
    repositoryId: string,
    path?: string,
    branch?: string
  ): Promise<TreeResponse> {
    const params: Record<string, string> = {
      recursionLevel: "oneLevel",
    };
    if (path) params.scopePath = path;
    if (branch) {
      params["versionDescriptor.version"] = branch;
      params["versionDescriptor.versionType"] = "branch";
    }
    return this.request<TreeResponse>(
      `git/repositories/${repositoryId}/items`,
      { ...params, includeContentMetadata: "true" }
    );
  }

  // --- Work Items ---

  async getWorkItem(workItemId: number): Promise<WorkItem> {
    return this.request<WorkItem>(`wit/workitems/${workItemId}`, {
      "$expand": "all",
    });
  }

  async searchWorkItems(
    searchText: string,
    top?: number
  ): Promise<WorkItemSearchResult> {
    // Work item search uses the search API which has a different base URL
    const url = new URL(
      `https://almsearch.dev.azure.com/${this.config.organization}/${this.config.project}/_apis/search/workitemsearchresults`
    );
    url.searchParams.set("api-version", "7.1");

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchText,
        $top: top ?? 10,
        filters: {},
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Azure DevOps Search API error ${response.status}: ${body}`);
    }

    return (await response.json()) as WorkItemSearchResult;
  }
}
