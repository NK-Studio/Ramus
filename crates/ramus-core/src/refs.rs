//! 브랜치·태그·stash 목록과 그 작업들(체크아웃·만들기·지우기·병합·rebase·cherry-pick·revert·reset·stash).
//! 명령 인자는 원본 패키지 GitCommitCommands 와 같다.

use serde::{Deserialize, Serialize};

use crate::i18n::tr;
use crate::repo::{GitError, Repository, Result};

const FIELD: char = '\x1f';
const BRANCH_FORMAT: &str = "--format=%(refname)%1f%(objectname)%1f%(committerdate:unix)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)";
const TAG_FORMAT: &str = "--format=%(refname:strip=2)%1f%(objectname)%1f%(*objectname)%1f%(contents:subject)";
const STASH_FORMAT: &str = "--format=%gd%x1f%H%x1f%ct%x1f%gs";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// main, origin/main
    pub name: String,
    /// refs/heads/main, refs/remotes/origin/main
    pub ref_name: String,
    pub remote: Option<String>,
    pub hash: String,
    pub time: i64,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// upstream 이 지워졌다(`[gone]`).
    pub gone: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    /// 태그가 가리키는 커밋(주석 태그면 벗긴 것).
    pub hash: String,
    pub annotated: bool,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// stash@{0}
    pub name: String,
    pub hash: String,
    pub time: i64,
    /// "WIP on main: abc 메시지" 또는 "On main: 사용자 메시지"
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refs {
    pub local: Vec<Branch>,
    pub remote: Vec<Branch>,
    pub tags: Vec<Tag>,
    pub stashes: Vec<Stash>,
    pub remotes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// `[ahead 1, behind 2]`, `[gone]`
fn parse_track(track: &str) -> (u32, u32, bool) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    if inner == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in inner.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// `for-each-ref` 브랜치 출력. 원격의 HEAD 표시(origin/HEAD)는 뺀다.
pub fn parse_branches(output: &str, remotes: &[String]) -> (Vec<Branch>, Vec<Branch>) {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in output.lines() {
        let f: Vec<&str> = line.split(FIELD).collect();
        if f.len() < 6 {
            continue;
        }
        let (ahead, behind, gone) = parse_track(f[5]);
        let upstream = (!f[4].is_empty()).then(|| f[4].to_string());
        if let Some(name) = f[0].strip_prefix("refs/heads/") {
            local.push(Branch {
                name: name.to_string(),
                ref_name: f[0].to_string(),
                remote: None,
                hash: f[1].to_string(),
                time: f[2].parse().unwrap_or(0),
                current: f[3] == "*",
                upstream,
                ahead,
                behind,
                gone,
            });
        } else if let Some(name) = f[0].strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") {
                continue;
            }
            // 원격 이름에 '/' 가 들어갈 수 있으니 아는 원격 중 가장 긴 것을 고른다.
            let owner = remotes.iter().filter(|r| name.starts_with(&format!("{r}/"))).max_by_key(|r| r.len()).cloned();
            remote.push(Branch {
                name: name.to_string(),
                ref_name: f[0].to_string(),
                remote: owner.or_else(|| name.split('/').next().map(str::to_string)),
                hash: f[1].to_string(),
                time: f[2].parse().unwrap_or(0),
                current: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                gone: false,
            });
        }
    }
    (local, remote)
}

pub fn parse_tags(output: &str) -> Vec<Tag> {
    output
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FIELD).collect();
            (f.len() >= 4).then(|| Tag {
                name: f[0].to_string(),
                // 주석 태그는 %(*objectname) 에 커밋이 있다.
                hash: if f[2].is_empty() { f[1].to_string() } else { f[2].to_string() },
                annotated: !f[2].is_empty(),
                subject: f[3].to_string(),
            })
        })
        .collect()
}

pub fn parse_stashes(output: &str) -> Vec<Stash> {
    output
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(4, FIELD).collect();
            (f.len() == 4).then(|| Stash { name: f[0].to_string(), hash: f[1].to_string(), time: f[2].parse().unwrap_or(0), message: f[3].to_string() })
        })
        .collect()
}

impl Repository {
    pub fn refs(&self) -> Result<Refs> {
        let remotes = self.remotes()?;
        let out = self.git_run(&["for-each-ref", BRANCH_FORMAT, "--sort=-committerdate", "refs/heads", "refs/remotes"])?;
        let (local, remote) = parse_branches(&out, &remotes);
        let tags = parse_tags(&self.git_run(&["for-each-ref", TAG_FORMAT, "--sort=-creatordate", "refs/tags"])?);
        // stash 가 없으면 빈 출력(오류 아님).
        let stashes = parse_stashes(&self.git_run(&["stash", "list", STASH_FORMAT]).unwrap_or_default());
        Ok(Refs { local, remote, tags, stashes, remotes })
    }

    /// git 이 받는 브랜치 이름인가. 아니면 그 이유.
    pub fn check_branch_name(&self, name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(GitError::new(tr("이름을 적어 주세요.", "Enter a name.")));
        }
        self.git_run(&["check-ref-format", "--branch", name]).map(|_| ()).map_err(|_| GitError::new(crate::trf!("브랜치 이름으로 쓸 수 없습니다: {name}", "Can't be used as a branch name: {name}")))
    }

    /// 체크아웃이 작업 중 변경 때문에 막혔으면 무엇을 하면 되는지 앞에 붙인다.
    fn explain_checkout(e: GitError) -> GitError {
        if e.message.contains("would be overwritten by checkout") || e.message.contains("would be overwritten by switch") {
            GitError::new(crate::trf!("작업 중인 변경이 체크아웃할 쪽과 겹쳐 바꿀 수 없습니다. 먼저 커밋하거나 Stash 해 주세요.\n\n{}", "Your changes overlap with the branch you're checking out, so it can't switch. Commit or Stash them first.\n\n{}", e.message))
        } else {
            e
        }
    }

    /// 로컬 브랜치로 바꾼다. 원격 브랜치를 고르면 같은 이름의 로컬 브랜치를 만들어 추적한다(이미 있으면 그리로).
    pub fn checkout(&self, name: &str, remote: bool) -> Result<()> {
        if remote {
            let refs = self.refs()?;
            let branch = refs.remote.iter().find(|b| b.name == name).ok_or_else(|| GitError::new(crate::trf!("원격 브랜치가 없습니다: {name}", "No such remote branch: {name}")))?;
            let prefix = format!("{}/", branch.remote.clone().unwrap_or_default());
            let local = name.strip_prefix(&prefix).unwrap_or(name);
            if refs.local.iter().any(|b| b.name == local) {
                return self.git_run(&["switch", local]).map(|_| ()).map_err(Self::explain_checkout);
            }
            return self.git_run(&["switch", "-c", local, "--track", name]).map(|_| ()).map_err(Self::explain_checkout);
        }
        self.git_run(&["switch", name]).map(|_| ()).map_err(Self::explain_checkout)
    }

    /// 커밋을 브랜치 없이 본다(detached HEAD).
    pub fn checkout_detached(&self, hash: &str) -> Result<()> {
        self.git_run(&["switch", "--detach", hash]).map(|_| ()).map_err(Self::explain_checkout)
    }

    pub fn create_branch(&self, name: &str, start: &str, checkout: bool) -> Result<()> {
        self.check_branch_name(name)?;
        if checkout {
            self.git_run(&["switch", "-c", name, start]).map(|_| ())
        } else {
            self.git_run(&["branch", "--", name, start]).map(|_| ())
        }
    }

    pub fn rename_branch(&self, old: &str, new: &str) -> Result<()> {
        self.check_branch_name(new)?;
        self.git_run(&["branch", "-m", old, new]).map(|_| ())
    }

    /// 병합되지 않은 브랜치는 `force` 가 아니면 git 이 거절한다.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<()> {
        self.git_run(&["branch", if force { "-D" } else { "-d" }, "--", name]).map(|_| ()).map_err(|e| {
            if e.message.contains("not fully merged") {
                GitError::new(crate::trf!("'{name}' 에는 아직 병합하지 않은 커밋이 있습니다. 그래도 지우려면 '강제로 지우기' 를 골라 주세요.", "'{name}' has unmerged commits. To delete it anyway, choose 'Force Delete'."))
            } else {
                e
            }
        })
    }

    pub fn delete_remote_branch(&self, remote: &str, branch: &str) -> Result<()> {
        self.git_run(&["push", remote, "--delete", branch]).map(|_| ())
    }

    /// 작업이 충돌로 멈췄으면 git 원문 대신 무엇을 하면 되는지 알린다.
    fn explain_conflict(&self, what: &str, result: Result<String>) -> Result<String> {
        result.map_err(|e| match self.status() {
            Ok(st) if st.operation.is_some() && st.conflicted > 0 => GitError::new(crate::trf!(
                "{what} 중 충돌이 났습니다. 충돌 파일 {}개를 변경 목록에서 눌러 풀고 '이어가기' 를 눌러 주세요. 그만두려면 '중단' 을 누르면 됩니다.",
                "{what} stopped with conflicts. Click the {} conflicted files in the changes list to resolve them, then click 'Continue'. To give up, click 'Abort'.",
                st.conflicted
            )),
            _ => e,
        })
    }

    pub fn merge(&self, revision: &str) -> Result<String> {
        self.explain_conflict(tr("병합", "Merge"), self.git_run(&["merge", "--no-edit", revision]))
    }

    pub fn rebase(&self, revision: &str) -> Result<String> {
        self.rebase_with(revision, true)
    }

    /// `stop_on_conflict` 가 아니면 충돌이 났을 때 시작 전으로 되돌린다(autostash 한 변경도 돌아온다).
    pub fn rebase_with(&self, revision: &str, stop_on_conflict: bool) -> Result<String> {
        let out = self.git_run(&["rebase", "--autostash", revision]);
        if out.is_err() && !stop_on_conflict && self.git_dir().join("rebase-merge").exists() {
            let _ = self.git_run(&["rebase", "--abort"]);
            return Err(GitError::new(crate::trf!(
                "Rebase 하다 충돌이 나서 시작하기 전으로 되돌렸습니다. 충돌을 직접 풀려면 설정 > 그래프 의 'Rebase 충돌 때 멈추기' 를 켜세요.\n\n{}",
                "The Rebase hit a conflict, so it was rolled back to where it started. To resolve conflicts yourself, turn on 'Stop on Rebase Conflicts' in Settings > Graph.\n\n{}",
                out.err().map(|e| e.message).unwrap_or_default()
            )));
        }
        self.explain_conflict("Rebase", out)
    }

    pub fn cherry_pick(&self, hash: &str, is_merge: bool) -> Result<String> {
        let out = if is_merge { self.git_run(&["cherry-pick", "-m", "1", hash]) } else { self.git_run(&["cherry-pick", hash]) };
        self.explain_conflict("Cherry-pick", out)
    }

    pub fn revert(&self, hash: &str, is_merge: bool) -> Result<String> {
        let out = if is_merge { self.git_run(&["revert", "--no-edit", "-m", "1", hash]) } else { self.git_run(&["revert", "--no-edit", hash]) };
        self.explain_conflict("Revert", out)
    }

    pub fn reset(&self, hash: &str, mode: ResetMode) -> Result<()> {
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        self.git_run(&["reset", flag, hash]).map(|_| ())
    }

    pub fn create_tag(&self, name: &str, hash: &str, message: &str) -> Result<()> {
        if self.git_run(&["check-ref-format", &format!("refs/tags/{name}")]).is_err() || name.trim().is_empty() {
            return Err(GitError::new(crate::trf!("태그 이름으로 쓸 수 없습니다: {name}", "Can't be used as a tag name: {name}")));
        }
        if message.trim().is_empty() {
            self.git_run(&["tag", "--", name, hash]).map(|_| ())
        } else {
            self.git_run(&["tag", "-a", "-m", message, "--", name, hash]).map(|_| ())
        }
    }

    pub fn delete_tag(&self, name: &str) -> Result<()> {
        self.git_run(&["tag", "-d", name]).map(|_| ())
    }

    pub fn push_tag(&self, remote: &str, name: &str) -> Result<()> {
        self.git_run(&["push", remote, &format!("refs/tags/{name}")]).map(|_| ())
    }

    /// 작업 중 변경을 stash 에 넣는다. 새 파일도 함께(`-u`).
    pub fn stash_push(&self, message: &str) -> Result<()> {
        let mut args = vec!["stash", "push", "--include-untracked"];
        if !message.trim().is_empty() {
            args.extend(["-m", message]);
        }
        let out = self.git_run_with_env(&args, &[("GIT_LITERAL_PATHSPECS", "0")])?;
        if out.contains("No local changes to save") {
            return Err(GitError::new(tr("stash 할 변경이 없습니다.", "There are no changes to stash.")));
        }
        Ok(())
    }

    pub fn stash_apply(&self, name: &str, pop: bool) -> Result<String> {
        self.git_run(&["stash", if pop { "pop" } else { "apply" }, name])
    }

    pub fn stash_drop(&self, name: &str) -> Result<()> {
        self.git_run(&["stash", "drop", name]).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branches_with_tracking() {
        let out = "refs/heads/main\x1fa1\x1f100\x1f*\x1forigin/main\x1f[ahead 1, behind 2]\n\
                   refs/heads/old\x1fb2\x1f90\x1f \x1forigin/old\x1f[gone]\n\
                   refs/heads/local\x1fc3\x1f80\x1f \x1f\x1f\n\
                   refs/remotes/origin/HEAD\x1fa1\x1f100\x1f \x1f\x1f\n\
                   refs/remotes/origin/main\x1fa1\x1f100\x1f \x1f\x1f\n\
                   refs/remotes/my/fork/x\x1fd4\x1f70\x1f \x1f\x1f\n";
        let (local, remote) = parse_branches(out, &["origin".into(), "my/fork".into()]);
        assert_eq!(local.len(), 3);
        assert!(local[0].current);
        assert_eq!((local[0].ahead, local[0].behind), (1, 2));
        assert!(local[1].gone);
        assert_eq!(local[2].upstream, None);
        assert_eq!(remote.len(), 2);
        assert_eq!(remote[0].remote.as_deref(), Some("origin"));
        assert_eq!(remote[1].remote.as_deref(), Some("my/fork"));
    }

    #[test]
    fn parses_tags_and_stashes() {
        let tags = parse_tags("v1\x1ftagobj\x1fcommit1\x1f릴리스\nv2\x1fcommit2\x1f\x1fsubject\n");
        assert_eq!(tags[0].hash, "commit1");
        assert!(tags[0].annotated);
        assert_eq!(tags[1].hash, "commit2");
        assert!(!tags[1].annotated);
        let st = parse_stashes("stash@{0}\x1fh0\x1f5\x1fOn main: 메시지\x1f포함\nstash@{1}\x1fh1\x1f4\x1fWIP on main: abc x\n");
        assert_eq!(st.len(), 2);
        assert_eq!(st[0].message, "On main: 메시지\x1f포함");
    }
}
