//! A Codex ChatGPT sign-in, run for a profile from the desktop app.
//!
//! The flow is Codex's device authorization: the CLI asks for a user code, prints a URL and waits
//! for approval while it polls. There is no localhost callback, so the page can be shown in a
//! webview and the CLI can run behind it — and both can be pointed at the same egress.
//!
//! The egress is the one thing that must not be approximated. Every request the sign-in makes —
//! the CLI's polling and the page's own traffic — goes through the route the profile selected,
//! which on this machine is a loopback HTTP proxy the daemon serves on a fixed port. A mixed exit
//! (page from one address, token exchange from another) is what makes an account look stolen, so
//! the preflight refuses to start unless that proxy is actually reachable, and the webview is given
//! no other route.

use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const LOGIN_WINDOW: &str = "codex-login";
const LOGIN_DIR: &str = "codex-login";
const WAIT_FOR_URL: Duration = Duration::from_secs(30);
const ROUTE_CONNECT_TIMEOUT: Duration = Duration::from_millis(400);

/// The one sign-in this app may have in flight.
#[derive(Default)]
pub struct CodexLogin(Mutex<Option<ActiveLogin>>);

struct ActiveLogin {
    child: Child,
    dir: PathBuf,
    output: Arc<Mutex<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPreflight {
    pub ok: bool,
    pub proxy_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStarted {
    pub url: String,
    pub code: Option<String>,
    pub proxy_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub auth_json: String,
    pub saved_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn happy_home() -> PathBuf {
    std::env::var("HAPPY_HOME_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".happy")
        })
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return meta.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The Codex CLI this app runs. A GUI process does not inherit a login shell's PATH, so the usual
/// install locations are tried before PATH is believed.
fn find_codex() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("HAPPY_CODEX_BIN") {
        let path = PathBuf::from(explicit);
        if is_executable(&path) {
            return Ok(path);
        }
        return Err(format!(
            "HAPPY_CODEX_BIN points at {}, which is not an executable file",
            path.display()
        ));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/codex".to_string(),
        "/usr/local/bin/codex".to_string(),
        "/usr/bin/codex".to_string(),
        format!("{home}/.bun/bin/codex"),
        format!("{home}/.local/bin/codex"),
        format!("{home}/.npm-global/bin/codex"),
    ];
    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if is_executable(&path) {
            return Ok(path);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':').filter(|dir| !dir.is_empty()) {
            let candidate = Path::new(dir).join("codex");
            if is_executable(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err("Codex CLI not found. Install it (npm i -g @openai/codex, or brew install codex) or set HAPPY_CODEX_BIN.".to_string())
}

/// The loopback proxy a named route is served on, after proving something is listening.
///
/// A route name is the profile's whole statement; the port and the hop behind it belong to the
/// machine. Fail closed: an unresolvable or unreachable route does not fall back to a direct
/// connection, because that is exactly the mixed egress this flow exists to avoid.
fn route_proxy(route: &str) -> Result<Option<String>, String> {
    let name = route.trim();
    if name.is_empty() || name == "direct" {
        return Ok(None);
    }
    let table = happy_home().join("proxy-routes.json");
    let text = fs::read_to_string(&table)
        .map_err(|_| format!("route \"{name}\" was selected, but this machine has no route table ({})", table.display()))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("{} is not valid JSON: {error}", table.display()))?;
    let port = parsed
        .get(name)
        .and_then(|value| value.as_u64())
        .filter(|port| (1..=65535).contains(port))
        .ok_or_else(|| format!("route \"{name}\" is not served by this machine"))?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port as u16));
    std::net::TcpStream::connect_timeout(&address, ROUTE_CONNECT_TIMEOUT).map_err(|_| {
        format!("route \"{name}\" is not reachable on 127.0.0.1:{port}; start the daemon that serves it")
    })?;
    Ok(Some(format!("http://127.0.0.1:{port}")))
}

/// Whether a string is an auth file Codex can use, not merely anything wearing the name.
fn is_usable_auth(value: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value) else {
        return false;
    };
    parsed
        .get("OPENAI_API_KEY")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.is_empty())
        || parsed
            .pointer("/tokens/access_token")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.is_empty())
        || parsed
            .pointer("/tokens/refresh_token")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.is_empty())
}

/// Removes the colour escapes Codex wraps around the URL and code.
///
/// A parser looking at the raw bytes sees `\x1b[94mhttps://…` and misses both tokens; this is the
/// difference between a sign-in that opens and one that waits half a minute and then reports that
/// no URL was printed — while the error message itself contains it.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // CSI: parameters up to a final byte in @..~
            while let Some(next) = chars.next() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            // A two-byte escape (`ESC 7`, `ESC =`, …): drop the introducer and its follower.
            chars.next();
        }
    }
    out
}

fn trim_token(token: &str) -> &str {
    token.trim_matches(|c: char| {
        matches!(c, '"' | '\'' | '(' | ')' | '<' | '>' | ',' | ';' | '.' | '[' | ']' | ':')
    })
}

/// The sign-in URL and user code from whatever the CLI printed.
///
/// Kept as a pure function: the exact wording belongs to Codex, and this is the part a test can
/// pin without a live account. Two shapes are known: `... enter code ABCD-1234.` on one line, and
/// the device-auth banner, which puts the code on its own line under “Enter this one-time code”.
fn parse_login_output(text: &str) -> Option<(String, Option<String>)> {
    let text = strip_ansi(text);

    let mut url: Option<String> = None;
    for token in text.split_whitespace() {
        let token = trim_token(token);
        if token.starts_with("https://") && (token.contains("openai.com") || token.contains("chatgpt.com")) {
            url = Some(token.to_string());
            break;
        }
    }
    let url = url?;

    let mut code: Option<String> = None;
    let lines: Vec<&str> = text.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if !line.to_ascii_lowercase().contains("code") {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        for (position, token) in tokens.iter().enumerate() {
            if !trim_token(token).eq_ignore_ascii_case("code") {
                continue;
            }
            if let Some(next) = tokens.get(position + 1) {
                let next = trim_token(next);
                if looks_like_user_code(next) {
                    code = Some(next.to_string());
                }
            }
        }
        if code.is_some() {
            break;
        }
        // The device-auth banner prints the code alone on the following non-empty line.
        for next in lines.iter().skip(index + 1) {
            let next = next.trim();
            if next.is_empty() {
                continue;
            }
            let candidate = trim_token(next.split_whitespace().next().unwrap_or(""));
            if looks_like_user_code(candidate) {
                code = Some(candidate.to_string());
            }
            break;
        }
        if code.is_some() {
            break;
        }
    }

    // A complete verification URL may already carry the code.
    if code.is_none() {
        if let Some(query) = url.split_once('?').map(|(_, query)| query.to_string()) {
            for pair in query.split('&') {
                if let Some((key, value)) = pair.split_once('=') {
                    if (key == "user_code" || key == "code") && !value.is_empty() {
                        code = Some(value.to_string());
                        break;
                    }
                }
            }
        }
    }

    // Last resort: a dash-shaped, upper-case code anywhere in the output.
    if code.is_none() {
        for token in text.split_whitespace() {
            let token = trim_token(token);
            if token.contains('-')
                && token.chars().any(|c| c.is_ascii_uppercase())
                && looks_like_user_code(token)
            {
                code = Some(token.to_string());
                break;
            }
        }
    }

    Some((url, code))
}

fn looks_like_user_code(value: &str) -> bool {
    let compact: String = value.chars().filter(|c| *c != '-').collect();
    (4..=16).contains(&compact.len())
        && compact.chars().all(|c| c.is_ascii_alphanumeric())
        && (compact.chars().any(|c| c.is_ascii_digit()) || value.contains('-'))
        && !value.chars().all(|c| c.is_ascii_lowercase())
}

fn tail(output: &Arc<Mutex<String>>, lines: usize) -> String {
    let text = output.lock().map(|value| value.clone()).unwrap_or_default();
    let text = strip_ansi(&text);
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn spawn_reader<R: Read + Send + 'static>(reader: Option<R>, output: Arc<Mutex<String>>) {
    let Some(reader) = reader else {
        return;
    };
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(mut output) = output.lock() {
                        output.push_str(&line);
                    }
                }
            }
        }
    });
}

fn login_dir() -> Result<PathBuf, String> {
    let dir = happy_home()
        .join("tmp")
        .join(LOGIN_DIR)
        .join(format!("{}-{}", std::process::id(), now_ms()));
    fs::create_dir_all(&dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Whether this system's webview can be pointed at a proxy.
///
/// wry's per-webview proxy configuration is a macOS 14 API. An older system would take the same
/// KVC write and raise, so the route is refused there instead of crashing the sign-in window.
fn webview_proxy_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("sw_vers").arg("-productVersion").output();
        let version = output
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default();
        let major = version.split('.').next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
        major >= 14
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
pub fn codex_login_preflight(route: String) -> LoginPreflight {
    match find_codex() {
        Ok(_) => match route_proxy(&route) {
            Ok(proxy_url) => {
                if proxy_url.is_some() && !webview_proxy_supported() {
                    return LoginPreflight {
                        ok: false,
                        proxy_url: None,
                        error: Some(
                            "this system cannot route an app window through the selected route; sign in with `codex login --device-auth` in a terminal instead"
                                .to_string(),
                        ),
                    };
                }
                LoginPreflight { ok: true, proxy_url, error: None }
            }
            Err(error) => LoginPreflight { ok: false, proxy_url: None, error: Some(error) },
        },
        Err(error) => LoginPreflight { ok: false, proxy_url: None, error: Some(error) },
    }
}

#[tauri::command]
pub async fn codex_login_start(app: AppHandle, route: String) -> Result<LoginStarted, String> {
    tauri::async_runtime::spawn_blocking(move || start_blocking(&app, route))
        .await
        .map_err(|error| format!("sign-in task failed: {error}"))?
}

fn start_blocking(app: &AppHandle, route: String) -> Result<LoginStarted, String> {
    let state = app.state::<CodexLogin>();
    {
        let slot = state.0.lock().map_err(|_| "sign-in state is poisoned".to_string())?;
        if slot.is_some() {
            return Err("a sign-in is already in progress".to_string());
        }
    }

    let codex = find_codex()?;
    let direct = route.trim() == "direct";
    let proxy_url = route_proxy(&route)?;
    let dir = login_dir()?;

    let mut command = Command::new(&codex);
    command
        .arg("login")
        .arg("--device-auth")
        .env("CODEX_HOME", &dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(proxy) = proxy_url.as_deref() {
        for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"] {
            command.env(key, proxy);
        }
        for key in ["NO_PROXY", "no_proxy"] {
            command.env(key, "localhost,127.0.0.1,::1");
        }
    } else if direct {
        // “Direct” is a decision, not an absence: the CLI must not inherit a proxy this app
        // happened to be started with, or the page and the polling would leave by different paths.
        for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"] {
            command.env_remove(key);
        }
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("could not start {}: {error}", codex.display()));
        }
    };

    let output = Arc::new(Mutex::new(String::new()));
    spawn_reader(child.stdout.take(), output.clone());
    spawn_reader(child.stderr.take(), output.clone());

    let deadline = Instant::now() + WAIT_FOR_URL;
    let (url, code) = loop {
        if let Ok(text) = output.lock().map(|value| value.clone()) {
            if let Some(found) = parse_login_output(&text) {
                break found;
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!(
                "codex login exited ({status}) before printing a sign-in URL:\n{}",
                tail(&output, 8)
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_dir_all(&dir);
            return Err(format!(
                "codex login did not print a sign-in URL within {}s:\n{}",
                WAIT_FOR_URL.as_secs(),
                tail(&output, 8)
            ));
        }
        std::thread::sleep(Duration::from_millis(120));
    };
    {
        let mut slot = state.0.lock().map_err(|_| "sign-in state is poisoned".to_string())?;
        *slot = Some(ActiveLogin { child, dir, output });
    }
    Ok(LoginStarted { url, code, proxy_url })
}

#[tauri::command]
pub async fn codex_login_finish(app: AppHandle) -> Result<LoginResult, String> {
    let active = {
        let state = app.state::<CodexLogin>();
        let mut slot = state.0.lock().map_err(|_| "sign-in state is poisoned".to_string())?;
        slot.take()
    };
    let Some(active) = active else {
        return Err("no sign-in is in progress".to_string());
    };
    tauri::async_runtime::spawn_blocking(move || finish_active(active))
        .await
        .map_err(|error| format!("sign-in task failed: {error}"))?
}

fn finish_active(mut active: ActiveLogin) -> Result<LoginResult, String> {
    let status = active.child.wait();
    let result = match status {
        Ok(status) if status.success() => {
            let path = active.dir.join("auth.json");
            match fs::read_to_string(&path) {
                Ok(auth_json) if is_usable_auth(&auth_json) => {
                    Ok(LoginResult { auth_json, saved_at: now_ms() })
                }
                Ok(_) => Err("codex login succeeded but auth.json is not a usable credential".to_string()),
                Err(error) => Err(format!("codex login succeeded but auth.json could not be read: {error}")),
            }
        }
        Ok(status) => Err(format!("codex login exited ({status}):\n{}", tail(&active.output, 8))),
        Err(error) => Err(format!("could not wait for codex login: {error}")),
    };
    let _ = fs::remove_dir_all(&active.dir);
    result
}

#[tauri::command]
pub async fn codex_login_cancel(app: AppHandle) -> Result<(), String> {
    let active = {
        let state = app.state::<CodexLogin>();
        let mut slot = state.0.lock().map_err(|_| "sign-in state is poisoned".to_string())?;
        slot.take()
    };
    if let Some(mut active) = active {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = active.child.kill();
            let _ = active.child.wait();
            let _ = fs::remove_dir_all(&active.dir);
        })
        .await
        .map_err(|error| format!("sign-in task failed: {error}"))?;
    }
    Ok(())
}

/// What the sign-in window may load.
///
/// Any https page: the flow can leave for an identity provider (an SSO account signs in on its
/// own domain), and a host list would break exactly those accounts. The window holds no credential
/// of this app and cannot reach its IPC; what it must not do is load insecure or local origins.
fn allowed_login_url(url: &tauri::Url) -> bool {
    url.scheme() == "https"
}

fn close_login_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.close();
    }
}

/// Brings a new-window link into the sign-in window instead.
///
/// The consent page links to the account's Security Settings as a new window, and Tauri does not
/// open one unless asked — the click did nothing. Opening it in the user's browser is worse than
/// nothing here: that page would leave by a different route than the login it belongs to, and the
/// whole point of this flow is one egress. Navigating the same webview keeps the route and the
/// session (the page that asked for it is already signed in).
fn navigate_login_window(app: &AppHandle, url: tauri::Url) {
    if url.scheme() != "https" {
        return;
    }
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.navigate(url);
    }
}

#[tauri::command]
pub fn codex_login_open_window(
    app: AppHandle,
    url: String,
    proxy_url: Option<String>,
    code: Option<String>,
) -> Result<(), String> {
    close_login_window(&app);
    let target = tauri::Url::parse(&url).map_err(|error| format!("invalid sign-in URL: {error}"))?;
    if target.scheme() != "https" {
        return Err("the sign-in URL must use https".to_string());
    }
    // The code is a one-time user code, useless without the account; carrying it in the title saves
    // a window switch on a page whose first field is exactly this.
    let title = match code.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(code) => format!("Sign in to Codex — {code}"),
        None => "Sign in to Codex".to_string(),
    };
    let app_for_links = app.clone();
    let mut builder = tauri::WebviewWindowBuilder::new(&app, LOGIN_WINDOW, tauri::WebviewUrl::External(target))
        .title(title)
        .inner_size(520.0, 780.0)
        .min_inner_size(380.0, 520.0)
        .center()
        .incognito(true)
        .on_navigation(allowed_login_url)
        // A link that asks for a new window (the consent page's Security Settings link does) is
        // loaded in this same window: denying it without a destination is why the click did
        // nothing, and a system-browser tab would leave by a different route than the login.
        .on_new_window(move |url, _features| {
            navigate_login_window(&app_for_links, url);
            tauri::webview::NewWindowResponse::Deny
        });
    if let Some(proxy) = proxy_url.as_deref().filter(|value| !value.is_empty()) {
        if !webview_proxy_supported() {
            return Err("this system cannot route an app window through a proxy".to_string());
        }
        let proxy = tauri::Url::parse(proxy).map_err(|error| format!("invalid proxy URL: {error}"))?;
        builder = builder.proxy_url(proxy);
    }
    builder
        .build()
        .map(|_| ())
        .map_err(|error| format!("could not open the sign-in window: {error}"))
}

#[tauri::command]
pub fn codex_login_window_close(app: AppHandle) {
    close_login_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_device_auth_lines() {
        let text = "Starting local login server on http://localhost:1455.\n\
                    To sign in to the config server, open https://auth.openai.com/codex/device and enter code ABCD-1234.\n";
        let (url, code) = parse_login_output(text).expect("url");
        assert_eq!(url, "https://auth.openai.com/codex/device");
        assert_eq!(code.as_deref(), Some("ABCD-1234"));
    }

    #[test]
    fn parses_the_coloured_device_auth_banner() {
        let text = "\u{1b}[90mOpenAI's command-line coding agent\u{1b}[0m\n\n\
                    1. Open this link in your browser and sign in to your account\n   \
                    \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m\n\n\
                    2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m\n   \
                    \u{1b}[94m1TXG-02ILM\u{1b}[0m\n\n\
                    \u{1b}[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u{1b}[0m\n";
        let (url, code) = parse_login_output(text).expect("url");
        assert_eq!(url, "https://auth.openai.com/codex/device");
        assert_eq!(code.as_deref(), Some("1TXG-02ILM"));
    }

    #[test]
    fn reads_a_code_from_the_verification_url() {
        let text = "Open https://auth.openai.com/codex/device?user_code=WXYZ-9876 to continue\n";
        let (_, code) = parse_login_output(text).expect("url");
        assert_eq!(code.as_deref(), Some("WXYZ-9876"));
    }

    #[test]
    fn ignores_words_that_are_not_codes() {
        let text = "Open https://chatgpt.com/codex/device and enter the code shown above\n";
        let (_, code) = parse_login_output(text).expect("url");
        assert_eq!(code, None);
    }

    #[test]
    fn rejects_foreign_auth_files() {
        assert!(!is_usable_auth("{}"));
        assert!(!is_usable_auth("not json"));
        assert!(is_usable_auth(r#"{"tokens":{"access_token":"a","refresh_token":"r"}}"#));
        assert!(is_usable_auth(r#"{"OPENAI_API_KEY":"sk-x"}"#));
    }
}
