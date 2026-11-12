//! 어떤 git 을 쓸지 정한다. 기본은 앱에 넣어 배포하는 내장 git(GitHub Desktop 의 dugite-native),
//! 설정에서 시스템 git(PATH) 이나 사용자가 고른 실행 파일로 바꿀 수 있다.
//!
//! 내장 git 자리: macOS `Ramus.app/Contents/Resources/git`, Windows `Ramus.exe` 옆 `git` 폴더.
//! 개발 중에는 `RAMUS_BUNDLED_GIT_DIR` 로 다른 자리를 줄 수 있고, 없으면(`cargo run`) 시스템 git 으로 돌아간다.
//! 고른 git 이 사라지면 앱이 못 켜지는 일이 없게 쓸 수 있는 다른 git 으로 돌아가고 그 사유를 `fallback` 에 남긴다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::i18n::tr;

/// 설정에서 고르는 git.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitMode {
    Bundled,
    System,
    Custom,
}

impl GitMode {
    /// 설정 문자열 → 모드. 옛 설정(모드 없이 경로만)이면 경로가 있을 때 직접 지정으로 본다.
    pub fn from_settings(mode: &str, custom_path: &str) -> GitMode {
        match mode {
            "bundled" => GitMode::Bundled,
            "system" => GitMode::System,
            "custom" => GitMode::Custom,
            _ if !custom_path.trim().is_empty() => GitMode::Custom,
            _ => GitMode::Bundled,
        }
    }
}

/// 실제로 쓸 git.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGit {
    /// 실제로 쓰는 것(고른 것을 못 써 돌아갔으면 고른 것과 다르다).
    pub source: GitMode,
    pub path: PathBuf,
    /// 내장 git 이 제 자리를 찾는 데 필요한 환경 변수. 다른 git 이면 비어 있다.
    pub env: HashMap<String, String>,
    /// 고른 git 을 못 써 돌아간 사유.
    pub fallback: Option<String>,
}

/// 내장 git 폴더(실행 파일이 있을 때만).
pub fn bundled_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("RAMUS_BUNDLED_GIT_DIR").map(PathBuf::from) {
        return bundled_binary(&dir).is_file().then_some(dir);
    }
    let exe = std::env::current_exe().ok()?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let parent = exe.parent()?;
    let dir = if cfg!(target_os = "macos") && parent.ends_with("Contents/MacOS") {
        parent.parent()?.join("Resources").join("git")
    } else {
        parent.join("git")
    };
    bundled_binary(&dir).is_file().then_some(dir)
}

/// 내장 git 폴더 안의 실행 파일.
pub fn bundled_binary(dir: &Path) -> PathBuf {
    if cfg!(windows) { dir.join("cmd").join("git.exe") } else { dir.join("bin").join("git") }
}

/// 내장 git 을 다른 자리로 옮겨 실행할 때 필요한 환경 변수(dugite 의 setupEnvironment 와 같다).
pub fn bundled_env(dir: &Path) -> HashMap<String, String> {
    let s = |p: PathBuf| p.display().to_string();
    let mut env = HashMap::new();
    if cfg!(windows) {
        let sub = if cfg!(target_arch = "aarch64") { "clangarm64" } else { "ucrt64" };
        let path = std::env::var("PATH").unwrap_or_default();
        env.insert("PATH".into(), format!("{};{};{path}", s(dir.join(sub).join("bin")), s(dir.join(sub).join("usr").join("bin"))));
        env.insert("GIT_EXEC_PATH".into(), s(dir.join(sub).join("libexec").join("git-core")));
    } else {
        env.insert("GIT_EXEC_PATH".into(), s(dir.join("libexec").join("git-core")));
        // macOS 의 /etc/gitconfig 대신 내장 git 의 기본 설정(자격 증명 도우미 등). 사용자 ~/.gitconfig 가 그 위에 덮는다.
        env.insert("GIT_CONFIG_SYSTEM".into(), s(dir.join("etc").join("gitconfig")));
        env.insert("GIT_TEMPLATE_DIR".into(), s(dir.join("share").join("git-core").join("templates")));
    }
    env
}

/// PATH(앱으로 켜면 짧으니 Homebrew 자리도)에서 찾은 시스템 git. 내장 git 은 빼고 찾는다.
pub fn find_system() -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut dirs: Vec<PathBuf> = std::env::var("PATH").unwrap_or_default().split(sep).filter(|d| !d.is_empty()).map(PathBuf::from).collect();
    if !cfg!(windows) {
        for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            if !dirs.iter().any(|d| d == Path::new(extra)) {
                dirs.push(PathBuf::from(extra));
            }
        }
    }
    let bundled = bundled_dir();
    dirs.into_iter().map(|d| d.join(name)).find(|p| {
        p.is_file() && !bundled.as_deref().is_some_and(|b| p.starts_with(b)) && !(cfg!(target_os = "macos") && p == Path::new("/usr/bin/git") && !mac_developer_tools())
    })
}

/// macOS 의 /usr/bin/git 은 명령줄 도구가 없으면 설치 창을 띄우는 대리 실행 파일이라, 도구가 있을 때만 시스템 git 으로 친다.
fn mac_developer_tools() -> bool {
    Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()).join("usr").join("bin").join("git").is_file())
        .unwrap_or(false)
}

/// `git --version` 의 버전 글자(예: "2.56.0"). 실행하지 못하거나 git 이 아니면 Err.
pub fn version(path: &Path, env: &HashMap<String, String>) -> Result<String, String> {
    let mut cmd = Command::new(path);
    cmd.arg("--version").envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::runner::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| crate::trf!("실행하지 못했습니다: {e}", "Couldn't run it: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    match text.trim().strip_prefix("git version ") {
        Some(v) if out.status.success() => Ok(v.trim().to_string()),
        // 다른 프로그램이면 그 프로그램의 사용법 글이 나오므로 그대로 보이지 않는다.
        _ => Err(tr("git 실행 파일이 아닙니다.", "Not a git executable.").into()),
    }
}

/// 고른 모드로 쓸 git 을 정한다. 못 쓰면 내장 → 시스템 차례로 돌아가고, 아무것도 없으면 PATH 의 "git" 그대로 둔다.
pub fn resolve(mode: GitMode, custom_path: &str) -> ResolvedGit {
    let bundled = || bundled_dir().map(|dir| ResolvedGit { source: GitMode::Bundled, path: bundled_binary(&dir), env: bundled_env(&dir), fallback: None });
    let system = || find_system().map(|path| ResolvedGit { source: GitMode::System, path, env: HashMap::new(), fallback: None });
    let with_note = |r: Option<ResolvedGit>, note: &str| r.map(|r| ResolvedGit { fallback: Some(note.to_string()), ..r });
    let last = || ResolvedGit { source: GitMode::System, path: PathBuf::from("git"), env: HashMap::new(), fallback: Some(tr("쓸 수 있는 git 을 찾지 못했습니다.", "Couldn't find a usable git.").into()) };
    match mode {
        GitMode::Bundled => bundled().or_else(|| with_note(system(), tr("내장 git 이 없어 시스템 git 을 씁니다.", "Bundled git is missing, so system git is used."))).unwrap_or_else(last),
        GitMode::System => system().or_else(|| with_note(bundled(), tr("시스템 git 을 찾지 못해 내장 git 을 씁니다.", "System git wasn't found, so bundled git is used."))).unwrap_or_else(last),
        GitMode::Custom => {
            let path = PathBuf::from(custom_path.trim());
            if !custom_path.trim().is_empty() && path.is_file() {
                ResolvedGit { source: GitMode::Custom, path, env: HashMap::new(), fallback: None }
            } else {
                let (to_bundled, to_system) = if custom_path.trim().is_empty() {
                    (
                        tr("지정한 git 경로가 비어 있어 내장 git 을 씁니다.", "The custom git path is empty, so bundled git is used.").to_string(),
                        tr("지정한 git 경로가 비어 있어 시스템 git 을 씁니다.", "The custom git path is empty, so system git is used.").to_string(),
                    )
                } else {
                    let custom = custom_path.trim();
                    (
                        crate::trf!("지정한 git({custom})을 찾지 못해 내장 git 을 씁니다.", "The custom git ({custom}) wasn't found, so bundled git is used."),
                        crate::trf!("지정한 git({custom})을 찾지 못해 시스템 git 을 씁니다.", "The custom git ({custom}) wasn't found, so system git is used."),
                    )
                };
                with_note(bundled(), &to_bundled).or_else(|| with_note(system(), &to_system)).unwrap_or_else(last)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_from_settings_keeps_old_custom_path() {
        assert_eq!(GitMode::from_settings("", ""), GitMode::Bundled);
        assert_eq!(GitMode::from_settings("", "/opt/git"), GitMode::Custom);
        assert_eq!(GitMode::from_settings("system", "/opt/git"), GitMode::System);
        assert_eq!(GitMode::from_settings("bundled", "/opt/git"), GitMode::Bundled);
        assert_eq!(GitMode::from_settings("custom", ""), GitMode::Custom);
    }

    #[test]
    fn missing_custom_git_falls_back_with_a_note() {
        let r = resolve(GitMode::Custom, "/no/such/git");
        assert_ne!(r.source, GitMode::Custom);
        assert!(r.fallback.unwrap().contains("/no/such/git"));
    }

    #[test]
    fn version_reads_git_and_rejects_others() {
        // 테스트를 돌리는 PC 에는 git 이 있다(다른 테스트도 쓴다).
        let git = find_system().expect("시스템 git");
        assert!(version(&git, &HashMap::new()).unwrap().chars().next().unwrap().is_ascii_digit());
        assert!(version(Path::new("/no/such/git"), &HashMap::new()).is_err());
        if cfg!(unix) {
            assert_eq!(version(Path::new("/bin/ls"), &HashMap::new()).unwrap_err(), "git 실행 파일이 아닙니다.");
        }
    }

    #[test]
    fn bundled_env_points_inside_the_folder() {
        let env = bundled_env(Path::new("/x/git"));
        assert!(env["GIT_EXEC_PATH"].starts_with("/x/git") || cfg!(windows));
    }
}
