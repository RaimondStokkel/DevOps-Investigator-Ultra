// Pipeline / Build Definition types
export interface PipelineDefinition {
  id: number;
  name: string;
  folder: string;
  revision: number;
  url: string;
  _links?: Record<string, { href: string }>;
}

export interface PipelineListResponse {
  count: number;
  value: PipelineDefinition[];
}

// Build / Pipeline Run types
export interface Build {
  id: number;
  buildNumber: string;
  status: "none" | "inProgress" | "completed" | "cancelling" | "postponed" | "notStarted" | "all";
  result?: "succeeded" | "partiallySucceeded" | "failed" | "canceled" | "none";
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  url: string;
  definition: {
    id: number;
    name: string;
  };
  sourceBranch: string;
  sourceVersion: string;
  requestedFor?: {
    displayName: string;
    uniqueName: string;
  };
  requestedBy?: {
    displayName: string;
    uniqueName: string;
  };
  reason: string;
  parameters?: string;
  _links?: Record<string, { href: string }>;
}

export interface BuildListResponse {
  count: number;
  value: Build[];
}

// Timeline types (stages, jobs, tasks)
export interface TimelineRecord {
  id: string;
  parentId?: string;
  type: "Stage" | "Phase" | "Job" | "Task" | "Checkpoint" | string;
  name: string;
  state: "pending" | "inProgress" | "completed";
  result?: "succeeded" | "succeededWithIssues" | "failed" | "canceled" | "skipped" | "abandoned";
  startTime?: string;
  finishTime?: string;
  log?: {
    id: number;
    type: string;
    url: string;
  };
  order?: number;
  errorCount?: number;
  warningCount?: number;
  issues?: Array<{
    type: "error" | "warning";
    category?: string;
    message: string;
    data?: Record<string, string>;
  }>;
  workerName?: string;
  previousAttempts?: Array<{ id: string; timelineId: string; attempt: number }>;
}

export interface Timeline {
  records: TimelineRecord[];
  id: string;
  changeId: number;
  lastChangedBy: string;
  lastChangedOn: string;
  url: string;
}

// Build Log types
export interface BuildLogEntry {
  id: number;
  type: string;
  url: string;
  lineCount: number;
  createdOn: string;
  lastChangedOn: string;
}

export interface BuildLogListResponse {
  count: number;
  value: BuildLogEntry[];
}

// Build Artifact types
export interface BuildArtifact {
  id: number;
  name: string;
  resource: {
    type: string;
    data: string;
    url: string;
    downloadUrl?: string;
  };
}

export interface BuildArtifactListResponse {
  count: number;
  value: BuildArtifact[];
}

// Repository types
export interface Repository {
  id: string;
  name: string;
  url: string;
  defaultBranch?: string;
  size: number;
  project: {
    id: string;
    name: string;
  };
}

export interface RepositoryListResponse {
  count: number;
  value: Repository[];
}

export interface TreeEntry {
  objectId: string;
  relativePath: string;
  mode: string;
  gitObjectType: "blob" | "tree";
  url: string;
  size?: number;
}

export interface TreeResponse {
  count: number;
  value: TreeEntry[];
}

export interface FileContentResponse {
  content: string;
  contentType?: string;
}

// Work Item types
export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  url: string;
}

export interface WorkItemSearchResult {
  count: number;
  results: Array<{
    project: { name: string };
    fields: Record<string, string>;
    hits: Array<{ fieldReferenceName: string; highlights: string[] }>;
    url: string;
  }>;
}

// Error classification
export type ErrorCategory =
  | "al_compilation_error"
  | "test_failure"
  | "container_error"
  | "powershell_script_error"
  | "dependency_error"
  | "timeout"
  | "infrastructure_error"
  | "unknown";

export interface BuildErrorClassification {
  category: ErrorCategory;
  failingStep: string;
  errorMessage: string;
  affectedFile?: string;
  lineNumber?: number;
  errorCode?: string;
  logExcerpt: string;
}
