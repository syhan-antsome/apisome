use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use url::Url;

const WORKSPACE_ID: &str = "default";
const KEYCHAIN_SERVICE: &str = "B2C API Workbench";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyValue {
    id: String,
    key: String,
    value: String,
    enabled: bool,
    secret: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerProfile {
    id: String,
    name: String,
    base_url: String,
    headers: Vec<KeyValue>,
    variables: Vec<KeyValue>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessToken {
    id: String,
    name: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    has_value: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiRequest {
    id: String,
    name: String,
    method: String,
    path: String,
    #[serde(default)]
    path_params: Vec<KeyValue>,
    #[serde(default)]
    auth_token_id: String,
    #[serde(default)]
    query: Vec<KeyValue>,
    #[serde(default)]
    headers: Vec<KeyValue>,
    #[serde(default)]
    body: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractRule {
    id: String,
    name: String,
    source: String,
    path: String,
    variable: String,
    enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowStep {
    id: String,
    name: String,
    request_id: String,
    enabled: bool,
    extract_rules: Vec<ExtractRule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Workflow {
    id: String,
    name: String,
    server_id: String,
    steps: Vec<WorkflowStep>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    #[serde(default)]
    servers: Vec<ServerProfile>,
    #[serde(default)]
    requests: Vec<ApiRequest>,
    #[serde(default)]
    access_tokens: Vec<AccessToken>,
    #[serde(default)]
    workflows: Vec<Workflow>,
    #[serde(default)]
    active_server_id: String,
    #[serde(default)]
    active_request_id: String,
    #[serde(default)]
    active_token_id: String,
    #[serde(default)]
    active_workflow_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestWire {
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseWire {
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestResult {
    ok: bool,
    status: u16,
    status_text: String,
    elapsed_ms: u128,
    url: String,
    request: Option<RequestWire>,
    response: ResponseWire,
    extracted: HashMap<String, String>,
    error: Option<String>,
    step_id: Option<String>,
    step_name: Option<String>,
    request_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowResult {
    ok: bool,
    results: Vec<RequestResult>,
    variables: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    ok: bool,
    path: String,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve app data directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create app data directory: {error}"))?;
    Ok(dir.join("workspace.sqlite3"))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(path)
        .map_err(|error| format!("Cannot open workspace database: {error}"))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|error| format!("Cannot initialize workspace database: {error}"))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS secret_values (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|error| format!("Cannot initialize local secret storage: {error}"))?;
    Ok(conn)
}

fn now_unix_seconds() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[tauri::command]
fn load_workspace(app: AppHandle) -> Result<Option<Workspace>, String> {
    let conn = open_db(&app)?;
    let mut statement = conn
        .prepare("SELECT data FROM workspace WHERE id = ?1")
        .map_err(|error| format!("Cannot prepare workspace load: {error}"))?;
    let result = statement.query_row(params![WORKSPACE_ID], |row| row.get::<_, String>(0));

    match result {
        Ok(data) => {
            let mut workspace: Workspace = serde_json::from_str(&data)
                .map_err(|error| format!("Cannot parse workspace data: {error}"))?;
            hydrate_access_token_values(&app, &mut workspace);
            Ok(Some(workspace))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Cannot load workspace: {error}")),
    }
}

#[tauri::command]
fn save_workspace(app: AppHandle, mut workspace: Workspace) -> Result<SaveResult, String> {
    let conn = open_db(&app)?;
    persist_access_token_values(&app, &mut workspace)?;
    let mut stored_workspace = workspace.clone();
    clear_access_token_values(&mut stored_workspace);
    let data = serde_json::to_string_pretty(&stored_workspace)
        .map_err(|error| format!("Cannot serialize workspace data: {error}"))?;
    conn.execute(
        "INSERT INTO workspace (id, data, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        params![WORKSPACE_ID, data, now_unix_seconds()],
    )
    .map_err(|error| format!("Cannot save workspace: {error}"))?;

    Ok(SaveResult {
        ok: true,
        path: db_path(&app)?.display().to_string(),
    })
}

#[tauri::command]
fn save_secret(app: AppHandle, key: String, value: String) -> Result<(), String> {
    save_secret_value(&app, &key, &value)
}

#[tauri::command]
fn load_secret(app: AppHandle, key: String) -> Result<Option<String>, String> {
    secret_value(&app, &key)
}

#[tauri::command]
fn delete_secret(app: AppHandle, key: String) -> Result<(), String> {
    delete_secret_value(&app, &key)
}

fn access_token_secret_key(token_id: &str) -> String {
    format!("access-token:{token_id}")
}

fn save_keychain_value(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)
        .map_err(|error| format!("Cannot open OS credential entry: {error}"))?;
    entry
        .set_password(value)
        .map_err(|error| format!("Cannot save OS credential: {error}"))
}

fn keychain_value(key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)
        .map_err(|error| format!("Cannot open OS credential entry: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Cannot load OS credential: {error}")),
    }
}

fn local_secret_value(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    let conn = open_db(app)?;
    let mut statement = conn
        .prepare("SELECT value FROM secret_values WHERE id = ?1")
        .map_err(|error| format!("Cannot prepare local secret load: {error}"))?;
    match statement.query_row(params![key], |row| row.get::<_, String>(0)) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Cannot load local secret: {error}")),
    }
}

fn save_local_secret_value(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO secret_values (id, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_unix_seconds()],
    )
    .map_err(|error| format!("Cannot save local secret: {error}"))?;
    Ok(())
}

fn delete_local_secret_value(app: &AppHandle, key: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM secret_values WHERE id = ?1", params![key])
        .map_err(|error| format!("Cannot delete local secret: {error}"))?;
    Ok(())
}

fn save_secret_value(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    save_local_secret_value(app, key, value)?;
    let _ = save_keychain_value(key, value);
    Ok(())
}

fn secret_value(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    match local_secret_value(app, key)? {
        Some(value) if !value.is_empty() => Ok(Some(value)),
        _ => keychain_value(key),
    }
}

fn delete_secret_value(app: &AppHandle, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)
        .map_err(|error| format!("Cannot open OS credential entry: {error}"));
    if let Ok(entry) = entry {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {}
        }
    }
    delete_local_secret_value(app, key)
}

fn hydrate_access_token_values(app: &AppHandle, workspace: &mut Workspace) {
    for access_token in &mut workspace.access_tokens {
        if !access_token.value.is_empty() {
            access_token.has_value = true;
            continue;
        }

        if let Ok(Some(value)) = secret_value(app, &access_token_secret_key(&access_token.id)) {
            if !value.is_empty() {
                access_token.value = value;
                access_token.has_value = true;
            }
        }
    }
}

fn persist_access_token_values(app: &AppHandle, workspace: &mut Workspace) -> Result<(), String> {
    for access_token in &mut workspace.access_tokens {
        if access_token.value.is_empty() {
            continue;
        }

        save_secret_value(
            app,
            &access_token_secret_key(&access_token.id),
            &access_token.value,
        )?;
        access_token.has_value = true;
    }

    Ok(())
}

fn clear_access_token_values(workspace: &mut Workspace) {
    for access_token in &mut workspace.access_tokens {
        access_token.value.clear();
    }
}

fn active_pairs(rows: &[KeyValue]) -> impl Iterator<Item = &KeyValue> {
    rows.iter().filter(|row| row.enabled && !row.key.is_empty())
}

fn interpolate(value: &str, vars: &HashMap<String, String>) -> String {
    let pattern =
        Regex::new(r"\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}").expect("valid interpolation regex");
    pattern
        .replace_all(value, |captures: &regex::Captures| {
            vars.get(&captures[1]).cloned().unwrap_or_default()
        })
        .to_string()
}

fn variable_map(
    server: &ServerProfile,
    runtime_variables: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    for row in active_pairs(&server.variables) {
        vars.insert(row.key.clone(), row.value.clone());
    }
    vars.extend(runtime_variables.clone());
    vars
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn path_param_value(name: &str, request: &ApiRequest, vars: &HashMap<String, String>) -> String {
    request
        .path_params
        .iter()
        .find(|row| row.enabled && row.key == name)
        .map(|row| interpolate(&row.value, vars))
        .or_else(|| vars.get(name).cloned())
        .unwrap_or_default()
}

fn apply_path_params(path: &str, request: &ApiRequest, vars: &HashMap<String, String>) -> String {
    let curly_pattern = Regex::new(r"\{([a-zA-Z0-9_.-]+)\}").expect("valid path param regex");
    let colon_pattern =
        Regex::new(r"(^|/):([a-zA-Z0-9_.-]+)").expect("valid colon path param regex");
    let with_curly = curly_pattern
        .replace_all(path, |captures: &regex::Captures| {
            encode_path_segment(&path_param_value(&captures[1], request, vars))
        })
        .to_string();

    colon_pattern
        .replace_all(&with_curly, |captures: &regex::Captures| {
            format!(
                "{}{}",
                &captures[1],
                encode_path_segment(&path_param_value(&captures[2], request, vars))
            )
        })
        .to_string()
}

fn build_url(
    server: &ServerProfile,
    request: &ApiRequest,
    vars: &HashMap<String, String>,
) -> Result<Url, String> {
    let base = if server.base_url.ends_with('/') {
        server.base_url.clone()
    } else {
        format!("{}/", server.base_url)
    };
    let base_url = Url::parse(&interpolate(&base, vars))
        .map_err(|error| format!("Invalid base URL: {error}"))?;
    let path = apply_path_params(&interpolate(&request.path, vars), request, vars);
    let mut url = base_url
        .join(&path)
        .map_err(|error| format!("Invalid request path: {error}"))?;

    {
        let mut query = url.query_pairs_mut();
        for row in active_pairs(&request.query) {
            query.append_pair(&interpolate(&row.key, vars), &interpolate(&row.value, vars));
        }
    }

    Ok(url)
}

fn build_headers(
    server: &ServerProfile,
    request: &ApiRequest,
    vars: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    for row in active_pairs(&server.headers) {
        headers.insert(interpolate(&row.key, vars), interpolate(&row.value, vars));
    }
    for row in active_pairs(&request.headers) {
        headers.insert(interpolate(&row.key, vars), interpolate(&row.value, vars));
    }
    headers
}

fn apply_auth_token_header(
    app: &AppHandle,
    headers: &mut HashMap<String, String>,
    request: &ApiRequest,
    access_tokens: &[AccessToken],
    vars: &HashMap<String, String>,
) -> Result<(), String> {
    if request.auth_token_id.is_empty() {
        return Ok(());
    }

    let Some(access_token) = access_tokens
        .iter()
        .find(|token| token.id == request.auth_token_id)
    else {
        return Ok(());
    };
    let token_value = if !access_token.value.is_empty() {
        Some(access_token.value.clone())
    } else {
        secret_value(app, &access_token_secret_key(&access_token.id))?
    };
    let Some(token_value) = token_value else {
        return Ok(());
    };
    if token_value.is_empty() {
        return Ok(());
    }

    headers.retain(|key, _| key.to_lowercase() != "authorization");
    headers.insert(
        "authorization".to_string(),
        format!("Bearer {}", interpolate(&token_value, vars)),
    );
    Ok(())
}

fn json_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let normalized = Regex::new(r"\[(\d+)\]")
        .expect("valid json path regex")
        .replace_all(path, ".$1")
        .to_string();
    let mut current = value;
    for part in normalized.split('.').filter(|part| !part.is_empty()) {
        current = current.get(part)?;
    }
    Some(current)
}

fn apply_extract_rules(
    rules: &[ExtractRule],
    response_body: &str,
    response_headers: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut extracted = HashMap::new();
    let json = serde_json::from_str::<Value>(response_body).ok();
    let normalized_headers = response_headers
        .iter()
        .map(|(key, value)| (key.to_lowercase(), value.clone()))
        .collect::<HashMap<_, _>>();

    for rule in rules
        .iter()
        .filter(|rule| rule.enabled && !rule.variable.is_empty())
    {
        let value = match rule.source.as_str() {
            "headers" => normalized_headers.get(&rule.path.to_lowercase()).cloned(),
            "text" => Regex::new(&rule.path)
                .ok()
                .and_then(|regex| regex.captures(response_body))
                .and_then(|captures| {
                    captures
                        .get(1)
                        .or_else(|| captures.get(0))
                        .map(|item| item.as_str().to_string())
                }),
            _ => json
                .as_ref()
                .and_then(|json| json_path(json, &rule.path))
                .map(|value| {
                    value
                        .as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| value.to_string())
                }),
        };

        if let Some(value) = value {
            extracted.insert(rule.variable.clone(), value);
        }
    }

    extracted
}

fn mock_response(
    url: &Url,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> (u16, String, HashMap<String, String>, String) {
    let request_json = body
        .and_then(|body| serde_json::from_str::<Value>(body).ok())
        .unwrap_or(Value::Null);
    let username = request_json
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("demo");
    let payload = if url.path().contains("auth/login") || url.path().contains("generate-token") {
        serde_json::json!({
            "token": format!("mock-token-{username}"),
            "expiresIn": 3600,
            "userId": format!("user-{username}"),
            "issuedAt": now_unix_seconds()
        })
    } else {
        serde_json::json!({
            "profile": {
                "id": format!("user-{username}"),
                "name": "Demo User",
                "role": "tester"
            },
            "authorization": headers
                .get("Authorization")
                .or_else(|| headers.get("authorization"))
                .cloned()
                .unwrap_or_default(),
            "path": url.path()
        })
    };
    let mut response_headers = HashMap::new();
    response_headers.insert("content-type".to_string(), "application/json".to_string());
    response_headers.insert("x-workbench-mock".to_string(), "true".to_string());
    (
        200,
        "OK".to_string(),
        response_headers,
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    )
}

#[tauri::command]
async fn send_request(
    app: AppHandle,
    server: ServerProfile,
    request: ApiRequest,
    access_tokens: Option<Vec<AccessToken>>,
    runtime_variables: Option<HashMap<String, String>>,
    extract_rules: Option<Vec<ExtractRule>>,
) -> Result<RequestResult, String> {
    execute_request(
        &app,
        &server,
        &request,
        &access_tokens.unwrap_or_default(),
        &runtime_variables.unwrap_or_default(),
        &extract_rules.unwrap_or_default(),
    )
    .await
}

async fn execute_request(
    app: &AppHandle,
    server: &ServerProfile,
    request: &ApiRequest,
    access_tokens: &[AccessToken],
    runtime_variables: &HashMap<String, String>,
    extract_rules: &[ExtractRule],
) -> Result<RequestResult, String> {
    let vars = variable_map(server, runtime_variables);
    let url = build_url(server, request, &vars)?;
    let mut headers = build_headers(server, request, &vars);
    apply_auth_token_header(app, &mut headers, request, access_tokens, &vars)?;
    let method = request.method.to_uppercase();
    let body = if matches!(method.as_str(), "GET" | "HEAD") || request.body.is_empty() {
        None
    } else {
        Some(interpolate(&request.body, &vars))
    };
    let started_at = Instant::now();

    if url.scheme() == "mock" {
        let (status, status_text, response_headers, response_body) =
            mock_response(&url, &headers, body.as_deref());
        let extracted = apply_extract_rules(extract_rules, &response_body, &response_headers);
        return Ok(RequestResult {
            ok: true,
            status,
            status_text,
            elapsed_ms: started_at.elapsed().as_millis(),
            url: url.to_string(),
            request: Some(RequestWire {
                method,
                headers,
                body,
            }),
            response: ResponseWire {
                headers: response_headers,
                body: response_body,
            },
            extracted,
            error: None,
            step_id: None,
            step_name: None,
            request_name: None,
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Cannot create HTTP client: {error}"))?;
    let reqwest_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let mut builder = client.request(reqwest_method, url.clone());
    for (key, value) in &headers {
        builder = builder.header(key, value);
    }
    if let Some(body) = &body {
        builder = builder.body(body.clone());
    }

    let wire_request = RequestWire {
        method,
        headers,
        body,
    };

    match builder.send().await {
        Ok(response) => {
            let status = response.status();
            let response_headers = response
                .headers()
                .iter()
                .map(|(key, value)| {
                    (
                        key.to_string(),
                        value.to_str().unwrap_or_default().to_string(),
                    )
                })
                .collect::<HashMap<_, _>>();
            let response_body = response.text().await.unwrap_or_default();
            let extracted = apply_extract_rules(extract_rules, &response_body, &response_headers);
            Ok(RequestResult {
                ok: status.is_success(),
                status: status.as_u16(),
                status_text: status.canonical_reason().unwrap_or_default().to_string(),
                elapsed_ms: started_at.elapsed().as_millis(),
                url: url.to_string(),
                request: Some(wire_request),
                response: ResponseWire {
                    headers: response_headers,
                    body: response_body,
                },
                extracted,
                error: None,
                step_id: None,
                step_name: None,
                request_name: None,
            })
        }
        Err(error) => Ok(RequestResult {
            ok: false,
            status: 0,
            status_text: "Network error".to_string(),
            elapsed_ms: started_at.elapsed().as_millis(),
            url: url.to_string(),
            request: Some(wire_request),
            response: ResponseWire {
                headers: HashMap::new(),
                body: String::new(),
            },
            extracted: HashMap::new(),
            error: Some(error.to_string()),
            step_id: None,
            step_name: None,
            request_name: None,
        }),
    }
}

#[tauri::command]
async fn run_workflow(
    app: AppHandle,
    workspace: Workspace,
    workflow_id: String,
    server_id: String,
) -> Result<WorkflowResult, String> {
    let workflow = workspace
        .workflows
        .iter()
        .find(|workflow| workflow.id == workflow_id)
        .ok_or_else(|| "Workflow not found".to_string())?;
    let server = workspace
        .servers
        .iter()
        .find(|server| server.id == server_id || server.id == workflow.server_id)
        .ok_or_else(|| "Server profile not found".to_string())?;

    let mut runtime_variables = HashMap::new();
    let mut results = Vec::new();

    for step in workflow.steps.iter().filter(|step| step.enabled) {
        let request = match workspace
            .requests
            .iter()
            .find(|request| request.id == step.request_id)
        {
            Some(request) => request,
            None => {
                results.push(RequestResult {
                    ok: false,
                    status: 0,
                    status_text: "Request not found".to_string(),
                    elapsed_ms: 0,
                    url: String::new(),
                    request: None,
                    response: ResponseWire {
                        headers: HashMap::new(),
                        body: String::new(),
                    },
                    extracted: HashMap::new(),
                    error: Some(format!("Request {} does not exist.", step.request_id)),
                    step_id: Some(step.id.clone()),
                    step_name: Some(step.name.clone()),
                    request_name: None,
                });
                break;
            }
        };

        let mut result = execute_request(
            &app,
            server,
            request,
            &workspace.access_tokens,
            &runtime_variables,
            &step.extract_rules,
        )
        .await?;
        runtime_variables.extend(result.extracted.clone());
        result.step_id = Some(step.id.clone());
        result.step_name = Some(step.name.clone());
        result.request_name = Some(request.name.clone());
        let step_ok = result.ok;
        results.push(result);
        if !step_ok {
            break;
        }
    }

    Ok(WorkflowResult {
        ok: results.iter().all(|result| result.ok),
        results,
        variables: runtime_variables,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            save_secret,
            load_secret,
            delete_secret,
            send_request,
            run_workflow
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
