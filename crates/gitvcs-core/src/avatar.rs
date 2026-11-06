//! 커밋 작성자 사진. 원본 `Core/GitAvatarSources.cs` 와 `UI/Services/IAvatarProvider.cs` 를 옮겼다.
//!
//! 찾는 차례: GitHub noreply 메일 → (원격이 GitHub 면) 그 커밋을 GitHub API 에 물어 받은 avatar_url → Gravatar.
//! AI 도구(Claude·OpenAI·Gemini) 공동 작성자는 사람 사진이 없으니 로고를 쓴다(화면이 가진 그림).
//! 받은 사진과 "없음" 은 디스크에 7일 둔다. 요청 제한(403·429)·네트워크 오류는 "없음" 으로 단정하지 않고 이번 실행에서만 접는다.

use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use regex::Regex;

/// 받는 사진 크기(px).
pub const SIZE: u32 = 64;
const CACHE_LIFETIME: Duration = Duration::from_secs(7 * 24 * 3600);
const USER_AGENT: &str = "GitVcs-Desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiAuthor {
    Claude,
    OpenAi,
    Gemini,
}

impl AiAuthor {
    /// 화면의 로고 이름.
    pub fn key(self) -> &'static str {
        match self {
            AiAuthor::Claude => "claude",
            AiAuthor::OpenAi => "openai",
            AiAuthor::Gemini => "gemini",
        }
    }
}

/// AI 도구가 남긴 메일인가.
pub fn ai_author(email: &str) -> Option<AiAuthor> {
    let value = email.trim().to_lowercase();
    let at = value.find('@').filter(|&at| at > 0)?;
    let (local, domain) = (&value[..at], &value[at + 1..]);
    let is_domain = |expected: &str| domain == expected || domain.ends_with(&format!(".{expected}"));
    if is_domain("anthropic.com") || local.contains("claude") {
        Some(AiAuthor::Claude)
    } else if is_domain("openai.com") || local.contains("codex") || local.contains("chatgpt") {
        Some(AiAuthor::OpenAi)
    } else if local.contains("gemini") {
        Some(AiAuthor::Gemini)
    } else {
        None
    }
}

/// GitHub noreply 메일(12345678+login@users.noreply.github.com, 예전 login@…)이면 그 계정 사진 주소.
pub fn noreply_avatar_url(email: &str) -> Option<String> {
    let re = Regex::new(r"(?i)^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$").unwrap();
    let c = re.captures(email.trim())?;
    Some(match c.get(1) {
        Some(id) => format!("https://avatars.githubusercontent.com/u/{}?s={SIZE}", id.as_str()),
        None => format!("https://github.com/{}.png?size={SIZE}", &c[2]),
    })
}

/// GitHub 원격 주소에서 (소유자, 레포지토리). git@github.com:o/r.git, ssh://git@github.com/o/r, https://github.com/o/r(.git)
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let re = Regex::new(r"(?i)github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$").unwrap();
    let c = re.captures(url.trim())?;
    Some((c[1].to_string(), c[2].to_string()))
}

pub fn gravatar_url(email: &str) -> String {
    format!("https://www.gravatar.com/avatar/{:x}?s={SIZE}&d=404", md5::compute(email.trim().to_lowercase().as_bytes()))
}

/// 디스크 캐시 파일 이름(메일을 그대로 쓰지 않는다).
pub fn cache_key(email: &str) -> String {
    sha1_smol::Sha1::from(email.trim().to_lowercase().as_bytes()).digest().to_string()
}

/// 사진 하나를 찾은 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Avatar {
    Image(Vec<u8>),
    Ai(AiAuthor),
    None,
}

pub struct AvatarCache {
    dir: Option<PathBuf>,
    /// 이번 실행에서 못 찾은 메일(다시 묻지 않는다).
    missing: Mutex<HashSet<String>>,
}

enum Download {
    Ok(Vec<u8>),
    /// 정말 없다(404 등).
    Missing,
    /// 요청 제한·네트워크 — 다음 실행에 다시 본다.
    Temporary,
}

fn download(url: &str) -> Download {
    match ureq::get(url).set("User-Agent", USER_AGENT).timeout(Duration::from_secs(10)).call() {
        Ok(response) => {
            if is_github_default(&response) {
                return Download::Missing;
            }
            let mut bytes = Vec::new();
            match response.into_reader().take(2 * 1024 * 1024).read_to_end(&mut bytes) {
                Ok(_) if !bytes.is_empty() => Download::Ok(bytes),
                _ => Download::Temporary,
            }
        }
        Err(ureq::Error::Status(code, _)) if code == 403 || code == 429 || code >= 500 => Download::Temporary,
        Err(ureq::Error::Status(..)) => Download::Missing,
        Err(_) => Download::Temporary,
    }
}

/// GitHub 계정에 등록된 메일이면 그 계정 사진. 레포지토리 접근 권한이 없어도(비공개 레포지토리·다른 계정으로 로그인) 쓸 수 있다.
pub fn github_email_avatar_url(email: &str) -> String {
    let email: String = email.trim().bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'@' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect();
    format!("https://avatars.githubusercontent.com/u/e?email={email}&s={SIZE}")
}

/// GitHub 은 모르는 메일에도 200 으로 늘 같은 기본 그림(보라 무늬)을 준다 — 그 그림이면 없는 것으로 친다.
const GITHUB_DEFAULT_ETAG: &str = "6fc333308ecddc5d9d3c67b9df7f74161551c2cfa5f7229eb1286693ed377401";
const GITHUB_DEFAULT_MODIFIED: &str = "Sat, 05 Nov 2016 20:57:50 GMT";

fn is_github_default(response: &ureq::Response) -> bool {
    response.header("etag").is_some_and(|e| e.contains(GITHUB_DEFAULT_ETAG)) || response.header("last-modified") == Some(GITHUB_DEFAULT_MODIFIED)
}

/// GitHub 에 그 커밋의 작성자를 묻는다. (사진 주소, 답을 받았는가). 비공개 레포지토리·요청 제한이면 답이 없다.
fn github_commit_avatar(owner: &str, repo: &str, hash: &str, token: Option<&str>) -> (Option<String>, bool) {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/commits/{hash}");
    let mut request = ureq::get(&url).set("User-Agent", USER_AGENT).set("Accept", "application/vnd.github+json").timeout(Duration::from_secs(10));
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    match request.call().ok().and_then(|r| r.into_string().ok()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        Some(body) => (body.pointer("/author/avatar_url").and_then(|v| v.as_str()).map(str::to_string), true),
        None => (None, false),
    }
}

fn fresh(path: &std::path::Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < CACHE_LIFETIME)
}

impl AvatarCache {
    pub fn new(dir: Option<PathBuf>) -> Self {
        AvatarCache { dir, missing: Mutex::new(HashSet::new()) }
    }

    /// 기본 위치: macOS `~/Library/Caches/GitVcs/Avatars`, Windows `%LOCALAPPDATA%\GitVcs\Avatars`.
    pub fn default_dir() -> Option<PathBuf> {
        dirs::cache_dir().map(|d| d.join("GitVcs").join("Avatars"))
    }

    /// 사진을 찾는다(네트워크를 쓸 수 있어 작업 스레드에서 부른다). `github` 는 원격이 GitHub 일 때 (소유자, 레포지토리).
    pub fn get(&self, email: &str, commit_hash: &str, github: Option<&(String, String)>, token: Option<&str>) -> Avatar {
        let email = email.trim();
        if email.is_empty() {
            return Avatar::None;
        }
        if let Some(ai) = ai_author(email) {
            return Avatar::Ai(ai);
        }
        let key = cache_key(email);
        if self.missing.lock().unwrap().contains(&key) {
            return Avatar::None;
        }
        let image = self.dir.as_ref().map(|d| d.join(format!("{key}.img")));
        let missing = self.dir.as_ref().map(|d| d.join(format!("{key}.missing")));
        if let Some(path) = image.as_ref().filter(|p| fresh(p))
            && let Ok(bytes) = std::fs::read(path)
        {
            return Avatar::Image(bytes);
        }
        if missing.as_ref().is_some_and(|p| fresh(p)) {
            self.missing.lock().unwrap().insert(key);
            return Avatar::None;
        }

        let mut urls = Vec::new();
        let mut temporary = false;
        if let Some(url) = noreply_avatar_url(email) {
            urls.push(url);
        }
        if let Some((owner, repo)) = github {
            let (url, answered) = github_commit_avatar(owner, repo, commit_hash, token);
            temporary |= !answered;
            urls.extend(url);
        }
        // 메일로 GitHub 계정 사진을 찾는다(커밋을 물을 수 없는 비공개 레포지토리에서도 된다). 없으면 Gravatar.
        urls.push(github_email_avatar_url(email));
        urls.push(gravatar_url(email));
        for url in urls {
            match download(&url) {
                Download::Ok(bytes) => {
                    if let (Some(dir), Some(path)) = (&self.dir, &image) {
                        let _ = std::fs::create_dir_all(dir);
                        let _ = std::fs::write(path, &bytes);
                        if let Some(m) = &missing {
                            let _ = std::fs::remove_file(m);
                        }
                    }
                    return Avatar::Image(bytes);
                }
                Download::Temporary => temporary = true,
                Download::Missing => {}
            }
        }
        self.missing.lock().unwrap().insert(key);
        if !temporary && let (Some(dir), Some(path)) = (&self.dir, &missing) {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(path, b"");
        }
        Avatar::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 원본 Tests/Editor/GitAvatarSourcesTests.cs 의 규칙.

    #[test]
    fn noreply_addresses() {
        assert_eq!(
            noreply_avatar_url("12345+octo@users.noreply.github.com").as_deref(),
            Some("https://avatars.githubusercontent.com/u/12345?s=64")
        );
        assert_eq!(noreply_avatar_url("octo@users.noreply.github.com").as_deref(), Some("https://github.com/octo.png?size=64"));
        assert_eq!(noreply_avatar_url("octo@example.com"), None);
    }

    #[test]
    fn github_email_avatar_escapes_email() {
        assert_eq!(github_email_avatar_url(" Kim+Dev@Example.com "), format!("https://avatars.githubusercontent.com/u/e?email=Kim%2BDev@Example.com&s={SIZE}"));
    }

    #[test]
    fn github_remotes() {
        for url in ["git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://github.com/o/r.git", "https://github.com/o/r/"] {
            assert_eq!(parse_github_remote(url), Some(("o".into(), "r".into())), "{url}");
        }
        assert_eq!(parse_github_remote("https://gitlab.com/o/r.git"), None);
    }

    #[test]
    fn ai_authors() {
        assert_eq!(ai_author("noreply@anthropic.com"), Some(AiAuthor::Claude));
        assert_eq!(ai_author("claude@users.noreply.github.com"), Some(AiAuthor::Claude));
        assert_eq!(ai_author("codex@openai.com"), Some(AiAuthor::OpenAi));
        assert_eq!(ai_author("gemini-code-assist@google.com"), Some(AiAuthor::Gemini));
        assert_eq!(ai_author("someone@example.com"), None);
        assert_eq!(ai_author("@anthropic.com"), None);
    }

    #[test]
    fn gravatar_and_cache_key_normalize_email() {
        assert_eq!(gravatar_url(" Me@Example.com "), gravatar_url("me@example.com"));
        assert!(gravatar_url("me@example.com").ends_with("?s=64&d=404"));
        assert_eq!(cache_key("A@b.c"), cache_key("a@b.c"));
        assert_eq!(cache_key("a@b.c").len(), 40);
    }

    #[test]
    fn ai_author_needs_no_network() {
        let cache = AvatarCache::new(None);
        assert_eq!(cache.get("noreply@anthropic.com", "x", None, None), Avatar::Ai(AiAuthor::Claude));
        assert_eq!(cache.get("  ", "x", None, None), Avatar::None);
    }
}
