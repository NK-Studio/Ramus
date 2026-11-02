//! 앱 설정과 최근 저장소 목록. 사용자 설정 폴더의 JSON 하나에 둔다
//! (macOS `~/Library/Application Support/GitVcs/settings.json`, Windows `%APPDATA%\GitVcs\settings.json`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::repo::PullMode;
use crate::ssl::SslSettings;

/// 최근 저장소를 몇 개까지 기억하는가.
pub const MAX_RECENT: usize = 15;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    /// 유닉스 초.
    pub opened_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// "dark" 또는 "light".
    pub theme: String,
    pub recent: Vec<RecentRepo>,
    /// 마지막에 열었던 저장소. 앱을 다시 켜면 연다.
    pub last_repo: Option<String>,
    /// 비우면 PATH 의 git.
    pub git_path: String,
    pub ssl: SslSettings,
    pub pull_mode: PullMode,
    /// 자동 페치 간격(분). 0 이면 끈다.
    pub auto_fetch_minutes: u32,
    /// diff 배치: "inline" 또는 "split".
    pub diff_layout: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            recent: Vec::new(),
            last_repo: None,
             git_path: String::new(),
            ssl: SslSettings::default(),
            pull_mode: PullMode::FfOnly,
            auto_fetch_minutes: 10,
            diff_layout: "inline".into(),
        }
    }
}

impl Settings {
    pub fn default_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("GitVcs").join("settings.json"))
    }

    /// 파일이 없거나 깨졌으면 기본값.
    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        // 쓰다 끊겨도 설정이 날아가지 않게 옆 파일에 쓰고 바꾼다.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)
    }

    /// 연 저장소를 최근 목록 맨 앞에 둔다. 같은 경로는 하나만.
    pub fn touch_recent(&mut self, path: &str, name: &str, now: i64) {
        self.recent.retain(|r| !same_path(&r.path, path));
        self.recent.insert(0, RecentRepo { path: path.to_string(), name: name.to_string(), opened_at: now });
        self.recent.truncate(MAX_RECENT);
        self.last_repo = Some(path.to_string());
    }

    pub fn remove_recent(&mut self, path: &str) {
        self.recent.retain(|r| !same_path(&r.path, path));
        if self.last_repo.as_deref().is_some_and(|p| same_path(p, path)) {
            self.last_repo = None;
        }
    }
}

/// Windows 는 경로의 대소문자·구분자를 가리지 않는다.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.replace('\\', "/").eq_ignore_ascii_case(&b.replace('\\', "/"))
    } else {
        a.trim_end_matches('/') == b.trim_end_matches('/')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_is_deduplicated_and_capped() {
        let mut s = Settings::default();
        for i in 0..20 {
            s.touch_recent(&format!("/r/{i}"), &i.to_string(), i);
        }
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(s.recent[0].path, "/r/19");
        s.touch_recent("/r/10/", "10", 99);
        assert_eq!(s.recent[0].opened_at, 99);
        assert_eq!(s.recent.iter().filter(|r| r.name == "10").count(), 1);
        assert_eq!(s.last_repo.as_deref(), Some("/r/10/"));
        s.remove_recent("/r/10");
        assert!(s.recent.iter().all(|r| r.name != "10"));
        assert_eq!(s.last_repo, None);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x").join("settings.json");
        let mut s = Settings::default();
        s.theme = "light".into();
        s.ssl.verify = false;
        s.touch_recent("/a", "a", 1);
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
    }

    #[test]
    fn missing_or_broken_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(&dir.path().join("none.json")), Settings::default());
        let broken = dir.path().join("b.json");
        std::fs::write(&broken, "{ not json").unwrap();
        assert_eq!(Settings::load(&broken), Settings::default());
        // 모르는 키·빠진 키가 있어도 읽는다.
        std::fs::write(&broken, r#"{"theme":"light","future":1}"#).unwrap();
        assert_eq!(Settings::load(&broken).theme, "light");
    }
}
