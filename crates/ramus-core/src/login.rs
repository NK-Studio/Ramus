//! GitHub 가 아닌 서버(회사 NAS 의 SSH 비밀번호 서버, 사내 GitLab https)에 로그인하게 한다. 원본 패키지 GitRemoteLogin 을 옮긴 것.
//!
//! 앱은 git 의 비밀번호 질문을 끈다(`GIT_TERMINAL_PROMPT=0`). 그래서 비밀번호로만 받는 서버는 바로 실패한다.
//! 실패 글을 보고(`parse_failure`) 화면이 아이디·비밀번호를 받은 뒤 그 작업을 다시 한다.
//! - SSH: ssh 는 git 자격 증명 저장소를 쓰지 않는다. 비밀번호를 물을 때 부르는 프로그램(`SSH_ASKPASS`)에 도우미 스크립트를 두고,
//!   비밀번호는 환경 변수로만 넘긴다(명령줄·파일에 남기지 않는다). 앱을 끌 때까지 기억한다.
//! - https: `git credential approve` 로 이 PC 의 자격 증명 저장소(키체인·자격 증명 관리자)에 넣는다. 다음부터 git 이 스스로 꺼낸다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::runner::GitRunner;

pub const HOST_VARIABLE: &str = "RAMUS_SSH_HOST";
pub const PASSWORD_VARIABLE: &str = "RAMUS_SSH_PASSWORD";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginKind {
    /// SSH 계정 비밀번호(회사 NAS·사내 서버).
    Ssh,
    /// https 사용자 이름·비밀번호(또는 토큰).
    Https,
}

/// 로그인할 원격. `host` 가 None 이면 오류 글에 서버가 없어 원격 주소에서 찾아야 한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginTarget {
    pub kind: LoginKind,
    /// https 는 포트까지(`git.company.com:8443`) — 자격 증명 저장소가 그렇게 나눈다.
    pub host: Option<String>,
    pub user: Option<String>,
    /// https 쪽만: 주소의 프로토콜("https" 또는 사내 서버의 "http"). 자격 증명 저장소가 프로토콜로도 나눈다.
    #[serde(default)]
    pub protocol: Option<String>,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

static SSH_DENIED: OnceLock<Regex> = OnceLock::new();
static HTTPS_DENIED: OnceLock<Regex> = OnceLock::new();
static SSH_URL: OnceLock<Regex> = OnceLock::new();
static HTTPS_URL: OnceLock<Regex> = OnceLock::new();
static SCP_URL: OnceLock<Regex> = OnceLock::new();

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

fn is_github(host: &str) -> bool {
    let name = host.to_lowercase();
    name == "github.com" || name.ends_with(".github.com")
}

/// git 오류 글이 로그인으로 풀 수 있는 실패인가. SSH 는 서버가 비밀번호를 받을 때만(키만 받으면 키를 등록해야 한다),
/// https 는 GitHub 가 아닐 때만.
pub fn parse_failure(message: &str) -> Option<LoginTarget> {
    let lower = message.to_lowercase();
    // 알던 서버의 키가 바뀌었다 — 다른 서버로 이어졌을 수 있어 로그인을 권하지 않는다.
    if lower.contains("remote host identification has changed") {
        return None;
    }
    // "tester@nas.local: Permission denied (publickey,password)."
    if let Some(c) = re(&SSH_DENIED, r"(?P<user>[^\s@']+)@(?P<host>[^\s:']+): Permission denied \((?P<methods>[^)]*)\)").captures(message) {
        let methods = &c["methods"];
        return (methods.contains("password") || methods.contains("keyboard-interactive"))
            .then(|| LoginTarget { kind: LoginKind::Ssh, host: Some(c["host"].to_string()), user: Some(c["user"].to_string()), protocol: None });
    }
    // 처음 접속하는 SSH 서버: "믿을까요?" 를 묻지 못했다. 로그인하면서 신뢰 목록에 넣는다.
    if lower.contains("host key verification failed") {
        return Some(LoginTarget { kind: LoginKind::Ssh, host: None, user: None, protocol: None });
    }
    let c = re(&HTTPS_DENIED, r"(?i)(?:could not read username for|authentication failed for) '(?P<url>https?://[^']+)'").captures(message)?;
    parse_url(&c["url"]).filter(|t| t.host.as_deref().is_some_and(|h| !is_github(h)))
}

/// 원격 주소에서 로그인할 서버. 로컬 경로·모르는 형식이면 None.
pub fn parse_url(url: &str) -> Option<LoginTarget> {
    let url = url.trim();
    if let Some(c) = re(&SSH_URL, r"(?i)^ssh://(?:(?P<user>[^@/]+)@)?(?P<host>\[[^\]]+\]|[^:/]+)(?::\d+)?(?:/|$)").captures(url) {
        return Some(LoginTarget {
            kind: LoginKind::Ssh,
            host: Some(c["host"].trim_matches(['[', ']']).to_string()),
            user: non_empty(c.name("user").map_or("", |m| m.as_str())),
            protocol: None,
        });
    }
    if let Some(c) = re(&HTTPS_URL, r"(?i)^(?P<scheme>https?)://(?:(?P<user>[^@/:]+)(?::[^@/]*)?@)?(?P<host>[^/]+)").captures(url) {
        let user = c.name("user").map_or(String::new(), |m| percent_decode(m.as_str()));
        return Some(LoginTarget { kind: LoginKind::Https, host: Some(c["host"].to_string()), user: non_empty(&user), protocol: Some(c["scheme"].to_lowercase()) });
    }
    if !url.contains("://")
        && let Some(c) = re(&SCP_URL, r"^(?:(?P<user>[^@/]+)@)?(?P<host>[^@/:]{2,}):").captures(url)
    {
        // "C:/…" 같은 드라이브 문자는 위 {2,} 에서 걸러지고, "host://" 는 위에서 걸러진다.
        return Some(LoginTarget { kind: LoginKind::Ssh, host: Some(c["host"].to_string()), user: non_empty(c.name("user").map_or("", |m| m.as_str())), protocol: None });
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// ssh 가 묻는 글(첫 인자)을 보고 답하는 도우미. 기억한 서버의 비밀번호 질문과 "믿을까요?" 에만 답하고, 다른 질문은 거절한다.
pub fn askpass_script() -> String {
    format!(
        "#!/bin/sh\n\
         # Ramus: ssh 가 비밀번호를 물을 때 앱에서 받은 값을 돌려준다. 값은 환경 변수로만 받는다.\n\
         case \"$1\" in\n  \
         *\"${HOST_VARIABLE}\"*\"(yes/no\"*) echo yes; exit 0 ;;\n  \
         *\"${HOST_VARIABLE}\"*assword*) printf '%s\\n' \"${PASSWORD_VARIABLE}\"; exit 0 ;;\n\
         esac\n\
         exit 1\n"
    )
}

/// 도우미 스크립트를 임시 폴더에 쓰고 경로를 돌려준다(Git for Windows 의 ssh 도 슬래시 경로와 sh 스크립트를 읽는다).
pub fn write_askpass(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("ssh-askpass.sh");
    std::fs::write(&path, askpass_script())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

/// git 프로세스에 붙일 SSH 비밀번호 도우미 환경.
/// `SSH_ASKPASS_REQUIRE=force`: 앱이 터미널에서 켜졌어도 ssh 가 그 터미널에서 기다리지 않고 늘 도우미에게 묻는다.
pub fn ssh_environment(askpass: &Path, host: &str, password: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("SSH_ASKPASS".into(), askpass.display().to_string().replace('\\', "/"));
    env.insert("SSH_ASKPASS_REQUIRE".into(), "force".into());
    // OpenSSH 8.3 이전은 DISPLAY 가 있어야 도우미를 부른다.
    if std::env::var_os("DISPLAY").is_none() {
        env.insert("DISPLAY".into(), ":0".into());
    }
    env.insert(HOST_VARIABLE.into(), host.into());
    env.insert(PASSWORD_VARIABLE.into(), password.into());
    env
}

/// https 계정을 이 PC 의 자격 증명 저장소에 넣는다. 예전에 저장한 (틀린) 값은 먼저 지운다. `protocol` 은 "https" 또는 "http".
pub fn save_https(git: &GitRunner, dir: &Path, protocol: &str, host: &str, user: &str, password: &str) -> Result<(), String> {
    let protocol = if protocol == "http" { "http" } else { "https" };
    let request = format!("protocol={protocol}\nhost={host}\nusername={user}\n");
    let _ = git.run_with(dir, &["credential", "reject"], Some(&format!("{request}\n")), &HashMap::new());
    let out = git.run_with(dir, &["credential", "approve"], Some(&format!("{request}password={password}\n\n")), &HashMap::new());
    if out.success() { Ok(()) } else { Err(out.message()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(kind: LoginKind, host: Option<&str>, user: Option<&str>) -> Option<LoginTarget> {
        let protocol = (kind == LoginKind::Https).then(|| "https".to_string());
        Some(LoginTarget { kind, host: host.map(Into::into), user: user.map(Into::into), protocol })
    }

    #[test]
    fn nas_password_server_is_ssh_login() {
        assert_eq!(
            parse_failure("tester@nas.local: Permission denied (publickey,password).\nfatal: Could not read from remote repository."),
            t(LoginKind::Ssh, Some("nas.local"), Some("tester"))
        );
    }

    #[test]
    fn key_only_and_changed_key_are_not_login() {
        assert_eq!(parse_failure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), None);
        assert_eq!(parse_failure("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."), None);
    }

    #[test]
    fn new_ssh_host_needs_remote_url() {
        assert_eq!(parse_failure("Host key verification failed.\nfatal: Could not read from remote repository."), t(LoginKind::Ssh, None, None));
    }

    #[test]
    fn https_company_server_is_https_login() {
        assert_eq!(
            parse_failure("fatal: could not read Username for 'https://gitlab.company.com': terminal prompts disabled"),
            t(LoginKind::Https, Some("gitlab.company.com"), None)
        );
        assert_eq!(
            parse_failure("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://git.company.com:8443/team/game.git/'"),
            t(LoginKind::Https, Some("git.company.com:8443"), None)
        );
        assert_eq!(parse_failure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), None);
        assert_eq!(parse_failure("fatal: repository not found"), None);
    }

    #[test]
    fn parses_urls() {
        assert_eq!(parse_url("ssh://tester@localhost:2222/test.git"), t(LoginKind::Ssh, Some("localhost"), Some("tester")));
        assert_eq!(parse_url("tester@nas.local:volume1/git/game.git"), t(LoginKind::Ssh, Some("nas.local"), Some("tester")));
        assert_eq!(parse_url("ssh://nas.local/git/game.git"), t(LoginKind::Ssh, Some("nas.local"), None));
        assert_eq!(parse_url("https://hong@gitlab.company.com/team/game.git"), t(LoginKind::Https, Some("gitlab.company.com"), Some("hong")));
        assert_eq!(parse_url("https://git.company.com:8443/team/game.git\n"), t(LoginKind::Https, Some("git.company.com:8443"), None));
        assert_eq!(parse_url("https://%ED%99%8D@git.x/r.git"), t(LoginKind::Https, Some("git.x"), Some("홍")));
        assert_eq!(parse_url("HTTP://gitlab.local/r.git").unwrap().protocol.as_deref(), Some("http"));
        for local in ["/Users/me/repos/game.git", "C:/repos/game.git", ""] {
            assert_eq!(parse_url(local), None, "{local}");
        }
    }

    #[test]
    fn askpass_answers_only_its_host() {
        let script = askpass_script();
        assert!(script.contains("*\"$RAMUS_SSH_HOST\"*assword*"));
        assert!(script.contains("*\"$RAMUS_SSH_HOST\"*\"(yes/no\"*"));
        assert!(script.ends_with("exit 1\n"));
    }

    #[cfg(unix)]
    #[test]
    fn askpass_script_runs() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_askpass(dir.path()).unwrap();
        let run = |prompt: &str| {
            std::process::Command::new(&path).arg(prompt).env(HOST_VARIABLE, "nas.local").env(PASSWORD_VARIABLE, "비밀 번호").output().unwrap()
        };
        let out = run("tester@nas.local's password: ");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "비밀 번호\n");
        let out = run("Are you sure you want to continue connecting to nas.local (yes/no/[fingerprint])? ");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "yes\n");
        // 다른 서버·키 암호 질문은 거절.
        assert!(!run("other@evil.host's password: ").status.success());
        assert!(!run("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ").status.success());
    }
}
