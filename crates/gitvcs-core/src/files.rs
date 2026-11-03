//! 파일 단위 작업: .gitignore 에 넣기, LFS 추적, 고른 파일만 stash, 패치 만들기, 파일 지우기, Stage 전 확인(충돌 표시·안의 git 저장소),
//! diff 의 두 판 크기, LFS 원본 받기. 원본 `Core/GitFileTools.cs`·`GitFileOperations` 를 옮겼다.

use std::path::Path;

use serde::Serialize;

use crate::repo::{DiffTarget, GitError, Repository, Result};

/// 무시·LFS 를 어떤 꼴로 넣는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PatternKind {
    /// 그 파일 하나.
    File,
    /// 같은 확장자 모두(*.png).
    Extension,
    /// 그 폴더 통째.
    Folder,
}

/// .gitignore·.gitattributes 에 쓸 패턴. 파일은 루트 기준 절대 패턴(/a/b.txt), 확장자는 *.ext, 폴더는 /a/b/.
pub fn pattern(path: &str, kind: PatternKind) -> Result<String> {
    let path = path.trim_start_matches('/');
    let escape = |p: &str| p.replace('\\', "\\\\").replace(' ', "\\ ").replace('[', "\\[").replace('*', "\\*").replace('?', "\\?");
    match kind {
        PatternKind::File => Ok(format!("/{}", escape(path))),
        PatternKind::Folder => Ok(format!("/{}/", escape(path.trim_end_matches('/')))),
        PatternKind::Extension => {
            let name = path.rsplit('/').next().unwrap_or(path);
            match name.rfind('.') {
                Some(at) if at > 0 && at + 1 < name.len() => Ok(format!("*{}", escape(&name[at..]))),
                _ => Err(GitError::new(format!("확장자가 없는 파일입니다: {name}"))),
            }
        }
    }
}

/// 크기·충돌 표시 확인 결과.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageWarnings {
    /// 충돌 표시(<<<<<<<)가 남은 파일.
    pub conflict_markers: Vec<String>,
    /// 안에 git 저장소가 있는 폴더(Stage 하면 gitlink 가 된다).
    pub nested_repos: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobSizes {
    pub old: Option<u64>,
    pub new: Option<u64>,
}

/// 충돌 표시가 들어 있는가(줄 맨 앞의 <<<<<<< · ======= · >>>>>>> 가 다 있을 때).
pub fn has_conflict_markers(text: &str) -> bool {
    let mut open = false;
    let mut middle = false;
    for line in text.lines() {
        if line.starts_with("<<<<<<< ") || line == "<<<<<<<" {
            open = true;
        } else if open && line.starts_with("=======") {
            middle = true;
        } else if open && middle && (line.starts_with(">>>>>>> ") || line == ">>>>>>>") {
            return true;
        }
    }
    false
}

/// LFS 포인터 파일인가(원본을 받지 않은 LFS 파일).
pub fn is_lfs_pointer(text: &str) -> bool {
    text.starts_with("version https://git-lfs.github.com/spec/v1")
}

fn append_line(path: &Path, line: &str) -> Result<()> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(line);
    text.push('\n');
    std::fs::write(path, text).map_err(|e| GitError::new(format!("{} 에 쓰지 못했습니다: {e}", path.display())))
}

impl Repository {
    /// .gitignore 에 넣는다. 이미 추적 중인 파일이면 인덱스에서 뺀다(작업 트리 파일은 그대로).
    pub fn ignore(&self, path: &str, kind: PatternKind) -> Result<String> {
        let pattern = pattern(path, kind)?;
        append_line(&self.root().join(".gitignore"), &pattern)?;
        let target = match kind {
            PatternKind::Extension => pattern.clone(),
            _ => path.to_string(),
        };
        let _ = self.git_run_full(&["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", &target], None, &[("GIT_LITERAL_PATHSPECS", if kind == PatternKind::Extension { "0" } else { "1" })]);
        Ok(pattern)
    }

    /// LFS 로 추적한다(.gitattributes). git-lfs 가 없으면 알려 준다.
    pub fn lfs_track(&self, path: &str, kind: PatternKind) -> Result<String> {
        let pattern = pattern(path, kind)?;
        self.git_run(&["lfs", "track", &pattern]).map_err(|e| {
            if e.message.contains("is not a git command") {
                GitError::new("git-lfs 가 설치되어 있지 않습니다. https://git-lfs.com 에서 설치해 주세요.")
            } else {
                e
            }
        })?;
        Ok(pattern)
    }

    /// 그 파일 하나의 LFS 원본을 받는다.
    pub fn lfs_pull(&self, path: &str) -> Result<()> {
        self.git_run(&["lfs", "pull", "--include", path, "--exclude", ""]).map(|_| ())
    }

    /// 고른 파일만 stash 한다(새 파일 포함).
    pub fn stash_paths(&self, paths: &[String], message: &str) -> Result<()> {
        let mut args = vec!["stash".to_string(), "push".into(), "--include-untracked".into()];
        if !message.trim().is_empty() {
            args.extend(["-m".into(), message.trim().to_string()]);
        }
        args.push("--".into());
        args.extend(paths.iter().cloned());
        self.git_run(&args).map(|_| ())
    }

    /// 고른 파일의 변경을 패치 글로. `staged` 면 Stage 한 것, 아니면 작업 트리(새 파일 포함).
    pub fn create_patch(&self, paths: &[String], staged: bool) -> Result<String> {
        let mut args = vec!["diff".to_string(), "--no-color".into(), "--no-ext-diff".into(), "--binary".into()];
        if staged {
            args.push("--cached".into());
        }
        args.push("--".into());
        args.extend(paths.iter().cloned());
        let mut patch = self.git_run(&args)?;
        if !staged {
            // 새 파일은 git diff 에 없다 — 하나씩 /dev/null 과 비교해 붙인다.
            let untracked = self.git_run(&["ls-files", "--others", "--exclude-standard", "-z", "--"]).unwrap_or_default();
            for path in untracked.split('\0').filter(|p| !p.is_empty() && paths.iter().any(|q| p == q || p.starts_with(&format!("{}/", q.trim_end_matches('/'))))) {
                patch.push_str(&self.no_index_diff(path));
            }
        }
        if patch.trim().is_empty() {
            return Err(GitError::new("패치로 만들 변경이 없습니다."));
        }
        Ok(patch)
    }

    /// --no-index 는 차이가 있으면 종료 코드 1 이라 성공·실패와 상관없이 stdout 을 쓴다.
    fn no_index_diff(&self, path: &str) -> String {
        let out = self.runner().run(self.root(), &["diff", "--no-color", "--no-index", "--binary", "--", "/dev/null", path]);
        out.stdout
    }

    /// 파일을 그 판의 내용으로 되돌린다(인덱스·작업 트리 모두). 그 판에 없던 파일이면 지운다.
    pub fn restore_file(&self, revision: &str, path: &str) -> Result<()> {
        if self.git_run(&["cat-file", "-e", &format!("{revision}:{path}")]).is_ok() {
            self.git_run(&["restore", &format!("--source={revision}"), "--staged", "--worktree", "--", path]).map(|_| ())
        } else {
            self.git_run(&["rm", "-f", "-q", "--ignore-unmatch", "--", path]).map(|_| ())
        }
    }

    /// 사용자가 설정한 diff 도구(git difftool)로 연다. 기다리지 않는다.
    pub fn external_diff(&self, from: &str, to: Option<&str>, path: &str, tool: Option<&str>) -> Result<()> {
        let globals = self.runner().globals();
        let git = globals.git_path.clone().unwrap_or_else(|| std::path::PathBuf::from("git"));
        let mut cmd = std::process::Command::new(git);
        cmd.current_dir(self.root()).args(&globals.config_args).args(["difftool", "--no-prompt"]);
        if let Some(tool) = tool.filter(|t| !t.trim().is_empty()) {
            cmd.args(["-t", tool.trim()]);
        }
        cmd.arg(from);
        if let Some(to) = to {
            cmd.arg(to);
        }
        cmd.args(["--", path]);
        cmd.spawn().map(|_| ()).map_err(|e| GitError::new(format!("diff 도구를 열지 못했습니다: {e}")))
    }

    /// 작업 트리에서 파일·폴더를 지운다(휴지통이 아니다).
    pub fn delete_path(&self, path: &str) -> Result<()> {
        let full = self.safe_path(path)?;
        let result = if full.is_dir() { std::fs::remove_dir_all(&full) } else { std::fs::remove_file(&full) };
        result.map_err(|e| GitError::new(format!("{path} 를 지우지 못했습니다: {e}")))
    }

    /// Stage 하기 전에 물어볼 것: 충돌 표시가 남은 파일, 안에 git 저장소가 있는 폴더.
    pub fn stage_warnings(&self, paths: &[String]) -> StageWarnings {
        let mut w = StageWarnings::default();
        for path in paths {
            let Ok(full) = self.safe_path(path) else { continue };
            if full.is_dir() {
                if full.join(".git").exists() {
                    w.nested_repos.push(path.clone());
                }
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&full)
                && meta.len() < 8 * 1024 * 1024
                && let Ok(text) = std::fs::read_to_string(&full)
                && has_conflict_markers(&text)
            {
                w.conflict_markers.push(path.clone());
            }
        }
        w
    }

    /// diff 의 두 판 크기(바이너리 카드에 보인다).
    pub fn blob_sizes(&self, target: &DiffTarget) -> BlobSizes {
        let size = |spec: &str| self.git_run(&["cat-file", "-s", spec]).ok().and_then(|s| s.trim().parse().ok());
        let disk = |path: &str| self.safe_path(path).ok().and_then(|p| std::fs::metadata(p).ok()).filter(|m| m.is_file()).map(|m| m.len());
        match target {
            DiffTarget::Unstaged { path, untracked: true } => BlobSizes { old: None, new: disk(path) },
            DiffTarget::Unstaged { path, .. } => BlobSizes { old: size(&format!(":0:{path}")), new: disk(path) },
            DiffTarget::Staged { path, original_path } => {
                BlobSizes { old: size(&format!("HEAD:{}", original_path.as_deref().unwrap_or(path))), new: size(&format!(":0:{path}")) }
            }
            DiffTarget::Commit { hash, path, original_path } => {
                BlobSizes { old: size(&format!("{hash}^:{}", original_path.as_deref().unwrap_or(path))), new: size(&format!("{hash}:{path}")) }
            }
            DiffTarget::Range { from, to, path, original_path, .. } => BlobSizes {
                old: size(&format!("{from}:{}", original_path.as_deref().unwrap_or(path))),
                new: match to {
                    Some(to) => size(&format!("{to}:{path}")),
                    None => disk(path),
                },
            },
        }
    }

    /// 그 판의 파일 내용(이미지 diff·파일 보기·이 버전 저장). `revision` 이 비면 작업 트리, ":0" 이면 인덱스.
    pub fn file_bytes(&self, revision: &str, path: &str) -> Result<Vec<u8>> {
        if revision.is_empty() {
            let full = self.safe_path(path)?;
            return std::fs::read(&full).map_err(|e| GitError::new(format!("{path} 를 읽지 못했습니다: {e}")));
        }
        let spec = if revision == ":0" { format!(":0:{path}") } else { format!("{revision}:{path}") };
        let out = self.runner().run_bytes(self.root(), &["cat-file", "-p", &spec]);
        if out.0 == 0 { Ok(out.1) } else { Err(GitError::new(format!("{spec} 를 읽지 못했습니다."))) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        assert_eq!(pattern("a/b c.txt", PatternKind::File).unwrap(), "/a/b\\ c.txt");
        assert_eq!(pattern("a/b.png", PatternKind::Extension).unwrap(), "*.png");
        assert_eq!(pattern("Assets/Art/", PatternKind::Folder).unwrap(), "/Assets/Art/");
        assert!(pattern("Makefile", PatternKind::Extension).is_err());
        assert!(pattern(".gitignore", PatternKind::Extension).is_err());
    }

    #[test]
    fn markers() {
        assert!(has_conflict_markers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n"));
        assert!(!has_conflict_markers("a\n=======\nb\n"));
        assert!(is_lfs_pointer("version https://git-lfs.github.com/spec/v1\noid sha256:x\nsize 3\n"));
    }
}
