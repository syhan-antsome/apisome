import {
  Activity,
  Braces,
  Check,
  ChevronRight,
  Copy,
  Database,
  FileJson,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  Trash2,
  Workflow as WorkflowIcon,
  X
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type {
  AccessToken,
  ApiRequest,
  ExtractRule,
  HttpMethod,
  KeyValue,
  MultipartField,
  RequestResult,
  ServerProfile,
  Workflow,
  WorkflowResult,
  Workspace
} from "./types";

const methods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const browserStorageKey = "b2c-api-workspace-v2";
const resetConfirmLength = 8;
const resetConfirmChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function createResetConfirmPhrase() {
  const bytes = new Uint8Array(resetConfirmLength);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => resetConfirmChars[byte % resetConfirmChars.length]).join("");
}

type DeleteConfirmPayload = {
  message: string;
  onConfirm: () => void | Promise<void>;
};

const deleteConfirmEventName = "b2c-delete-confirm";

function confirmDelete(message: string, onConfirm: () => void | Promise<void>) {
  window.dispatchEvent(new CustomEvent<DeleteConfirmPayload>(deleteConfirmEventName, { detail: { message, onConfirm } }));
}

function deleteTargetName(value: string | undefined, fallback: string) {
  return value?.trim() || fallback;
}

function id(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function kv(key = "", value = "", enabled = true): KeyValue {
  return { id: id("kv"), key, value, enabled };
}

function multipartField(name = "request", value = "", contentType = "application/json", enabled = true): MultipartField {
  return { id: id("part"), name, value, contentType, enabled };
}

function token(name = "새 토큰", value = ""): AccessToken {
  return { id: id("token"), name, value, hasValue: Boolean(value) };
}

function tokenSecretKey(tokenId: string) {
  return `access-token:${tokenId}`;
}

function rule(name = "토큰 추출", path = "json.token", variable = "token"): ExtractRule {
  return { id: id("rule"), name, source: "json", path, variable, enabled: true };
}

function seedWorkspace(): Workspace {
  const serverId = id("server");
  const loginRequestId = id("request");
  const profileRequestId = id("request");
  const sampleToken = token("샘플 액세스 토큰", "sample-access-token");
  const workflowId = id("workflow");

  return {
    activeServerId: serverId,
    activeRequestId: loginRequestId,
    activeTokenId: sampleToken.id,
    activeWorkflowId: workflowId,
    servers: [
      {
        id: serverId,
        name: "회사 개발 서버",
        baseUrl: "mock://company",
        headers: [kv("Accept", "application/json")],
        variables: [kv("memberId", "10001"), kv("username", "demo"), kv("password", "demo")]
      }
    ],
    requests: [
      {
        id: loginRequestId,
        name: "회원 ID로 토큰 발급",
        method: "POST",
        path: "/api/auths/util/generate-token-by-id/{memberId}",
        pathParams: [kv("memberId", "{{memberId}}")],
        authTokenId: "",
        query: [],
        headers: [kv("Content-Type", "application/json")],
        bodyMode: "raw",
        body: JSON.stringify(
          {
            username: "{{username}}",
            password: "{{password}}"
          },
          null,
          2
        ),
        multipartFields: []
      },
      {
        id: profileRequestId,
        name: "내 프로필 조회",
        method: "GET",
        path: "/anything/users/me",
        pathParams: [],
        authTokenId: sampleToken.id,
        query: [],
        headers: [],
        bodyMode: "raw",
        body: "",
        multipartFields: []
      }
    ],
    accessTokens: [sampleToken],
    workflows: [
      {
        id: workflowId,
        name: "로그인 후 사용자 조회",
        serverId,
        steps: [
          {
            id: id("step"),
            name: "토큰 받기",
            requestId: loginRequestId,
            enabled: true,
            extractRules: [rule("응답 JSON에서 token 저장", "token", "token")]
          },
          {
            id: id("step"),
            name: "토큰으로 프로필 호출",
            requestId: profileRequestId,
            enabled: true,
            extractRules: []
          }
        ]
      }
    ]
  };
}

function pathParamKeys(path: string) {
  const keys = new Set<string>();
  const curlyPattern = /\{([a-zA-Z0-9_.-]+)\}/g;
  const colonPattern = /(?:^|\/):([a-zA-Z0-9_.-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = curlyPattern.exec(path))) keys.add(match[1]);
  while ((match = colonPattern.exec(path))) keys.add(match[1]);

  return Array.from(keys);
}

function syncPathParams(path: string, rows: KeyValue[] = []) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return pathParamKeys(path).map((key) => byKey.get(key) ?? kv(key, `{{${key}}}`));
}

function normalizeRequest(request: ApiRequest): ApiRequest {
  return {
    ...request,
    pathParams: syncPathParams(request.path, request.pathParams || []),
    authTokenId: request.authTokenId || "",
    query: request.query || [],
    headers: request.headers || [],
    bodyMode: request.bodyMode || "raw",
    body: request.body || "",
    multipartFields: request.multipartFields || []
  };
}

function normalizeToken(token: AccessToken): AccessToken {
  return {
    id: token.id,
    name: token.name || "이름 없는 토큰",
    value: token.value || "",
    hasValue: Boolean(token.hasValue || token.value)
  };
}

function normalizeWorkspace(workspace: Workspace): Workspace {
  const accessTokens = (workspace.accessTokens || []).map(normalizeToken);
  return {
    ...workspace,
    servers: workspace.servers || [],
    requests: (workspace.requests || []).map(normalizeRequest),
    accessTokens,
    activeTokenId: workspace.activeTokenId || accessTokens[0]?.id || "",
    workflows: workspace.workflows || []
  };
}

function getApi() {
  if (window.__TAURI_INTERNALS__) {
    return {
      loadWorkspace: () => invoke<Workspace | null>("load_workspace"),
      saveWorkspace: (workspace: Workspace) => invoke<{ ok: boolean; path?: string }>("save_workspace", { workspace }),
      sendRequest: (payload: {
        server: ServerProfile;
        request: ApiRequest;
        accessTokens?: AccessToken[];
        runtimeVariables?: Record<string, string>;
        extractRules?: ExtractRule[];
      }) => invoke<RequestResult>("send_request", payload),
      runWorkflow: (payload: {
        workspace: Workspace;
        workflowId: string;
        serverId: string;
      }) => invoke<WorkflowResult>("run_workflow", payload),
      saveSecret: (key: string, value: string) => invoke<void>("save_secret", { key, value }),
      loadSecret: (key: string) => invoke<string | null>("load_secret", { key }),
      deleteSecret: (key: string) => invoke<void>("delete_secret", { key })
    };
  }

  return {
    async loadWorkspace() {
      const raw = localStorage.getItem(browserStorageKey);
      return raw ? JSON.parse(raw) : null;
    },
    async saveWorkspace(workspace: Workspace) {
      localStorage.setItem(browserStorageKey, JSON.stringify(workspace));
      return { ok: true };
    },
    async sendRequest({ server, request, accessTokens = [], runtimeVariables = {}, extractRules = [] }: any) {
      return runInBrowser(server, request, accessTokens, runtimeVariables, extractRules);
    },
    async runWorkflow({ workspace, workflowId, serverId }: any) {
      const workflow = workspace.workflows.find((item: Workflow) => item.id === workflowId);
      const server = workspace.servers.find((item: ServerProfile) => item.id === serverId);
      const runtimeVariables: Record<string, string> = {};
      const results: RequestResult[] = [];
      for (const step of workflow.steps) {
        if (step.enabled === false) continue;
        const request = workspace.requests.find((item: ApiRequest) => item.id === step.requestId);
        const result = await runInBrowser(server, request, workspace.accessTokens || [], runtimeVariables, step.extractRules);
        Object.assign(runtimeVariables, result.extracted);
        results.push({ ...result, stepId: step.id, stepName: step.name, requestName: request.name });
        if (!result.ok) break;
      }
      return { ok: results.every((item) => item.ok), results, variables: runtimeVariables };
    },
    async saveSecret(_key: string, _value: string) {},
    async loadSecret(_key: string) {
      return null;
    },
    async deleteSecret(_key: string) {}
  };
}

function interpolate(value: string, vars: Record<string, string>) {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => vars[key] ?? "");
}

function pathParamValue(name: string, request: ApiRequest, vars: Record<string, string>) {
  const row = request.pathParams?.find((item) => item.enabled && item.key === name);
  if (row) return interpolate(row.value, vars);
  return vars[name] ?? "";
}

function applyPathParams(path: string, request: ApiRequest, vars: Record<string, string>) {
  const replaceValue = (name: string) => encodeURIComponent(pathParamValue(name, request, vars));
  return path
    .replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, name) => replaceValue(name))
    .replace(/(^|\/):([a-zA-Z0-9_.-]+)/g, (_, prefix, name) => `${prefix}${replaceValue(name)}`);
}

function applyAuthTokenHeader(headers: Record<string, string>, request: ApiRequest, accessTokens: AccessToken[], vars: Record<string, string>) {
  if (!request.authTokenId) return headers;
  const selected = accessTokens.find((item) => item.id === request.authTokenId);
  const value = selected?.value ? interpolate(selected.value, vars) : "";
  if (!value) return headers;

  const next = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization"));
  next.authorization = `Bearer ${value}`;
  return next;
}

function withoutContentType(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type"));
}

function activeMultipartFields(request: ApiRequest) {
  return (request.multipartFields || []).filter((item) => item.enabled && item.name);
}

function multipartPreview(request: ApiRequest, vars: Record<string, string>) {
  const parts = activeMultipartFields(request).map((item) => {
    const name = interpolate(item.name, vars);
    const contentType = interpolate(item.contentType || "", vars).trim();
    const value = interpolate(item.value, vars);
    const lines = [`name: ${name}`];
    if (contentType) lines.push(`content-type: ${contentType}`);
    lines.push("", value);
    return lines.join("\n");
  });
  return parts.join("\n\n--- part ---\n\n");
}

function buildBrowserRequestBody(request: ApiRequest, vars: Record<string, string>) {
  if (["GET", "HEAD"].includes(request.method)) {
    return { body: undefined, preview: undefined };
  }

  if (request.bodyMode === "multipart") {
    const formData = new FormData();
    for (const item of activeMultipartFields(request)) {
      const name = interpolate(item.name, vars);
      const value = interpolate(item.value, vars);
      const contentType = interpolate(item.contentType || "", vars).trim();
      if (contentType) {
        formData.append(name, new Blob([value], { type: contentType }));
      } else {
        formData.append(name, value);
      }
    }
    return { body: formData, preview: multipartPreview(request, vars) };
  }

  const body = interpolate(request.body, vars);
  return { body, preview: body };
}

function browserVariables(server: ServerProfile, runtimeVariables: Record<string, string>) {
  return {
    ...Object.fromEntries(server.variables.filter((item) => item.enabled).map((item) => [item.key, item.value])),
    ...runtimeVariables
  } as Record<string, string>;
}

async function runInBrowser(
  server: ServerProfile,
  request: ApiRequest,
  accessTokens: AccessToken[],
  runtimeVariables: Record<string, string>,
  extractRules: ExtractRule[]
): Promise<RequestResult> {
  const vars = browserVariables(server, runtimeVariables);
  const requestPath = applyPathParams(interpolate(request.path || "/", vars), request, vars);
  const url = new URL(requestPath, server.baseUrl.endsWith("/") ? server.baseUrl : `${server.baseUrl}/`);
  request.query.filter((item) => item.enabled && item.key).forEach((item) => url.searchParams.set(interpolate(item.key, vars), interpolate(item.value, vars)));
  let headers: Record<string, string> = {};
  [...server.headers, ...request.headers]
    .filter((item) => item.enabled && item.key)
    .forEach((item) => {
      headers[interpolate(item.key, vars)] = interpolate(item.value, vars);
    });
  headers = applyAuthTokenHeader(headers, request, accessTokens, vars);
  if (request.bodyMode === "multipart") {
    headers = withoutContentType(headers);
  }
  const startedAt = performance.now();
  const requestBody = buildBrowserRequestBody(request, vars);

  if (url.protocol === "mock:") {
    const response = mockBrowserResponse(url, headers, requestBody.preview);
    const extracted = extractValues(extractRules, response.body, response.headers);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      elapsedMs: Math.round(performance.now() - startedAt),
      url: url.toString(),
      request: { method: request.method, headers, body: requestBody.preview },
      response,
      extracted
    };
  }

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: requestBody.body
    });
    const body = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const extracted = extractValues(extractRules, body, responseHeaders);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      elapsedMs: Math.round(performance.now() - startedAt),
      url: url.toString(),
      request: { method: request.method, headers, body: requestBody.preview },
      response: { headers: responseHeaders, body },
      extracted
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "Browser fetch error",
      elapsedMs: Math.round(performance.now() - startedAt),
      url: url.toString(),
      response: { headers: {}, body: "" },
      extracted: {},
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function mockBrowserResponse(url: URL, headers: Record<string, string>, body?: string) {
  const requestJson = safeJson(body || "{}") || {};
  const username = (requestJson as Record<string, string>).username || "demo";
  const payload = url.pathname.includes("auth/login") || url.pathname.includes("generate-token")
    ? {
        token: `mock-token-${username}`,
        expiresIn: 3600,
        userId: `user-${username}`,
        issuedAt: new Date().toISOString()
      }
    : {
        profile: {
          id: `user-${username}`,
          name: "Demo User",
          role: "tester"
        },
        authorization: headers.Authorization || headers.authorization || "",
        path: url.pathname
      };

  return {
    headers: {
      "content-type": "application/json",
      "x-workbench-mock": "true"
    },
    body: JSON.stringify(payload, null, 2)
  };
}

function extractValues(rules: ExtractRule[], responseText: string, headers: Record<string, string>) {
  const extracted: Record<string, string> = {};
  const json = safeJson(responseText);
  for (const item of rules.filter((entry) => entry.enabled && entry.variable)) {
    let value: unknown;
    if (item.source === "headers") {
      value = headers[item.path.toLowerCase()];
    } else if (item.source === "text") {
      const match = responseText.match(new RegExp(item.path));
      value = match ? match[1] || match[0] : undefined;
    } else {
      value = getPath(json, item.path);
    }
    if (value !== undefined) extracted[item.variable] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return extracted;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function getPath(value: unknown, path: string) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current: any = value;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function compactBody(body: string) {
  if (!body) return "";
  if (body.length < 2200) return body;
  return `${body.slice(0, 2200)}\n\n... ${body.length - 2200} bytes more`;
}

function maskHeaderValue(key: string, value: string) {
  if (key.toLowerCase() !== "authorization") return value;
  const match = value.match(/^(\S+)\s+(.+)$/);
  if (!match) return value ? "(set)" : "";
  const [, scheme, tokenValue] = match;
  if (tokenValue.length <= 12) return `${scheme} ${"*".repeat(tokenValue.length)}`;
  return `${scheme} ${tokenValue.slice(0, 8)}...${tokenValue.slice(-4)}`;
}

function requestPreview(result: RequestResult) {
  if (!result.request) return "요청 정보가 없습니다.";
  const headers = Object.fromEntries(
    Object.entries(result.request.headers).map(([key, value]) => [key, maskHeaderValue(key, value)])
  );
  return JSON.stringify(
    {
      method: result.request.method,
      url: result.url,
      headers,
      body: result.request.body || null
    },
    null,
    2
  );
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace>(() => seedWorkspace());
  const [view, setView] = useState<"servers" | "requests" | "tokens">("requests");
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [resetConfirmPhrase, setResetConfirmPhrase] = useState(() => createResetConfirmPhrase());
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmPayload | null>(null);

  const api = useMemo(() => getApi(), []);

  useEffect(() => {
    function handleDeleteConfirm(event: Event) {
      setDeleteConfirm((event as CustomEvent<DeleteConfirmPayload>).detail);
    }

    window.addEventListener(deleteConfirmEventName, handleDeleteConfirm);
    return () => window.removeEventListener(deleteConfirmEventName, handleDeleteConfirm);
  }, []);

  useEffect(() => {
    api.loadWorkspace().then((saved) => {
      if (saved) setWorkspace(normalizeWorkspace(saved));
      setIsLoaded(true);
    });
  }, [api]);

  useEffect(() => {
    if (!isLoaded) return;
    setIsSaving(true);
    const timer = window.setTimeout(() => {
      api
        .saveWorkspace(workspace)
        .then(() => setSaveError(null))
        .catch((error) => {
          console.warn("Failed to save workspace", error);
          setSaveError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setIsSaving(false));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [api, isLoaded, workspace]);

  const activeServer = workspace.servers.find((item) => item.id === workspace.activeServerId) || workspace.servers[0];
  const activeRequest = workspace.requests.find((item) => item.id === workspace.activeRequestId) || workspace.requests[0];
  const activeToken = workspace.accessTokens.find((item) => item.id === workspace.activeTokenId) || workspace.accessTokens[0];
  const activeWorkflow = workspace.workflows.find((item) => item.id === workspace.activeWorkflowId) || workspace.workflows[0];
  const selectedResult = result?.results[selectedResultIndex] || result?.results[0] || null;

  function updateWorkspace(next: Partial<Workspace>) {
    setWorkspace((current) => ({ ...current, ...next }));
  }

  function replaceServer(server: ServerProfile) {
    setWorkspace((current) => ({
      ...current,
      servers: current.servers.map((item) => (item.id === server.id ? server : item))
    }));
  }

  function deleteServer(serverId: string) {
    const serverName = deleteTargetName(workspace.servers.find((item) => item.id === serverId)?.name, "선택한 서버");
    confirmDelete("서버 \"" + serverName + "\"을 삭제할까요?", () => {
      setWorkspace((current) => {
        const remainingServers = current.servers.filter((item) => item.id !== serverId);
        const fallbackServer =
          remainingServers[0] || {
            id: id("server"),
            name: "새 서버",
            baseUrl: "https://api.example.com",
            headers: [kv("Accept", "application/json")],
            variables: []
          };
        const nextServers = remainingServers.length ? remainingServers : [fallbackServer];
        const nextServerIds = new Set(nextServers.map((item) => item.id));
        const nextActiveServerId = nextServerIds.has(current.activeServerId) ? current.activeServerId : fallbackServer.id;

        return {
          ...current,
          servers: nextServers,
          workflows: current.workflows.map((workflow) =>
            nextServerIds.has(workflow.serverId) ? workflow : { ...workflow, serverId: fallbackServer.id }
          ),
          activeServerId: nextActiveServerId
        };
      });
      setResult(null);
    });
  }

  function replaceRequest(request: ApiRequest) {
    setWorkspace((current) => ({
      ...current,
      requests: current.requests.map((item) => (item.id === request.id ? request : item))
    }));
  }

  function deleteRequest(requestId: string) {
    const requestName = deleteTargetName(workspace.requests.find((item) => item.id === requestId)?.name, "선택한 API");
    confirmDelete("API \"" + requestName + "\"를 삭제할까요?", () => {
      setWorkspace((current) => {
        const remainingRequests = current.requests.filter((item) => item.id !== requestId);
        const fallbackRequest =
          remainingRequests[0] ||
          normalizeRequest({
            id: id("request"),
            name: "새 API",
            method: "GET",
            path: "/",
            pathParams: [],
            authTokenId: "",
            query: [],
            headers: [],
            bodyMode: "raw",
            body: "",
            multipartFields: []
          });
        const nextRequests = remainingRequests.length ? remainingRequests : [fallbackRequest];
        const workflows = current.workflows.map((workflow) => ({
          ...workflow,
          steps: workflow.steps.filter((step) => step.requestId !== requestId)
        }));

        return {
          ...current,
          requests: nextRequests,
          workflows,
          activeRequestId: current.activeRequestId === requestId ? fallbackRequest.id : current.activeRequestId
        };
      });
      setResult(null);
    });
  }

  function replaceToken(accessToken: AccessToken) {
    setWorkspace((current) => ({
      ...current,
      accessTokens: current.accessTokens.map((item) => (item.id === accessToken.id ? accessToken : item))
    }));
  }

  async function saveTokenValue(accessToken: AccessToken) {
    if (!accessToken.value) return;
    replaceToken({ ...accessToken, hasValue: true });
    try {
      await api.saveSecret(tokenSecretKey(accessToken.id), accessToken.value);
      const savedValue = await api.loadSecret(tokenSecretKey(accessToken.id));
      if (savedValue !== accessToken.value) {
        throw new Error("토큰 저장 확인에 실패했습니다.");
      }
      setSaveError(null);
    } catch (error) {
      console.warn("Failed to save token secret", error);
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  function deleteToken(tokenId: string) {
    const tokenName = deleteTargetName(workspace.accessTokens.find((item) => item.id === tokenId)?.name, "선택한 토큰");
    confirmDelete("토큰 \"" + tokenName + "\"을 삭제할까요?", async () => {
      setWorkspace((current) => {
        const accessTokens = current.accessTokens.filter((item) => item.id !== tokenId);
        return {
          ...current,
          accessTokens,
          activeTokenId: current.activeTokenId === tokenId ? accessTokens[0]?.id || "" : current.activeTokenId,
          requests: current.requests.map((request) => (request.authTokenId === tokenId ? { ...request, authTokenId: "" } : request))
        };
      });
      try {
        await api.deleteSecret(tokenSecretKey(tokenId));
      } catch (error) {
        console.warn("Failed to delete token secret", error);
      }
    });
  }

  function replaceWorkflow(workflow: Workflow) {
    setWorkspace((current) => ({
      ...current,
      workflows: current.workflows.map((item) => (item.id === workflow.id ? workflow : item))
    }));
  }

  function addServer() {
    const next: ServerProfile = {
      id: id("server"),
      name: "새 서버",
      baseUrl: "https://api.example.com",
      headers: [kv("Accept", "application/json")],
      variables: []
    };
    setWorkspace((current) => ({
      ...current,
      activeServerId: next.id,
      servers: [...current.servers, next]
    }));
    setView("servers");
  }

  function addRequest() {
    const next: ApiRequest = {
      id: id("request"),
      name: "새 API",
      method: "GET",
      path: "/",
      pathParams: [],
      authTokenId: "",
      query: [],
      headers: [],
      bodyMode: "raw",
      body: "",
      multipartFields: []
    };
    setWorkspace((current) => ({
      ...current,
      activeRequestId: next.id,
      requests: [...current.requests, next]
    }));
    setView("requests");
  }

  function addToken() {
    const next = token();
    setWorkspace((current) => ({
      ...current,
      activeTokenId: next.id,
      accessTokens: [...current.accessTokens, next]
    }));
    setView("tokens");
  }

  function addWorkflowStep() {
    const firstRequest = workspace.requests[0];
    if (!firstRequest || !activeWorkflow) return;
    replaceWorkflow({
      ...activeWorkflow,
      steps: [
        ...activeWorkflow.steps,
        {
          id: id("step"),
          name: firstRequest.name,
          requestId: firstRequest.id,
          enabled: true,
          extractRules: []
        }
      ]
    });
  }

  async function runWorkflowNow() {
    if (!activeWorkflow || !activeServer) return;
    setIsRunning(true);
    setSelectedResultIndex(0);
    try {
      const next = await api.runWorkflow({
        workspace,
        workflowId: activeWorkflow.id,
        serverId: activeServer.id
      });
      setResult(next);
    } finally {
      setIsRunning(false);
    }
  }

  async function runSingleRequest() {
    if (!activeRequest || !activeServer) return;
    setIsRunning(true);
    setSelectedResultIndex(0);
    try {
      const executionRequest = {
        ...activeRequest,
        authTokenId: activeRequest.authTokenId || activeToken?.id || ""
      };
      const single = await api.sendRequest({
        server: activeServer,
        request: executionRequest,
        accessTokens: workspace.accessTokens,
        runtimeVariables: {},
        extractRules: []
      });
      setResult({ ok: single.ok, results: [{ ...single, stepName: activeRequest.name }], variables: single.extracted });
    } finally {
      setIsRunning(false);
    }
  }

  function resetWorkspace() {
    const next = seedWorkspace();
    setWorkspace(next);
    setResult(null);
    setSelectedResultIndex(0);
    setView("requests");
    setResetConfirmText("");
    setIsResetDialogOpen(false);
  }

  function openResetWorkspaceDialog() {
    setResetConfirmPhrase(createResetConfirmPhrase());
    setResetConfirmText("");
    setIsResetDialogOpen(true);
  }

  function cancelResetWorkspace() {
    setResetConfirmText("");
    setIsResetDialogOpen(false);
  }

  function cancelDeleteConfirm() {
    setDeleteConfirm(null);
  }

  async function confirmPendingDelete() {
    const current = deleteConfirm;
    if (!current) return;
    setDeleteConfirm(null);
    await current.onConfirm();
  }

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">B2C</div>
          <div>
            <strong>API Workbench</strong>
            <span>{saveError ? "저장 실패" : isSaving ? "저장 중" : "로컬 저장됨"}</span>
          </div>
        </div>

        <nav className="nav">
          <button className={view === "requests" ? "active" : ""} onClick={() => setView("requests")}>
            <FileJson size={17} /> API
          </button>
          <button className={view === "servers" ? "active" : ""} onClick={() => setView("servers")}>
            <Server size={17} /> 서버
          </button>
          <button className={view === "tokens" ? "active" : ""} onClick={() => setView("tokens")}>
            <KeyRound size={17} /> 토큰
          </button>
        </nav>

        <div className="rail-section">
          <div className="section-title">
            <span>서버</span>
            <button className="icon-button" onClick={addServer} title="서버 추가">
              <Plus size={15} />
            </button>
          </div>
          <List
            items={workspace.servers}
            activeId={activeServer?.id}
            onSelect={(activeServerId) => {
              updateWorkspace({ activeServerId });
              setView("servers");
            }}
            getMeta={(item) => item.baseUrl}
          />
        </div>

        <div className="rail-section">
          <div className="section-title">
            <span>토큰</span>
            <button className="icon-button" onClick={addToken} title="토큰 추가">
              <Plus size={15} />
            </button>
          </div>
          <List
            items={workspace.accessTokens}
            activeId={activeToken?.id}
            onSelect={(activeTokenId) => {
              updateWorkspace({ activeTokenId });
              setView("tokens");
            }}
            getMeta={(item) => (item.hasValue || item.value ? "저장됨" : "값 없음")}
          />
        </div>

        <div className="rail-section fill">
          <div className="section-title">
            <span>API</span>
            <button className="icon-button" onClick={addRequest} title="API 추가">
              <Plus size={15} />
            </button>
          </div>
          <List
            items={workspace.requests}
            activeId={activeRequest?.id}
            onSelect={(activeRequestId) => {
              updateWorkspace({ activeRequestId });
              setView("requests");
            }}
            getMeta={(item) => `${item.method} ${item.path}`}
          />
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>API 테스트 콘솔</h1>
            <div className="topbar-meta">
              <span>{activeServer?.name || "서버 없음"}</span>
              <span>{activeRequest ? `${activeRequest.method} ${activeRequest.path}` : "API 없음"}</span>
              <span>{activeToken ? activeToken.name : "토큰 없음"}</span>
            </div>
          </div>
          <div className="topbar-actions">
            <button className="secondary" onClick={openResetWorkspaceDialog} disabled={isRunning}>
              <RefreshCw size={16} /> 샘플 초기화
            </button>
            <button className="primary" onClick={runSingleRequest} disabled={isRunning}>
              {isRunning ? <RefreshCw className="spin" size={16} /> : <Play size={16} />}
              API 실행
            </button>
          </div>
        </header>

        <div className="content">
          <section className="editor-pane">
            {view === "servers" && activeServer && (
              <ServerEditor server={activeServer} onChange={replaceServer} onDelete={() => deleteServer(activeServer.id)} />
            )}
            {view === "requests" && activeRequest && (
              <RequestEditor
                request={activeRequest}
                accessTokens={workspace.accessTokens}
                onChange={replaceRequest}
                onDelete={() => deleteRequest(activeRequest.id)}
              />
            )}
            {view === "tokens" && (
              <TokenEditor
                tokens={workspace.accessTokens}
                activeTokenId={workspace.activeTokenId}
                onChange={replaceToken}
                onSaveValue={saveTokenValue}
                onAdd={addToken}
                onDelete={deleteToken}
              />
            )}
          </section>

          <section className="result-pane">
            <div className="result-header">
              <div>
                <p className="eyebrow">run output</p>
                <h2>실행 로그</h2>
              </div>
              <StatusBadge state={isRunning ? "running" : result?.ok === false ? "failed" : result?.ok ? "passed" : "idle"} />
            </div>

            {result ? (
              <>
                <div className="step-tabs">
                  {result.results.map((item, index) => (
                    <button
                      key={`${item.stepId || item.url}-${index}`}
                      className={index === selectedResultIndex ? "active" : ""}
                      onClick={() => setSelectedResultIndex(index)}
                    >
                      {item.ok ? <Check size={14} /> : <X size={14} />}
                      {item.stepName || item.requestName || `Step ${index + 1}`}
                    </button>
                  ))}
                </div>

                {selectedResult && <ResultDetail result={selectedResult} />}

                <div className="variables-strip">
                  <strong>추출 변수</strong>
                  {Object.keys(result.variables).length === 0 ? (
                    <span>아직 저장된 런타임 변수가 없습니다.</span>
                  ) : (
                    Object.entries(result.variables).map(([key, value]) => (
                      <code key={key}>
                        {key}=<span>{value}</span>
                      </code>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <Database size={36} />
                <h3>아직 실행 결과가 없습니다</h3>
                <p>API 실행을 누르면 상태, 요청 전문, 응답 본문이 여기에 표시됩니다.</p>
              </div>
            )}
          </section>
        </div>
      </section>

      {deleteConfirm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={cancelDeleteConfirm}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-dialog-header">
              <div>
                <h2 id="delete-dialog-title">삭제 확인</h2>
                <p>{deleteConfirm.message}</p>
              </div>
              <button className="icon-button" onClick={cancelDeleteConfirm} title="닫기">
                <X size={15} />
              </button>
            </div>
            <div className="confirm-warning">삭제 후에는 되돌릴 수 없습니다.</div>
            <div className="confirm-actions">
              <button className="secondary" onClick={cancelDeleteConfirm}>
                취소
              </button>
              <button className="primary danger-primary" onClick={confirmPendingDelete}>
                삭제
              </button>
            </div>
          </section>
        </div>
      )}

      {isResetDialogOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={cancelResetWorkspace}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-dialog-header">
              <div>
                <h2 id="reset-dialog-title">샘플 데이터로 초기화</h2>
                <p>현재 등록된 서버, API, 토큰 목록과 실행 결과가 샘플 데이터로 덮어쓰기 됩니다.</p>
              </div>
              <button className="icon-button" onClick={cancelResetWorkspace} title="닫기">
                <X size={15} />
              </button>
            </div>
            <div className="confirm-warning">
              이 작업은 현재 화면의 설정을 되돌릴 수 없습니다. 계속하려면 아래 8자리 확인 코드를 그대로 입력하세요:
              <strong className="confirm-code">{resetConfirmPhrase}</strong>
            </div>
            <Field label="확인 문자열">
              <input
                autoFocus
                value={resetConfirmText}
                onChange={(event) => setResetConfirmText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") cancelResetWorkspace();
                  if (event.key === "Enter" && resetConfirmText.trim() === resetConfirmPhrase) resetWorkspace();
                }}
                placeholder="대소문자 구분"
              />
            </Field>
            <div className="confirm-actions">
              <button className="secondary" onClick={cancelResetWorkspace}>
                취소
              </button>
              <button className="primary danger-primary" onClick={resetWorkspace} disabled={resetConfirmText.trim() !== resetConfirmPhrase}>
                샘플로 덮어쓰기
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function List<T extends { id: string; name: string }>({
  items,
  activeId,
  onSelect,
  getMeta
}: {
  items: T[];
  activeId?: string;
  onSelect: (id: string) => void;
  getMeta: (item: T) => string;
}) {
  return (
    <div className="list">
      {items.map((item) => (
        <button key={item.id} className={item.id === activeId ? "selected" : ""} onClick={() => onSelect(item.id)}>
          <span>{item.name}</span>
          <small>{getMeta(item)}</small>
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function KeyValueEditor({
  title,
  rows,
  onChange,
  keyPlaceholder = "key",
  valuePlaceholder = "value"
}: {
  title: string;
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  function patchRow(index: number, patch: Partial<KeyValue>) {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="kv-editor">
      <div className="block-title">
        <strong>{title}</strong>
        <button className="ghost" onClick={() => onChange([...rows, kv()])}>
          <Plus size={15} /> 추가
        </button>
      </div>
      {rows.length === 0 && <p className="hint">등록된 항목이 없습니다.</p>}
      {rows.map((row, index) => (
        <div className="kv-row" key={row.id}>
          <button className={row.enabled ? "toggle on" : "toggle"} onClick={() => patchRow(index, { enabled: !row.enabled })} title="활성화 전환">
            {row.enabled ? <Check size={13} /> : <X size={13} />}
          </button>
          <input value={row.key} onChange={(event) => patchRow(index, { key: event.target.value })} placeholder={keyPlaceholder} />
          <input value={row.value} onChange={(event) => patchRow(index, { value: event.target.value })} placeholder={valuePlaceholder} />
          <button
            className="icon-button danger"
            onClick={() => {
              const rowName = deleteTargetName(row.key || row.value, title + " 항목 " + (index + 1));
              confirmDelete(title + " 항목 \"" + rowName + "\"을 삭제할까요?", () => {
                onChange(rows.filter((_, rowIndex) => rowIndex !== index));
              });
            }}
            title="삭제"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ServerEditor({ server, onChange, onDelete }: { server: ServerProfile; onChange: (server: ServerProfile) => void; onDelete: () => void }) {
  return (
    <div className="form-stack">
      <div className="pane-heading">
        <Server size={22} />
        <div>
          <h2>서버 정보</h2>
          <p>base URL, 공통 헤더, 배치에서 사용할 기본 변수를 저장합니다.</p>
        </div>
        <button className="secondary danger-action" onClick={onDelete}>
          <Trash2 size={16} /> 서버 삭제
        </button>
      </div>
      <div className="two-col">
        <Field label="서버 이름">
          <input value={server.name} onChange={(event) => onChange({ ...server, name: event.target.value })} />
        </Field>
        <Field label="Base URL">
          <input value={server.baseUrl} onChange={(event) => onChange({ ...server, baseUrl: event.target.value })} placeholder="https://api.company.com" />
        </Field>
      </div>
      <KeyValueEditor title="공통 헤더" rows={server.headers} onChange={(headers) => onChange({ ...server, headers })} keyPlaceholder="Authorization" valuePlaceholder="Bearer {{token}}" />
      <KeyValueEditor title="서버 변수" rows={server.variables} onChange={(variables) => onChange({ ...server, variables })} keyPlaceholder="username" valuePlaceholder="demo" />
    </div>
  );
}

function RequestEditor({
  request,
  accessTokens,
  onChange,
  onDelete
}: {
  request: ApiRequest;
  accessTokens: AccessToken[];
  onChange: (request: ApiRequest) => void;
  onDelete: () => void;
}) {
  const pathParams = syncPathParams(request.path, request.pathParams);

  function changePath(path: string) {
    onChange({ ...request, path, pathParams: syncPathParams(path, request.pathParams) });
  }

  return (
    <div className="form-stack">
      <div className="pane-heading">
        <FileJson size={22} />
        <div>
          <h2>API 템플릿</h2>
          <p>경로와 본문에서 {"{{변수명}}"} 형식으로 서버 변수나 이전 단계 추출값을 사용할 수 있습니다.</p>
        </div>
        <button className="secondary danger-action" onClick={onDelete}>
          <Trash2 size={16} /> API 삭제
        </button>
      </div>
      <div className="request-line">
        <select value={request.method} onChange={(event) => onChange({ ...request, method: event.target.value as HttpMethod })}>
          {methods.map((method) => (
            <option key={method}>{method}</option>
          ))}
        </select>
        <input value={request.path} onChange={(event) => changePath(event.target.value)} placeholder="/api/users/{memberId}" />
      </div>
      <div className="two-col">
        <Field label="API 이름">
          <input value={request.name} onChange={(event) => onChange({ ...request, name: event.target.value })} />
        </Field>
        <Field label="사용 토큰">
          <select value={request.authTokenId || ""} onChange={(event) => onChange({ ...request, authTokenId: event.target.value })}>
            <option value="">토큰 없음</option>
            {accessTokens.map((accessToken) => (
              <option value={accessToken.id} key={accessToken.id}>
                {accessToken.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <PathParamEditor rows={pathParams} onChange={(pathParams) => onChange({ ...request, pathParams })} />
      <KeyValueEditor title="Query" rows={request.query} onChange={(query) => onChange({ ...request, query })} keyPlaceholder="page" valuePlaceholder="1" />
      <KeyValueEditor title="Headers" rows={request.headers} onChange={(headers) => onChange({ ...request, headers })} keyPlaceholder="Content-Type" valuePlaceholder="application/json" />
      <Field label="Body 종류">
        <select value={request.bodyMode || "raw"} onChange={(event) => onChange({ ...request, bodyMode: event.target.value as ApiRequest["bodyMode"] })}>
          <option value="raw">Raw</option>
          <option value="multipart">Multipart</option>
        </select>
      </Field>
      {(request.bodyMode || "raw") === "multipart" ? (
        <MultipartFieldEditor rows={request.multipartFields || []} onChange={(multipartFields) => onChange({ ...request, multipartFields })} />
      ) : (
        <Field label="Body">
          <textarea value={request.body} onChange={(event) => onChange({ ...request, body: event.target.value })} spellCheck={false} placeholder='{"token":"{{token}}"}' />
        </Field>
      )}
    </div>
  );
}

function TokenEditor({
  tokens,
  activeTokenId,
  onChange,
  onSaveValue,
  onAdd,
  onDelete
}: {
  tokens: AccessToken[];
  activeTokenId: string;
  onChange: (accessToken: AccessToken) => void;
  onSaveValue: (accessToken: AccessToken) => Promise<void>;
  onAdd: () => void;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const activeToken = tokens.find((item) => item.id === activeTokenId) || tokens[0];

  if (!activeToken) {
    return (
      <div className="form-stack">
        <div className="pane-heading">
          <KeyRound size={22} />
          <div>
            <h2>액세스 토큰</h2>
            <p>API 호출에 사용할 Bearer 토큰을 로컬에 저장합니다.</p>
          </div>
        </div>
        <button className="primary fit" onClick={onAdd}>
          <Plus size={16} /> 토큰 추가
        </button>
      </div>
    );
  }

  return (
    <div className="form-stack">
      <div className="pane-heading">
        <KeyRound size={22} />
        <div>
          <h2>액세스 토큰</h2>
          <p>선택한 API에는 `authorization: Bearer ...` 헤더가 자동으로 들어갑니다.</p>
        </div>
        <button className="secondary danger-action" onClick={() => onDelete(activeToken.id)}>
          <Trash2 size={16} /> 토큰 삭제
        </button>
      </div>

      <div className="two-col">
        <Field label="토큰 이름">
          <input value={activeToken.name} onChange={(event) => onChange({ ...activeToken, name: event.target.value })} placeholder="개발 서버 관리자 토큰" />
        </Field>
        <Field label="저장 상태">
          <input value={activeToken.hasValue || activeToken.value ? "저장됨" : "값 없음"} readOnly />
        </Field>
      </div>

      <Field label="토큰 값">
        <input
          value={activeToken.value}
          onChange={(event) => {
            const next = { ...activeToken, value: event.target.value, hasValue: Boolean(event.target.value) || activeToken.hasValue };
            onChange(next);
          }}
          onBlur={(event) => onSaveValue({ ...activeToken, value: event.target.value, hasValue: Boolean(event.target.value) || activeToken.hasValue })}
          placeholder={activeToken.hasValue ? "저장된 토큰을 변경하려면 새 값을 입력하세요" : "eyJhbGciOi..."}
          type="password"
        />
      </Field>

      <div className="token-actions">
        <span>Bearer 접두어는 호출 시 자동으로 추가됩니다.</span>
        <button className="secondary" onClick={() => onSaveValue(activeToken)} disabled={!activeToken.value}>
          <Save size={16} /> 토큰 저장
        </button>
      </div>
    </div>
  );
}

function PathParamEditor({ rows, onChange }: { rows: KeyValue[]; onChange: (rows: KeyValue[]) => void }) {
  function patchRow(index: number, patch: Partial<KeyValue>) {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="path-param-editor">
      <div className="block-title">
        <strong>Path Params</strong>
        <span>{rows.length ? `${rows.length}개 감지됨` : "경로에서 자동 감지"}</span>
      </div>
      {rows.length === 0 && <p className="hint">경로에 {"{memberId}"} 또는 :memberId 형식의 파라미터를 넣으면 입력 항목이 생성됩니다.</p>}
      {rows.map((row, index) => (
        <div className="path-param-row" key={row.id}>
          <button className={row.enabled ? "toggle on" : "toggle"} onClick={() => patchRow(index, { enabled: !row.enabled })} title="활성화 전환">
            {row.enabled ? <Check size={13} /> : <X size={13} />}
          </button>
          <code>{row.key}</code>
          <input value={row.value} onChange={(event) => patchRow(index, { value: event.target.value })} placeholder={`{{${row.key}}}`} />
        </div>
      ))}
    </div>
  );
}

function MultipartFieldEditor({ rows, onChange }: { rows: MultipartField[]; onChange: (rows: MultipartField[]) => void }) {
  function patchRow(index: number, patch: Partial<MultipartField>) {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function deleteRow(index: number) {
    onChange(rows.filter((_, rowIndex) => rowIndex !== index));
  }

  return (
    <div className="multipart-editor">
      <div className="block-title">
        <strong>Multipart Parts</strong>
        <button className="ghost" onClick={() => onChange([...rows, multipartField()])}>
          <Plus size={15} /> 파트 추가
        </button>
      </div>
      {rows.map((row, index) => (
        <div className="multipart-row" key={row.id}>
          <button className={row.enabled ? "toggle on" : "toggle"} onClick={() => patchRow(index, { enabled: !row.enabled })} title="활성화 전환">
            {row.enabled ? <Check size={13} /> : <X size={13} />}
          </button>
          <input value={row.name} onChange={(event) => patchRow(index, { name: event.target.value })} placeholder="request" />
          <input value={row.contentType} onChange={(event) => patchRow(index, { contentType: event.target.value })} placeholder="application/json" />
          <button className="icon danger" onClick={() => deleteRow(index)} title="삭제">
            <Trash2 size={14} />
          </button>
          <textarea value={row.value} onChange={(event) => patchRow(index, { value: event.target.value })} spellCheck={false} placeholder='{"categoryId":30}' />
        </div>
      ))}
    </div>
  );
}

function WorkflowEditor({
  workspace,
  workflow,
  onChange,
  onAddStep,
  onSelectRequest
}: {
  workspace: Workspace;
  workflow: Workflow;
  onChange: (workflow: Workflow) => void;
  onAddStep: () => void;
  onSelectRequest: (id: string) => void;
}) {
  function patchStep(index: number, patch: Partial<Workflow["steps"][number]>) {
    onChange({
      ...workflow,
      steps: workflow.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step))
    });
  }

  return (
    <div className="form-stack">
      <div className="pane-heading">
        <WorkflowIcon size={22} />
        <div>
          <h2>배치 워크플로</h2>
          <p>토큰 발급, 값 추출, 후속 API 호출을 순서대로 배치합니다.</p>
        </div>
      </div>
      <div className="two-col">
        <Field label="배치 이름">
          <input value={workflow.name} onChange={(event) => onChange({ ...workflow, name: event.target.value })} />
        </Field>
        <Field label="실행 서버">
          <select value={workflow.serverId} onChange={(event) => onChange({ ...workflow, serverId: event.target.value })}>
            {workspace.servers.map((server) => (
              <option value={server.id} key={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="block-title">
        <strong>실행 단계</strong>
        <button className="ghost" onClick={onAddStep}>
          <Plus size={15} /> 단계 추가
        </button>
      </div>

      <div className="workflow-steps">
        {workflow.steps.map((step, index) => {
          const request = workspace.requests.find((item) => item.id === step.requestId);
          return (
            <div className="step-editor" key={step.id}>
              <div className="step-number">{index + 1}</div>
              <div className="step-body">
                <div className="step-line">
                  <button className={step.enabled ? "toggle on" : "toggle"} onClick={() => patchStep(index, { enabled: !step.enabled })} title="활성화 전환">
                    {step.enabled ? <Check size={13} /> : <X size={13} />}
                  </button>
                  <input value={step.name} onChange={(event) => patchStep(index, { name: event.target.value })} />
                  <select value={step.requestId} onChange={(event) => patchStep(index, { requestId: event.target.value })}>
                    {workspace.requests.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {request && (
                    <button className="icon-button" onClick={() => onSelectRequest(request.id)} title="API 편집">
                      <Settings2 size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button danger"
                    onClick={() => {
                      const stepName = deleteTargetName(step.name, "단계 " + (index + 1));
                      confirmDelete("워크플로 단계 \"" + stepName + "\"를 삭제할까요?", () => {
                        onChange({ ...workflow, steps: workflow.steps.filter((_, stepIndex) => stepIndex !== index) });
                      });
                    }}
                    title="단계 삭제"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <ExtractRuleEditor
                  rules={step.extractRules}
                  onChange={(extractRules) => patchStep(index, { extractRules })}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExtractRuleEditor({ rules, onChange }: { rules: ExtractRule[]; onChange: (rules: ExtractRule[]) => void }) {
  function patchRule(index: number, patch: Partial<ExtractRule>) {
    onChange(rules.map((item, ruleIndex) => (index === ruleIndex ? { ...item, ...patch } : item)));
  }

  return (
    <div className="extract-editor">
      <div className="block-title slim">
        <span>추출 규칙</span>
        <button className="ghost small" onClick={() => onChange([...rules, rule()])}>
          <Plus size={14} /> 추가
        </button>
      </div>
      {rules.length === 0 && <p className="hint">이 단계에서 추출할 값이 없습니다.</p>}
      {rules.map((item, index) => (
        <div className="extract-row" key={item.id}>
          <button className={item.enabled ? "toggle on" : "toggle"} onClick={() => patchRule(index, { enabled: !item.enabled })} title="활성화 전환">
            {item.enabled ? <Check size={13} /> : <X size={13} />}
          </button>
          <select value={item.source} onChange={(event) => patchRule(index, { source: event.target.value as ExtractRule["source"] })}>
            <option value="json">JSON</option>
            <option value="headers">Header</option>
            <option value="text">Text</option>
          </select>
          <input value={item.path} onChange={(event) => patchRule(index, { path: event.target.value })} placeholder="data.token" />
          <ChevronRight size={15} />
          <input value={item.variable} onChange={(event) => patchRule(index, { variable: event.target.value })} placeholder="token" />
          <button
            className="icon-button danger"
            onClick={() => {
              const ruleName = deleteTargetName(item.name || item.variable, "추출 규칙 " + (index + 1));
              confirmDelete("추출 규칙 \"" + ruleName + "\"을 삭제할까요?", () => {
                onChange(rules.filter((_, ruleIndex) => ruleIndex !== index));
              });
            }}
            title="삭제"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function RunView({
  workspace,
  workflow,
  server,
  onSelectView,
  onSelectWorkflow
}: {
  workspace: Workspace;
  workflow: Workflow;
  server: ServerProfile;
  onSelectView: (view: "servers" | "requests" | "tokens" | "workflow" | "run") => void;
  onSelectWorkflow: (id: string) => void;
}) {
  return (
    <div className="run-board">
      <div className="run-summary">
        <div>
          <p className="eyebrow">selected server</p>
          <h2>{server.name}</h2>
          <code>{server.baseUrl}</code>
        </div>
        <button className="secondary" onClick={() => onSelectView("servers")}>
          <Settings2 size={16} /> 서버 설정
        </button>
      </div>

      <div className="workflow-switcher">
        <Field label="실행할 배치">
          <select value={workflow.id} onChange={(event) => onSelectWorkflow(event.target.value)}>
            {workspace.workflows.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <button className="secondary" onClick={() => onSelectView("workflow")}>
          <WorkflowIcon size={16} /> 배치 편집
        </button>
      </div>

      <div className="flow">
        {workflow.steps.map((step, index) => {
          const request = workspace.requests.find((item) => item.id === step.requestId);
          return (
            <div className="flow-step" key={step.id}>
              <div className="step-number">{index + 1}</div>
              <div>
                <strong>{step.name}</strong>
                <span>{request ? `${request.method} ${request.path}` : "연결된 API 없음"}</span>
              </div>
              <small>{step.extractRules.length ? `${step.extractRules.length}개 추출` : "추출 없음"}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusBadge({ state }: { state: "idle" | "running" | "passed" | "failed" }) {
  const label = {
    idle: "대기",
    running: "실행 중",
    passed: "성공",
    failed: "실패"
  }[state];
  return <span className={`status ${state}`}>{label}</span>;
}

function ResultDetail({ result }: { result: RequestResult }) {
  const parsedBody = safeJson(result.response.body);
  const displayBody = parsedBody ? JSON.stringify(parsedBody, null, 2) : compactBody(result.response.body);
  const displayRequest = requestPreview(result);

  return (
    <div className="result-detail">
      <div className="metric-row">
        <div>
          <span>Status</span>
          <strong className={result.ok ? "good" : "bad"}>
            {result.status || "-"} {result.statusText}
          </strong>
        </div>
        <div>
          <span>Time</span>
          <strong>{result.elapsedMs}ms</strong>
        </div>
        <div>
          <span>URL</span>
          <strong className="truncate">{result.url}</strong>
        </div>
      </div>

      {result.error && <div className="error-line">{result.error}</div>}

      <div className="code-toolbar">
        <span>
          <Braces size={15} /> Request
        </span>
        <button className="icon-button" onClick={() => navigator.clipboard?.writeText(displayRequest)} title="복사">
          <Copy size={15} />
        </button>
      </div>
      <pre className="code-block">{displayRequest}</pre>

      <div className="code-toolbar">
        <span>
          <Braces size={15} /> Response Body
        </span>
        <button className="icon-button" onClick={() => navigator.clipboard?.writeText(displayBody)} title="복사">
          <Copy size={15} />
        </button>
      </div>
      <pre className="code-block">{displayBody || "응답 본문이 없습니다."}</pre>
    </div>
  );
}

export default App;
