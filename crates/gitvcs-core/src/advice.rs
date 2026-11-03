//! git 실패 글을 원인·해결 한 줄씩으로 풀어 준다. 원본 `Core/GitErrorAdvice.cs` 를 옮겼다.

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Unknown,
    NoRemote,
    NoUpstream,
    RemoteAhead,
    Network,
    Auth,
    SshKey,
    LocalChanges,
    UntrackedFiles,
    Conflict,
    NoIdentity,
    FileTooLarge,
    ProtectedBranch,
    LockFile,
    Ssl,
    SshHostKey,
    SshHostChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    pub kind: ErrorKind,
    pub cause: String,
    pub fix: String,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub files: Vec<String>,
}

const MAX_FILES: usize = 5;

fn is_auth(lower: &str) -> bool {
    ["could not read username", "authentication failed", "could not read password", "invalid username or password", "permission denied ("]
        .iter()
        .any(|p| lower.contains(p))
}

pub fn classify(message: &str) -> ErrorKind {
    let lower = message.to_lowercase();
    if lower.trim().is_empty() {
        return ErrorKind::Unknown;
    }
    if lower.contains("remote host identification has changed") {
        ErrorKind::SshHostChanged
    } else if lower.contains("host key verification failed") {
        ErrorKind::SshHostKey
    } else if lower.contains("permission denied (publickey") {
        ErrorKind::SshKey
    } else if lower.contains("does not appear to be a git repository") || lower.contains("no configured push destination") {
        ErrorKind::NoRemote
    } else if lower.contains("has no upstream branch") {
        ErrorKind::NoUpstream
    } else if lower.contains("gh006") || lower.contains("protected branch") {
        ErrorKind::ProtectedBranch
    } else if lower.contains("gh001") || lower.contains("exceeds github's file size limit") {
        ErrorKind::FileTooLarge
    } else if lower.contains("[rejected]") && (lower.contains("fetch first") || lower.contains("non-fast-forward")) {
        ErrorKind::RemoteAhead
    } else if crate::ssl::is_ssl_failure(message) {
        ErrorKind::Ssl
    } else if is_auth(&lower) {
        ErrorKind::Auth
    } else if ["could not resolve host", "failed to connect", "timed out", "unable to access", "could not connect"].iter().any(|p| lower.contains(p)) {
        ErrorKind::Network
    } else if lower.contains("please tell me who you are") || lower.contains("unable to auto-detect email address") {
        ErrorKind::NoIdentity
    } else if lower.contains("untracked working tree files would be overwritten") {
        ErrorKind::UntrackedFiles
    } else if lower.contains("local changes to the following files would be overwritten") {
        ErrorKind::LocalChanges
    } else if lower.contains(".lock': file exists") {
        ErrorKind::LockFile
    } else if lower.contains("conflict (") || lower.contains("automatic merge failed") || lower.contains("could not apply") {
        ErrorKind::Conflict
    } else {
        ErrorKind::Unknown
    }
}

fn group(pattern: &str, message: &str, name: &str) -> Option<String> {
    Regex::new(pattern).ok()?.captures(message)?.name(name).map(|m| m.as_str().trim().to_string())
}

/// "would be overwritten by" 아래 들여 쓴 파일 목록.
pub fn overwritten_paths(message: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut in_list = false;
    for line in message.lines() {
        let line = line.trim_end_matches('\r');
        if line.contains("would be overwritten by") {
            in_list = true;
            continue;
        }
        if in_list {
            if line.starts_with('\t') || line.starts_with("    ") {
                files.push(line.trim().to_string());
                continue;
            }
            in_list = false;
        }
    }
    files
}

fn find_files(message: &str) -> Vec<String> {
    let mut files = overwritten_paths(message);
    for re in [r"(?m)Merge conflict in (?P<file>.+)$", r"(?i)File (?P<file>.+?) is [\d.]+ ?MB; this exceeds"] {
        let re = Regex::new(re).unwrap();
        files.extend(re.captures_iter(message).map(|c| c["file"].trim().to_string()));
    }
    let mut seen = std::collections::HashSet::new();
    files.retain(|f| seen.insert(f.clone()));
    files
}

fn file_list(files: &[String]) -> String {
    let shown = files.iter().take(MAX_FILES).cloned().collect::<Vec<_>>().join(", ");
    if files.len() > MAX_FILES { format!("{shown} 외 {}개", files.len() - MAX_FILES) } else { shown }
}

pub fn explain(message: &str, current_branch: Option<&str>) -> Advice {
    let kind = classify(message);
    let files = find_files(message);
    let mut remote = None;
    let mut branch = None;
    let (cause, fix): (String, &str) = match kind {
        ErrorKind::Unknown => ("git 이 작업을 끝내지 못했습니다.".into(), "새로고침한 뒤 다시 해 보고, 그래도 안 되면 'git 원문' 을 확인하세요."),
        ErrorKind::NoRemote => {
            let r = group(r"(?i)'(?P<remote>[^']+)' does not appear to be a git repository", message, "remote").unwrap_or_else(|| "origin".into());
            let cause = format!("원격 저장소 '{r}' 가 등록되어 있지 않습니다.");
            remote = Some(r);
            (cause, "원격을 추가한 뒤 다시 Push 하세요.")
        }
        ErrorKind::NoUpstream => {
            remote = Some(group(r"git push --set-upstream (?P<remote>\S+) (?P<branch>\S+)", message, "remote").unwrap_or_else(|| "origin".into()));
            branch = group(r"git push --set-upstream (?P<remote>\S+) (?P<branch>\S+)", message, "branch")
                .or_else(|| group(r"(?i)current branch (?P<branch>\S+) has no upstream branch", message, "branch"))
                .or(current_branch.map(str::to_string));
            (format!("브랜치 '{}' 가 아직 원격 브랜치와 이어지지 않았습니다.", branch.clone().unwrap_or_default()), "처음 한 번은 upstream 을 지정해 Push 하세요(git push -u).")
        }
        ErrorKind::RemoteAhead => {
            branch = group(r"\[rejected\]\s+(?P<branch>\S+)\s+->", message, "branch").or(current_branch.map(str::to_string));
            (format!("원격 '{}' 에 내게 없는 커밋이 있습니다.", branch.clone().unwrap_or_default()), "Pull 로 받아 합친 뒤 다시 Push 하세요.")
        }
        ErrorKind::Network => ("원격 서버에 연결하지 못했습니다.".into(), "인터넷·VPN·프록시를 확인하고 다시 해 보세요."),
        ErrorKind::Auth => ("이 계정으로는 저장소에 접근할 수 없습니다.".into(), "로그인하거나 계정을 바꾸세요(⋮ 메뉴 > GitHub 계정, 설정 > 로그인)."),
        ErrorKind::SshKey => {
            let host = group(r"@(?P<host>[^\s:']+): Permission denied \((?P<methods>[^)]*)\)", message, "host").unwrap_or_else(|| "서버".into());
            let methods = group(r"@(?P<host>[^\s:']+): Permission denied \((?P<methods>[^)]*)\)", message, "methods").unwrap_or_default();
            let fix = if methods.contains("password") || methods.contains("keyboard-interactive") {
                "이 서버는 계정 비밀번호로도 들어갈 수 있습니다. 다시 시도해 비밀번호로 로그인하거나, 서버에 이 PC 의 SSH 공개 키를 등록하세요."
            } else {
                "서버에 이 PC 의 SSH 공개 키를 등록하세요(GitHub 는 Settings > SSH keys). 또는 https 주소를 쓰세요."
            };
            (format!("SSH 로 {host} 에 로그인하지 못했습니다(이 PC 의 SSH 키가 등록되어 있지 않거나 거부됨)."), fix)
        }
        ErrorKind::SshHostKey => (
            "처음 접속하는 SSH 서버라 믿어도 되는지 확인하지 못했습니다.".into(),
            "다시 시도해 로그인하면 이 서버를 신뢰 목록(known_hosts)에 추가합니다. 서버 주소가 맞는지 먼저 확인하세요.",
        ),
        ErrorKind::SshHostChanged => (
            "SSH 서버의 호스트 키가 예전과 다릅니다. 다른 서버로 연결되었을 수 있어 위험합니다.".into(),
            "서버 관리자에게 키를 바꿨는지 확인한 뒤, ~/.ssh/known_hosts 에서 그 서버 줄을 지우세요.",
        ),
        ErrorKind::LocalChanges => (format!("커밋하지 않은 수정이 덮어써질 수 있어 멈췄습니다: {}", file_list(&files)), "커밋하거나 Stash 한 뒤 다시 하세요."),
        ErrorKind::UntrackedFiles => (format!("git 에 없는 같은 이름의 파일이 있습니다: {}", file_list(&files)), "그 파일을 옮기거나 지운 뒤 다시 하세요."),
        ErrorKind::Conflict => (format!("자동으로 합치지 못한 충돌이 있습니다: {}", file_list(&files)), "충돌을 해결해 커밋하거나, 위 띠에서 중단하세요."),
        ErrorKind::NoIdentity => ("커밋 작성자 이름·이메일이 설정되어 있지 않습니다.".into(), "git config user.name / user.email 을 설정하세요."),
        ErrorKind::FileTooLarge => (format!("100MB 가 넘는 파일은 GitHub 에 올릴 수 없습니다: {}", file_list(&files)), "Git LFS 로 추적해 다시 커밋하세요."),
        ErrorKind::ProtectedBranch => ("보호된 브랜치라 직접 Push 할 수 없습니다.".into(), "다른 브랜치로 올려 Pull Request 를 여세요."),
        ErrorKind::LockFile => (
            format!("잠금 파일({})이 남아 있습니다.", group(r"'(?P<path>[^']*\.lock)'", message, "path").unwrap_or_else(|| "index.lock".into())),
            "다른 git 작업이 끝났는지 확인하고 잠금 파일을 지우세요.",
        ),
        ErrorKind::Ssl => (
            "원격 서버의 SSL 인증서를 확인하지 못했습니다. 회사망처럼 보안 프록시가 SSL 을 검사하는 환경일 수 있습니다.".into(),
            "설정 > SSL 인증서에서 회사 루트 인증서 파일을 지정하거나, Windows 는 'Windows 인증서 저장소 쓰기' 를 켜세요.",
        ),
    };
    Advice { kind, cause, fix: fix.to_string(), remote, branch, files }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 원본 Tests/Editor/GitErrorAdviceTests.cs 의 분류.

    #[test]
    fn classifies() {
        let cases = [
            ("fatal: 'origin' does not appear to be a git repository", ErrorKind::NoRemote),
            ("fatal: The current branch dev has no upstream branch.\n    git push --set-upstream origin dev", ErrorKind::NoUpstream),
            (" ! [rejected]        main -> main (fetch first)", ErrorKind::RemoteAhead),
            ("fatal: unable to access 'https://x/': Could not resolve host: x", ErrorKind::Network),
            ("git@github.com: Permission denied (publickey).", ErrorKind::SshKey),
            ("error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit", ErrorKind::LocalChanges),
            ("CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed", ErrorKind::Conflict),
            ("fatal: Unable to create '/r/.git/index.lock': File exists.", ErrorKind::LockFile),
            ("Host key verification failed.", ErrorKind::SshHostKey),
            ("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", ErrorKind::SshHostChanged),
            ("remote: error: GH006: Protected branch update failed", ErrorKind::ProtectedBranch),
            ("SSL certificate problem: unable to get local issuer certificate", ErrorKind::Ssl),
            ("", ErrorKind::Unknown),
        ];
        for (message, kind) in cases {
            assert_eq!(classify(message), kind, "{message}");
        }
    }

    #[test]
    fn explains_with_details() {
        let a = explain("fatal: The current branch dev has no upstream branch.\n    git push --set-upstream origin dev", None);
        assert_eq!(a.remote.as_deref(), Some("origin"));
        assert_eq!(a.branch.as_deref(), Some("dev"));
        let a = explain("error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tb.txt\nPlease commit", None);
        assert_eq!(a.files, ["a.txt", "b.txt"]);
        assert!(a.cause.ends_with("a.txt, b.txt"));
        let a = explain("u@nas: Permission denied (publickey,password).", None);
        assert!(a.cause.contains("nas"));
        assert!(a.fix.contains("비밀번호"));
        let many = (0..7).map(|i| format!("CONFLICT (content): Merge conflict in f{i}")).collect::<Vec<_>>().join("\n");
        assert!(explain(&many, None).cause.ends_with("외 2개"));
    }
}
