export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type KeyValue = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  secret?: boolean;
};

export type BodyMode = "raw" | "multipart";

export type MultipartField = {
  id: string;
  name: string;
  value: string;
  contentType: string;
  enabled: boolean;
};

export type ServerProfile = {
  id: string;
  name: string;
  baseUrl: string;
  headers: KeyValue[];
  variables: KeyValue[];
};

export type AccessToken = {
  id: string;
  name: string;
  value: string;
  hasValue: boolean;
};

export type ApiRequest = {
  id: string;
  name: string;
  method: HttpMethod;
  path: string;
  pathParams: KeyValue[];
  authTokenId: string;
  query: KeyValue[];
  headers: KeyValue[];
  bodyMode: BodyMode;
  body: string;
  multipartFields: MultipartField[];
};

export type ExtractRule = {
  id: string;
  name: string;
  source: "json" | "headers" | "text";
  path: string;
  variable: string;
  enabled: boolean;
};

export type WorkflowStep = {
  id: string;
  name: string;
  requestId: string;
  enabled: boolean;
  extractRules: ExtractRule[];
};

export type Workflow = {
  id: string;
  name: string;
  serverId: string;
  steps: WorkflowStep[];
};

export type Workspace = {
  servers: ServerProfile[];
  requests: ApiRequest[];
  accessTokens: AccessToken[];
  workflows: Workflow[];
  activeServerId: string;
  activeRequestId: string;
  activeTokenId: string;
  activeWorkflowId: string;
};

export type RequestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  elapsedMs: number;
  url: string;
  request?: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: {
    headers: Record<string, string>;
    body: string;
  };
  extracted: Record<string, string>;
  error?: string;
  stepId?: string;
  stepName?: string;
  requestName?: string;
};

export type WorkflowResult = {
  ok: boolean;
  results: RequestResult[];
  variables: Record<string, string>;
};

export type BridgeApi = {
  loadWorkspace: () => Promise<Workspace | null>;
  saveWorkspace: (workspace: Workspace) => Promise<{ ok: boolean; path?: string }>;
  sendRequest: (payload: {
    server: ServerProfile;
    request: ApiRequest;
    accessTokens?: AccessToken[];
    runtimeVariables?: Record<string, string>;
    extractRules?: ExtractRule[];
  }) => Promise<RequestResult>;
  runWorkflow: (payload: {
    workspace: Workspace;
    workflowId: string;
    serverId: string;
  }) => Promise<WorkflowResult>;
  saveSecret: (key: string, value: string) => Promise<void>;
  loadSecret: (key: string) => Promise<string | null>;
  deleteSecret: (key: string) => Promise<void>;
};
