//! 사이드바·메뉴의 작업: 원격 관리, 워크트리, 서브모듈, upstream, 병합 방식, 브랜치 하나 푸시·앞으로 감기, 원격 태그 지우기, stash 에서 브랜치.

use serde::{Deserialize, Serialize};

use crate::repo::{GitError, Repository, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: String,
    /// 체크아웃한 브랜치(짧은 이름). 분리된 HEAD 면 None.
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
    /// 지금 연 저장소의 워크트리.
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleState {
    /// 기록된 커밋과 같다.
    Ok,
    /// 기록된 커밋과 다른 커밋을 보고 있다.
    Modified,
    /// 아직 받지 않았다(update 필요).
    Uninitialized,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub name: String,
    pub path: String,
    pub url: String,
    pub branch: Option<String>,
    pub hash: String,
    pub state: SubmoduleState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    #[default]
    Default,
    NoFf,
    Squash,
    FfOnly,
}

pub fn parse_remotes(output: &str) -> Vec<Remote> {
    let mut remotes: Vec<Remote> = Vec::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let index = match remotes.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                remotes.push(Remote { name: name.into(), fetch_url: String::new(), push_url: String::new() });
                remotes.len() - 1
            }
        };
        if kind == "(push)" {
            remotes[index].push_url = url.into();
        } else {
            remotes[index].fetch_url = url.into();
        }
    }
    remotes
}

pub fn parse_worktrees(output: &str, current_root: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    for block in output.split("\n\n") {
        let mut w = Worktree { path: String::new(), head: String::new(), branch: None, bare: false, locked: false, prunable: false, current: false };
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                w.path = p.to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                w.head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                w.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "bare" {
                w.bare = true;
            } else if line.starts_with("locked") {
                w.locked = true;
            } else if line.starts_with("prunable") {
                w.prunable = true;
            }
        }
        if !w.path.is_empty() {
            w.current = same_dir(&w.path, current_root);
            list.push(w);
        }
    }
    list
}

fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) { norm(a).eq_ignore_ascii_case(&norm(b)) } else { norm(a) == norm(b) }
}

/// `git submodule status` 와 `.gitmodules` 설정을 합친다.
pub fn parse_submodules(status: &str, config: &str) -> Vec<Submodule> {
    let mut list = Vec::new();
    // submodule.<name>.path / url / branch
    let mut entries: Vec<(String, String, String)> = Vec::new();
    for line in config.lines() {
        let Some((key, value)) = line.split_once(' ') else { continue };
        let Some(rest) = key.strip_prefix("submodule.") else { continue };
        let Some(dot) = rest.rfind('.') else { continue };
        entries.push((rest[..dot].to_string(), rest[dot + 1..].to_string(), value.to_string()));
    }
    let get = |name: &str, field: &str| entries.iter().find(|(n, f, _)| n == name && f == field).map(|(_, _, v)| v.clone());
    let mut names: Vec<String> = entries.iter().map(|(n, _, _)| n.clone()).collect();
    names.dedup();
    for line in status.lines() {
        if line.len() < 2 {
            continue;
        }
        let state = match line.as_bytes()[0] {
            b'-' => SubmoduleState::Uninitialized,
            b'+' => SubmoduleState::Modified,
            b'U' => SubmoduleState::Conflict,
            _ => SubmoduleState::Ok,
        };
        let rest = &line[1..];
        let mut parts = rest.splitn(2, ' ');
        let hash = parts.next().unwrap_or_default().to_string();
        let path_part = parts.next().unwrap_or_default();
        // "path (describe)" — 경로에 공백이 있을 수 있어 끝의 괄호만 뗀다.
        let path = match path_part.rfind(" (") {
            Some(at) if path_part.ends_with(')') => &path_part[..at],
            _ => path_part,
        }
        .to_string();
        let name = names.iter().find(|n| get(n, "path").as_deref() == Some(path.as_str())).cloned().unwrap_or_else(|| path.clone());
        list.push(Submodule { url: get(&name, "url").unwrap_or_default(), branch: get(&name, "branch"), name, path, hash, state });
    }
    list
}

/// 원격 주소에서 폴더 이름을 짐작한다(서브모듈 경로 자동 채우기).
pub fn path_from_url(url: &str) -> String {
    crate::remote::default_clone_name(url)
}

impl Repository {
    pub fn remote_list(&self) -> Result<Vec<Remote>> {
        Ok(parse_remotes(&self.git_run(&["remote", "-v"])?))
    }

    pub fn add_remote(&self, name: &str, url: &str, push_url: &str) -> Result<()> {
        if name.trim().is_empty() || url.trim().is_empty() {
            return Err(GitError::new("이름과 주소를 적어 주세요."));
        }
        self.git_run(&["remote", "add", "--", name.trim(), url.trim()])?;
        if !push_url.trim().is_empty() && push_url.trim() != url.trim() {
            self.git_run(&["remote", "set-url", "--push", name.trim(), push_url.trim()])?;
        }
        Ok(())
    }

    pub fn rename_remote(&self, old: &str, new: &str) -> Result<()> {
        self.git_run(&["remote", "rename", old, new.trim()]).map(|_| ())
    }

    pub fn set_remote_url(&self, name: &str, url: &str, push_url: &str) -> Result<()> {
        self.git_run(&["remote", "set-url", name, url.trim()])?;
        let push = if push_url.trim().is_empty() { url.trim() } else { push_url.trim() };
        self.git_run(&["remote", "set-url", "--push", name, push]).map(|_| ())
    }

    pub fn remove_remote(&self, name: &str) -> Result<()> {
        self.git_run(&["remote", "remove", name]).map(|_| ())
    }

    pub fn prune_remote(&self, name: &str) -> Result<String> {
        self.git_run(&["remote", "prune", name])
    }

    pub fn fetch_remote(&self, name: &str) -> Result<()> {
        self.git_run(&["fetch", "--prune", "--quiet", name]).map(|_| ())
    }

    /// 브랜치 하나를 원격에 올린다. upstream 이 없으면 걸어 준다.
    pub fn push_branch(&self, branch: &str, remote: &str, set_upstream: bool, force: bool) -> Result<String> {
        let mut args = vec!["push"];
        if set_upstream {
            args.push("-u");
        }
        if force {
            args.push("--force-with-lease");
        }
        args.extend([remote, branch]);
        self.git_run_with_env(&args, &[])
    }

    pub fn set_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<()> {
        match upstream {
            Some(u) => self.git_run(&["branch", "--set-upstream-to", u, "--", branch]).map(|_| ()),
            None => self.git_run(&["branch", "--unset-upstream", "--", branch]).map(|_| ()),
        }
    }

    /// 브랜치를 upstream 으로 앞으로 감는다(체크아웃하지 않은 브랜치도). 갈라졌으면 실패한다.
    pub fn fast_forward(&self, branch: &str, current: bool) -> Result<()> {
        if current {
            return self.git_run(&["merge", "--ff-only", "@{u}"]).map(|_| ());
        }
        let upstream = self.git_run(&["rev-parse", "--abbrev-ref", &format!("{branch}@{{u}}")])?.trim().to_string();
        self.git_run(&["fetch", ".", &format!("{upstream}:refs/heads/{branch}")]).map(|_| ()).map_err(|e| {
            if e.message.contains("non-fast-forward") || e.message.contains("rejected") {
                GitError::new(format!("'{branch}' 와 '{upstream}' 가 갈라져 앞으로 감을 수 없습니다. 체크아웃한 뒤 병합하거나 Rebase 해 주세요."))
            } else {
                e
            }
        })
    }

    pub fn merge_with(&self, revision: &str, mode: MergeMode) -> Result<String> {
        let mut args = vec!["merge", "--no-edit"];
        match mode {
            MergeMode::Default => {}
            MergeMode::NoFf => args.push("--no-ff"),
            MergeMode::Squash => args.push("--squash"),
            MergeMode::FfOnly => args.push("--ff-only"),
        }
        args.push(revision);
        self.git_run(&args)
    }

    pub fn delete_remote_tag(&self, remote: &str, name: &str) -> Result<()> {
        self.git_run(&["push", remote, &format!(":refs/tags/{name}")]).map(|_| ())
    }

    pub fn stash_branch(&self, branch: &str, stash: &str) -> Result<()> {
        self.check_branch_name(branch)?;
        self.git_run(&["stash", "branch", branch, stash]).map(|_| ())
    }

    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let out = self.git_run(&["worktree", "list", "--porcelain"])?;
        Ok(parse_worktrees(&out, &self.root().display().to_string()))
    }

    /// 워크트리를 더한다. `new_branch` 면 `reference` 에서 그 이름의 브랜치를 새로 만든다.
    pub fn add_worktree(&self, path: &str, reference: &str, new_branch: Option<&str>) -> Result<()> {
        if path.trim().is_empty() {
            return Err(GitError::new("폴더를 적어 주세요."));
        }
        match new_branch.filter(|b| !b.trim().is_empty()) {
            Some(b) => {
                self.check_branch_name(b)?;
                self.git_run(&["worktree", "add", "-b", b.trim(), path.trim(), reference]).map(|_| ())
            }
            None => self.git_run(&["worktree", "add", path.trim(), reference]).map(|_| ()),
        }
    }

    pub fn remove_worktree(&self, path: &str, force: bool) -> Result<()> {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(path);
        self.git_run(&args).map(|_| ())
    }

    pub fn submodules(&self) -> Result<Vec<Submodule>> {
        if !self.root().join(".gitmodules").exists() {
            return Ok(Vec::new());
        }
        let status = self.git_run(&["submodule", "status"]).unwrap_or_default();
        let config = self.git_run(&["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.(path|url|branch)$"]).unwrap_or_default();
        Ok(parse_submodules(&status, &config))
    }

    pub fn add_submodule(&self, url: &str, path: &str, branch: Option<&str>) -> Result<()> {
        let mut args = vec!["-c", "protocol.file.allow=always", "submodule", "add"];
        if let Some(b) = branch.filter(|b| !b.trim().is_empty()) {
            args.extend(["-b", b]);
        }
        args.extend(["--", url.trim(), path.trim()]);
        self.git_run(&args).map(|_| ())
    }

    /// 서브모듈을 기록된 커밋으로 받는다(`path` 가 없으면 전부).
    pub fn update_submodules(&self, path: Option<&str>) -> Result<()> {
        let mut args = vec!["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"];
        if let Some(p) = path {
            args.extend(["--", p]);
        }
        self.git_run(&args).map(|_| ())
    }

    pub fn edit_submodule(&self, path: &str, url: &str, branch: Option<&str>) -> Result<()> {
        self.git_run(&["submodule", "set-url", "--", path, url.trim()])?;
        match branch.filter(|b| !b.trim().is_empty()) {
            Some(b) => self.git_run(&["submodule", "set-branch", "--branch", b.trim(), "--", path]).map(|_| ()),
            None => self.git_run(&["submodule", "set-branch", "--default", "--", path]).map(|_| ()).or(Ok(())),
        }
    }

    /// `commit.template` 파일 내용(없으면 None).
    pub fn commit_template(&self) -> Option<String> {
        let path = self.git_run(&["config", "--path", "--get", "commit.template"]).ok()?;
        let path = std::path::PathBuf::from(path.trim());
        let path = if path.is_absolute() { path } else { self.root().join(path) };
        std::fs::read_to_string(path).ok()
    }

    /// 멈춘 병합이 준비한 메시지(MERGE_MSG). '#' 줄은 뺀다.
    pub fn merge_message(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.git_dir().join("MERGE_MSG")).ok()?;
        let text = text.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n");
        Some(text.trim().to_string()).filter(|t| !t.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_urls() {
        let r = parse_remotes("origin\thttps://a/x.git (fetch)\norigin\tgit@a:x.git (push)\nfork\t/p (fetch)\nfork\t/p (push)\n");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].fetch_url, "https://a/x.git");
        assert_eq!(r[0].push_url, "git@a:x.git");
        assert_eq!(r[1].name, "fork");
    }

    #[test]
    fn parses_worktrees() {
        let out = "worktree /r/main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/feat\nHEAD bbb\ndetached\nlocked\n\nworktree /r/gone\nHEAD ccc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n";
        let w = parse_worktrees(out, "/r/main/");
        assert_eq!(w.len(), 3);
        assert!(w[0].current);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert_eq!(w[1].branch, None);
        assert!(w[1].locked);
        assert!(w[2].prunable);
    }

    #[test]
    fn parses_submodules() {
        let status = " 1111 lib/a (heads/main)\n-2222 lib/b c\n+3333 lib/c (v1)\n";
        let config = "submodule.a.path lib/a\nsubmodule.a.url https://x/a.git\nsubmodule.a.branch main\nsubmodule.bb.path lib/b c\nsubmodule.bb.url ../b\n";
        let s = parse_submodules(status, config);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].name, "a");
        assert_eq!(s[0].branch.as_deref(), Some("main"));
        assert_eq!(s[0].state, SubmoduleState::Ok);
        assert_eq!(s[1].path, "lib/b c");
        assert_eq!(s[1].name, "bb");
        assert_eq!(s[1].state, SubmoduleState::Uninitialized);
        assert_eq!(s[2].state, SubmoduleState::Modified);
        assert_eq!(s[2].name, "lib/c");
    }
}
