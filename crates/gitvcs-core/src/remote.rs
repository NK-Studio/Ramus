//! 저장소 밖에서 하는 원격 작업: clone, 연결 테스트(SSL 설정 확인), macOS 키체인 인증서 내보내기.

use std::path::{Path, PathBuf};

use crate::repo::{GitError, Repository, Result};
use crate::runner::GitRunner;

/// 주소에서 폴더 이름을 정한다: `https://x/team/game.git` → `game`, `nas:repos/a b.git/` → `a b`.
pub fn default_clone_name(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':', '\\']).next().unwrap_or(trimmed);
    let name = last.strip_suffix(".git").unwrap_or(last);
    if name.is_empty() { "repository".into() } else { name.to_string() }
}

/// `url` 을 `dest` 에 clone 한다. `dest` 는 없거나 빈 폴더여야 한다.
pub fn clone(git: &GitRunner, url: &str, dest: &Path) -> Result<Repository> {
    if url.trim().is_empty() {
        return Err(GitError::new("저장소 주소를 적어 주세요."));
    }
    if dest.exists() && std::fs::read_dir(dest).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(GitError::new(format!("이미 파일이 있는 폴더입니다: {}", dest.display())));
    }
    let parent = dest.parent().ok_or_else(|| GitError::new("저장할 폴더가 잘못되었습니다."))?;
    std::fs::create_dir_all(parent).map_err(|e| GitError::new(format!("폴더를 만들지 못했습니다: {e}")))?;
    let out = git.run(parent, &["clone", "--", url.trim(), &dest.display().to_string()]);
    if !out.success() {
        // 실패하면 git 이 만들다 만 폴더를 지운다(빈 폴더를 미리 고른 경우는 남긴다).
        if dest.exists() && std::fs::read_dir(dest).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(dest);
        }
        return Err(GitError::new(out.message()));
    }
    Repository::open(git.clone(), dest)
}

/// 원격에 붙어 보기만 한다(`git ls-remote`). SSL·로그인 설정이 맞는지 확인할 때 쓴다. 성공하면 받은 브랜치 수.
pub fn test_connection(git: &GitRunner, dir: &Path, url: &str) -> Result<usize> {
    let out = git.run(dir, &["ls-remote", "--heads", "--", url.trim()]);
    if out.success() { Ok(out.stdout.lines().count()) } else { Err(GitError::new(out.message())) }
}

/// macOS 키체인(로그인·시스템·시스템 루트)의 인증서를 PEM 하나로 모은다. 회사 루트 인증서를 키체인에 넣어 두었으면 git 이 그 파일로 확인할 수 있다.
pub fn export_mac_keychain(dest_dir: &Path) -> Result<PathBuf> {
    let security = Path::new("/usr/bin/security");
    if !security.exists() {
        return Err(GitError::new("이 기능은 macOS 에서만 됩니다."));
    }
    let mut pem = String::new();
    for args in [&["find-certificate", "-a", "-p"][..], &["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"][..]] {
        if let Ok(out) = std::process::Command::new(security).args(args).output()
            && out.status.success()
        {
            pem.push_str(&String::from_utf8_lossy(&out.stdout));
        }
    }
    if !pem.contains("BEGIN CERTIFICATE") {
        return Err(GitError::new("키체인에서 인증서를 꺼내지 못했습니다."));
    }
    std::fs::create_dir_all(dest_dir).map_err(|e| GitError::new(e.to_string()))?;
    let path = dest_dir.join("ca-bundle.pem");
    std::fs::write(&path, pem).map_err(|e| GitError::new(e.to_string()))?;
    Ok(path)
}

impl Repository {
    /// 원격 주소. 없으면 None.
    pub fn remote_url(&self, name: &str) -> Option<String> {
        self.git_run(&["remote", "get-url", "--", name]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    /// 푸시·풀에 쓸 원격(지금 브랜치의 upstream 원격, 없으면 origin, 없으면 첫 원격)의 주소.
    pub fn default_remote_url(&self) -> Option<String> {
        let remotes = self.remotes().ok()?;
        let upstream = self.status().ok()?.branch.upstream;
        let name = upstream
            .and_then(|u| remotes.iter().find(|r| u.starts_with(&format!("{r}/"))).cloned())
            .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
            .or_else(|| remotes.first().cloned())?;
        self.remote_url(&name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_names() {
        assert_eq!(default_clone_name("https://github.com/NK-Studio/com.nkstudio.gitvcs.git"), "com.nkstudio.gitvcs");
        assert_eq!(default_clone_name("tester@nas.local:volume1/git/game.git/"), "game");
        assert_eq!(default_clone_name("nas:a b.git"), "a b");
        assert_eq!(default_clone_name("C:\\repos\\x"), "x");
        assert_eq!(default_clone_name(""), "repository");
    }
}
