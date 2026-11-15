//! 앱 업데이트 확인과 내려받기. 설치(파일 바꾸기·다시 띄우기)는 운영체제마다 달라 앱 쪽(ramus-app/src/updater.rs)이 한다.
//!
//! 릴리스 워크플로가 `site/manifest.json` 을 만들어 main 에 커밋하면 Cloudflare Workers(GitHub 연결)가 정적 사이트로 배포한다. 최신판과 그 아래 두 판까지만 적고,
//! 설치 파일 자체는 GitHub 릴리스에 있다(매니페스트에는 주소·SHA-256·크기만):
//!
//! ```json
//! { "schema": 1, "page": "https://…/",
//!   "releases": [ { "version": "1.6.4", "date": "2026-11-16", "notes": "### 추가\n- …",
//!                   "assets": { "macos-arm64": { "url": "https://github.com/…", "sha256": "…", "size": 123 } } } ] }
//! ```

use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::repo::{GitError, Result};
use crate::trf;

const USER_AGENT: &str = concat!("Ramus/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    #[serde(default)]
    pub schema: u32,
    /// 내려받기 페이지(최신판과 이전 판들). 앱이 직접 설치할 수 없을 때 연다.
    #[serde(default)]
    pub page: String,
    #[serde(default)]
    pub releases: Vec<Release>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Release {
    pub version: String,
    #[serde(default)]
    pub date: String,
    /// 그 판의 변경 기록(ChangeLog.md 의 항목, 마크다운).
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub assets: std::collections::HashMap<String, Asset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Asset {
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

/// "1.6.4"·"v1.6.4" → (1, 6, 4). 뒤의 "-beta" 같은 꼬리는 버린다. 못 읽으면 None.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let version = (parts.next()??, parts.next().flatten().unwrap_or(0), parts.next().flatten().unwrap_or(0));
    Some(version)
}

/// 이 실행 파일이 받을 설치 파일의 이름(매니페스트 `assets` 의 키). 지원하지 않는 운영체제·CPU 면 None.
pub fn asset_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("windows", "x86_64") => Some("windows-x64-setup"),
        _ => None,
    }
}

impl Manifest {
    /// `current` 보다 새 판들, 새것부터.
    pub fn newer_than(&self, current: &str) -> Vec<&Release> {
        let Some(now) = parse_version(current) else { return Vec::new() };
        let mut newer: Vec<&Release> = self.releases.iter().filter(|r| parse_version(&r.version).is_some_and(|v| v > now)).collect();
        newer.sort_by_key(|r| std::cmp::Reverse(parse_version(&r.version)));
        newer
    }
}

/// 매니페스트를 읽는다. https 주소만.
pub fn fetch_manifest(url: &str) -> Result<Manifest> {
    if !url.starts_with("https://") {
        return Err(GitError::new(trf!("업데이트 주소가 https 가 아닙니다: {url}", "The update address isn't https: {url}")));
    }
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Cache-Control", "no-cache")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| GitError::new(trf!("업데이트 정보를 받지 못했습니다: {e}", "Couldn't get update information: {e}")))?;
    let mut text = String::new();
    response
        .into_reader()
        .take(4 * 1024 * 1024)
        .read_to_string(&mut text)
        .map_err(|e| GitError::new(trf!("업데이트 정보를 받지 못했습니다: {e}", "Couldn't get update information: {e}")))?;
    serde_json::from_str(&text).map_err(|e| GitError::new(trf!("업데이트 정보를 읽지 못했습니다: {e}", "Couldn't read update information: {e}")))
}

/// 설치 파일을 `dest` 로 내려받고 SHA-256 을 맞춰 본다. 받는 동안 `progress(받은 바이트, 전체 바이트)` 를 0.1초마다 부른다.
/// 받다 끊기거나 해시가 다르면 받던 파일을 지우고 오류.
pub fn download(asset: &Asset, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<()> {
    if !asset.url.starts_with("https://") {
        return Err(GitError::new(trf!("설치 파일 주소가 https 가 아닙니다: {}", "The installer address isn't https: {}", asset.url)));
    }
    let expected = asset.sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::new(trf!("업데이트 정보에 올바른 SHA-256 이 없습니다.", "The update information has no valid SHA-256.")));
    }
    let failed = |e: &dyn std::fmt::Display| GitError::new(trf!("업데이트를 내려받지 못했습니다: {e}", "Couldn't download the update: {e}"));
    // 큰 파일이라 전체 시간 제한은 두지 않고, 연결과 읽기가 멈추면 끊는다.
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(60)).build();
    let response = agent.get(&asset.url).set("User-Agent", USER_AGENT).call().map_err(|e| failed(&e))?;
    let total = response.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(asset.size);

    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| failed(&e))?;
    }
    let part = dest.with_extension("part");
    let result = (|| -> Result<()> {
        let mut file = std::fs::File::create(&part).map_err(|e| failed(&e))?;
        let mut reader = response.into_reader();
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        let mut received = 0u64;
        let mut last = Instant::now();
        progress(0, total);
        loop {
            let n = reader.read(&mut buffer).map_err(|e| failed(&e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            file.write_all(&buffer[..n]).map_err(|e| failed(&e))?;
            received += n as u64;
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                progress(received, total);
            }
        }
        file.sync_all().map_err(|e| failed(&e))?;
        progress(received, total.max(received));
        let actual = hex(&hasher.finalize());
        if actual != expected {
            return Err(GitError::new(trf!(
                "내려받은 파일이 손상되었습니다(SHA-256 이 다릅니다).",
                "The downloaded file is corrupted (SHA-256 mismatch)."
            )));
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            let _ = std::fs::remove_file(dest);
            std::fs::rename(&part, dest).map_err(|e| failed(&e))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(versions: &[&str]) -> Manifest {
        Manifest {
            schema: 1,
            page: String::new(),
            releases: versions
                .iter()
                .map(|v| Release { version: v.to_string(), date: String::new(), notes: String::new(), assets: Default::default() })
                .collect(),
        }
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("1.6.3"), Some((1, 6, 3)));
        assert_eq!(parse_version("v1.10.0"), Some((1, 10, 0)));
        assert_eq!(parse_version("2.0.0-beta.1"), Some((2, 0, 0)));
        assert_eq!(parse_version("2"), Some((2, 0, 0)));
        assert_eq!(parse_version("abc"), None);
        assert!(parse_version("1.10.0") > parse_version("1.9.9"));
    }

    #[test]
    fn lists_newer_releases_newest_first() {
        let m = manifest(&["1.6.2", "1.6.4", "1.7.0", "1.6.3"]);
        let newer: Vec<&str> = m.newer_than("1.6.3").iter().map(|r| r.version.as_str()).collect();
        assert_eq!(newer, ["1.7.0", "1.6.4"]);
        assert!(m.newer_than("1.7.0").is_empty());
    }

    #[test]
    fn reads_manifest_json() {
        let text = r#"{"schema":1,"page":"https://x/","releases":[{"version":"1.6.4","date":"2026-11-16","notes":"- a",
            "assets":{"macos-arm64":{"url":"https://github.com/a","sha256":"00","size":3}}}]}"#;
        let m: Manifest = serde_json::from_str(text).unwrap();
        assert_eq!(m.releases[0].assets["macos-arm64"].size, 3);
    }

    #[test]
    fn rejects_bad_hash_before_downloading() {
        let asset = Asset { url: "https://example.invalid/a".into(), sha256: "nothex".into(), size: 0 };
        let dir = tempfile::tempdir().unwrap();
        assert!(download(&asset, &dir.path().join("a"), |_, _| {}).is_err());
        let http = Asset { url: "http://example.invalid/a".into(), sha256: "0".repeat(64), size: 0 };
        assert!(download(&http, &dir.path().join("a"), |_, _| {}).is_err());
    }
}
