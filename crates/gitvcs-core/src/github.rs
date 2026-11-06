//! GitHub 연동: Device Flow 로그인, 계정 고르기, API 부르기. 원본 `UI/Services/GitHubAccount·GitHubDeviceLogin·GitAccounts` 를 옮겼다.
//!
//! 토큰은 화면(JS)에 넘기지 않는다 — 화면은 `api(경로)` 만 부르고 Rust 가 토큰을 붙인다. 앱 로그인 토큰은 OS 자격 증명 저장소
//! (키체인·자격 증명 관리자)에 `git credential approve` 로 넣고(앱만 쓰는 이름의 호스트), 명령줄·설정 파일에는 남기지 않는다.
//! git 이 GitHub 에 접속할 때 앱 계정을 쓰게 하려면 환경 변수(GIT_CONFIG_*)로만 자격 증명 도우미를 붙인다.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::repo::{GitError, Result};
use crate::runner::GitRunner;

/// NK-Studio 이름으로 등록한 OAuth App(Device Flow 켬). 공개 값이다.
pub const CLIENT_ID: &str = "Ov23liwBBq0RMqbmU44U";
/// repo: 비공개 레포지토리 읽기·쓰기·만들기, read:org: 속한 조직 목록(레포지토리 만들기 창의 계정 고르기).
pub const SCOPE: &str = "repo read:org";
/// 레포지토리 만들기에 필요한 scope.
pub const CREATE_SCOPES: [&str; 2] = ["repo", "read:org"];
const USER_AGENT: &str = "GitVcs-Desktop";
/// 앱 로그인 토큰을 넣어 둘 자격 증명 저장소의 이름(실제 git 접속에는 쓰지 않는 호스트).
const STORE_HOST: &str = "gitvcs-desktop.github.com";
const API: &str = "https://api.github.com";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    /// app | gh | credential
    pub source: String,
    /// 이 레포지토리에 고른 계정.
    pub current: bool,
    /// git 이 이 레포지토리에 지금 쓰는 계정(고른 계정, 없으면 자격 증명 도우미의 계정).
    pub in_use: bool,
    /// 이 레포지토리를 읽을 수 있는가(모르면 None).
    pub can_access: Option<bool>,
}

fn quiet_env() -> HashMap<String, String> {
    HashMap::from([("GCM_INTERACTIVE".to_string(), "never".to_string()), ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string())])
}

fn credential(git: &GitRunner, dir: &Path, action: &str, input: &str) -> Option<HashMap<String, String>> {
    let out = git.run_with(dir, &["credential", action], Some(input), &quiet_env());
    out.success().then(|| out.stdout.lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

/// 앱 로그인 토큰 (login, token). 레포지토리에 없으면 None.
pub fn load_app_token(git: &GitRunner, dir: &Path) -> Option<(String, String)> {
    let c = credential(git, dir, "fill", &format!("protocol=https\nhost={STORE_HOST}\n\n"))?;
    let (login, token) = (c.get("username")?.clone(), c.get("password")?.clone());
    (!token.is_empty()).then_some((login, token))
}

pub fn store_app_token(git: &GitRunner, dir: &Path, login: &str, token: &str) {
    let _ = credential(git, dir, "approve", &format!("protocol=https\nhost={STORE_HOST}\nusername={login}\npassword={token}\n\n"));
}

pub fn forget_app_token(git: &GitRunner, dir: &Path, login: &str) {
    let _ = credential(git, dir, "reject", &format!("protocol=https\nhost={STORE_HOST}\nusername={login}\n\n"));
}

/// GitHub CLI 에 로그인한 계정들.
pub fn gh_accounts() -> Vec<String> {
    let Ok(out) = std::process::Command::new("gh").args(["auth", "status", "--hostname", "github.com"]).env("PATH", extended_path()).output() else {
        return Vec::new();
    };
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let re = regex::Regex::new(r"(?:account|as) ([A-Za-z0-9-]+)").unwrap();
    let mut logins: Vec<String> = re.captures_iter(&text).map(|c| c[1].to_string()).collect();
    logins.dedup();
    logins
}

pub fn gh_token(login: &str) -> Option<String> {
    let out = std::process::Command::new("gh").args(["auth", "token", "--hostname", "github.com", "--user", login]).env("PATH", extended_path()).output().ok()?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !token.is_empty()).then_some(token)
}

/// 앱으로 실행하면 PATH 가 짧아 Homebrew 의 gh 를 못 찾는다.
fn extended_path() -> String {
    let mut path = std::env::var("PATH").unwrap_or_default();
    for extra in ["/usr/local/bin", "/opt/homebrew/bin"] {
        if !path.split(':').any(|p| p == extra) {
            path.push(':');
            path.push_str(extra);
        }
    }
    path
}

/// 자격 증명 도우미(키체인·GCM)가 github.com 에 쓰는 계정과 토큰.
pub fn credential_account(git: &GitRunner, dir: &Path, login: Option<&str>) -> Option<(String, String)> {
    let user = login.map(|l| format!("username={l}\n")).unwrap_or_default();
    let c = credential(git, dir, "fill", &format!("protocol=https\nhost=github.com\n{user}\n"))?;
    Some((c.get("username")?.clone(), c.get("password")?.clone()))
}

fn agent(method: &str, url: &str, token: Option<&str>) -> ureq::Request {
    let mut r = ureq::request(method, url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(20));
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        r = r.set("Authorization", &format!("Bearer {t}"));
    }
    r
}

fn read_json(response: ureq::Response) -> Value {
    let mut text = String::new();
    let _ = response.into_reader().take(32 * 1024 * 1024).read_to_string(&mut text);
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

/// GitHub REST 를 부른다. `path` 는 "/repos/o/r/pulls" 처럼 API 주소 뒤. 실패하면 GitHub 의 message 를 보인다.
pub fn api(method: &str, path: &str, body: Option<&Value>, token: Option<&str>) -> Result<Value> {
    if !path.starts_with('/') || path.contains("://") {
        return Err(GitError::new("잘못된 GitHub API 경로입니다."));
    }
    let url = format!("{API}{path}");
    let request = agent(method, &url, token);
    let result = match body {
        Some(body) => request.set("Content-Type", "application/json").send_string(&body.to_string()),
        None => request.call(),
    };
    match result {
        Ok(response) => Ok(read_json(response)),
        Err(ureq::Error::Status(code, response)) => {
            let body = read_json(response);
            let message = body.get("message").and_then(Value::as_str).unwrap_or("GitHub 요청이 실패했습니다.");
            let detail = body.pointer("/errors/0/message").and_then(Value::as_str).map(|m| format!(" — {m}")).unwrap_or_default();
            Err(GitError::new(format!("GitHub {code}: {message}{detail}")))
        }
        Err(e) => Err(GitError::new(format!("GitHub 에 연결하지 못했습니다: {e}"))),
    }
}

/// 토큰이 받은 scope(X-OAuth-Scopes). OAuth·클래식 토큰만 알려 준다 — 세분화 토큰·GitHub App 이면 None.
pub fn token_scopes(token: &str) -> Option<Vec<String>> {
    let response = agent("GET", &format!("{API}/user"), Some(token)).call().ok()?;
    let header = response.header("X-OAuth-Scopes")?;
    Some(header.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

/// `needed` 중 `granted` 에 없는 scope. 상위 scope 가 하위를 품는다(admin:org·write:org ⊃ read:org).
pub fn missing_scopes(granted: &[String], needed: &[&str]) -> Vec<String> {
    let has = |s: &str| granted.iter().any(|g| g == s);
    needed
        .iter()
        .filter(|&&n| match n {
            "read:org" => !(has("read:org") || has("write:org") || has("admin:org")),
            other => !has(other),
        })
        .map(|s| s.to_string())
        .collect()
}

/// GraphQL(초안 전환 등 REST 에 없는 것).
pub fn graphql(query: &str, variables: Value, token: &str) -> Result<Value> {
    let value = api("POST", "/graphql", Some(&json!({ "query": query, "variables": variables })), Some(token))?;
    if let Some(error) = value.pointer("/errors/0/message").and_then(Value::as_str) {
        return Err(GitError::new(format!("GitHub: {error}")));
    }
    Ok(value)
}

fn form(url: &str, fields: &[(&str, &str)]) -> Result<Value> {
    let response = ureq::post(url).set("User-Agent", USER_AGENT).set("Accept", "application/json").timeout(Duration::from_secs(20)).send_form(fields);
    match response {
        Ok(r) => Ok(read_json(r)),
        Err(ureq::Error::Status(code, _)) => Err(GitError::new(format!("GitHub 이 요청을 거절했습니다({code})."))),
        Err(e) => Err(GitError::new(format!("GitHub 에 연결하지 못했습니다: {e}"))),
    }
}

/// Device Flow 시작: 사용자가 브라우저에 넣을 코드.
pub fn device_start() -> Result<Value> {
    let v = form("https://github.com/login/device/code", &[("client_id", CLIENT_ID), ("scope", SCOPE)])?;
    if v.get("user_code").is_none() {
        return Err(GitError::new("GitHub 의 응답을 읽지 못했습니다."));
    }
    Ok(v)
}

/// 승인했는지 묻는다. pending | slow_down | (토큰) | 실패.
pub enum Poll {
    Pending,
    SlowDown,
    Token(String),
}

pub fn device_poll(device_code: &str) -> Result<Poll> {
    let v = form("https://github.com/login/oauth/access_token", &[("client_id", CLIENT_ID), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")])?;
    if let Some(token) = v.get("access_token").and_then(Value::as_str) {
        return Ok(Poll::Token(token.to_string()));
    }
    match v.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => Ok(Poll::Pending),
        Some("slow_down") => Ok(Poll::SlowDown),
        Some("expired_token") => Err(GitError::new("코드의 기한이 지났습니다. 다시 시작해 주세요.")),
        Some("access_denied") => Err(GitError::new("GitHub 에서 승인을 거절했습니다.")),
        _ => Err(GitError::new(v.get("error_description").and_then(Value::as_str).unwrap_or("GitHub 로그인에 실패했습니다.").to_string())),
    }
}

/// 이 토큰으로 이 레포지토리를 읽을 수 있는가.
pub fn can_access(owner: &str, repo: &str, token: &str) -> bool {
    api("GET", &format!("/repos/{owner}/{repo}"), None, Some(token)).is_ok()
}

/// git 이 github.com 에 접속할 때 이 토큰을 쓰게 하는 환경 변수(명령줄·설정 파일에 남기지 않는다).
pub fn token_environment(token: &str) -> HashMap<String, String> {
    HashMap::from([
        ("GIT_CONFIG_COUNT".to_string(), "2".to_string()),
        ("GIT_CONFIG_KEY_0".to_string(), "credential.https://github.com.helper".to_string()),
        ("GIT_CONFIG_VALUE_0".to_string(), String::new()),
        ("GIT_CONFIG_KEY_1".to_string(), "credential.https://github.com.helper".to_string()),
        ("GIT_CONFIG_VALUE_1".to_string(), "!f() { test \"$1\" = get && echo username=x-access-token && echo \"password=$GITVCS_GITHUB_TOKEN\"; }; f".to_string()),
        ("GITVCS_GITHUB_TOKEN".to_string(), token.to_string()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_foreign_urls() {
        assert!(api("GET", "https://evil.example/x", None, None).is_err());
        assert!(api("GET", "repos/x", None, None).is_err());
    }

    #[test]
    fn finds_missing_scopes() {
        let granted = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(missing_scopes(&granted(&["repo"]), &CREATE_SCOPES), ["read:org"]);
        assert!(missing_scopes(&granted(&["repo", "admin:org"]), &CREATE_SCOPES).is_empty());
        assert_eq!(missing_scopes(&granted(&[]), &CREATE_SCOPES), ["repo", "read:org"]);
    }

    #[test]
    fn token_stays_in_environment() {
        let env = token_environment("secret");
        assert_eq!(env["GITVCS_GITHUB_TOKEN"], "secret");
        assert!(env.values().filter(|v| v.contains("secret")).count() == 1);
    }
}
