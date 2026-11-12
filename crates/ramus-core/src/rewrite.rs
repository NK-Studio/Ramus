//! Interactive Rebase 의 한 커밋 고치기: Reword · Squash · Fixup · Drop. 원본 `Core/GitRewrite.cs` 를 옮겼다.
//!
//! Reword·Squash·Fixup 은 작업 트리를 건드리지 않는다: 고칠 커밋을 `commit-tree` 로 새로 만들고 그 뒤 커밋들을 부모만 바꿔 차례로 다시 만든 뒤
//! `reset --soft` 로 브랜치를 옮긴다(새 HEAD 의 tree 는 원래와 같다). Drop 은 내용이 바뀌므로 rebase 로 한다.

use serde::Deserialize;

use crate::i18n::tr;
use crate::repo::{GitError, Repository, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RewriteKind {
    Reword,
    Squash,
    Fixup,
    Drop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewriteCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub tree: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub message: String,
}

const FORMAT: &str = "--format=%H%x1f%P%x1f%T%x1f%an%x1f%ae%x1f%ad%x1f%B%x1e";

pub fn parse(output: &str) -> Vec<RewriteCommit> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches(['\r', '\n']);
            let f: Vec<&str> = record.splitn(7, '\x1f').collect();
            (f.len() == 7).then(|| RewriteCommit {
                hash: f[0].into(),
                parents: f[1].split_whitespace().map(str::to_string).collect(),
                tree: f[2].into(),
                author_name: f[3].into(),
                author_email: f[4].into(),
                author_date: f[5].into(),
                message: f[6].into(),
            })
        })
        .collect()
}

/// 이 커밋에 그 고치기를 할 수 없는 이유(되면 None).
pub fn unsupported(kind: RewriteKind, parents: usize) -> Option<&'static str> {
    match kind {
        RewriteKind::Reword => None,
        _ if parents == 0 => Some(tr("최초 커밋은 합치거나 뺄 수 없습니다.", "The root commit can't be squashed or dropped.")),
        _ if parents > 1 => Some(tr("병합 커밋은 합치거나 뺄 수 없습니다.", "A merge commit can't be squashed or dropped.")),
        _ => None,
    }
}

/// Squash 는 두 메시지를 잇고, Fixup 은 부모 메시지만 남긴다.
pub fn combined_message(kind: RewriteKind, parent: &str, commit: &str) -> String {
    if kind == RewriteKind::Squash { format!("{}\n\n{}\n", parent.trim_end(), commit.trim_end()) } else { format!("{}\n", parent.trim_end()) }
}

fn ensure_newline(text: &str) -> String {
    format!("{}\n", text.trim_end())
}

impl Repository {
    fn read_rewrite_commit(&self, revision: &str) -> Result<RewriteCommit> {
        parse(&self.git_run(&["log", "-1", "--date=raw", FORMAT, revision])?).into_iter().next().ok_or_else(|| GitError::new(tr("커밋을 읽지 못했습니다.", "Couldn't read the commit.")))
    }

    fn commit_tree(&self, tree: &str, parents: &[String], message: &str, author: &RewriteCommit) -> Result<String> {
        let mut args = vec!["commit-tree".to_string(), tree.to_string()];
        for p in parents {
            args.push("-p".into());
            args.push(p.clone());
        }
        args.extend(["-F".into(), "-".into()]);
        let env = [("GIT_AUTHOR_NAME", author.author_name.as_str()), ("GIT_AUTHOR_EMAIL", author.author_email.as_str()), ("GIT_AUTHOR_DATE", author.author_date.as_str())];
        Ok(self.git_run_full(&args, Some(message), &env)?.trim().to_string())
    }

    /// 커밋 하나를 고친다. `new_message` 는 Reword(필수)·Squash(없으면 두 메시지를 잇는다)에 쓴다. 바뀐 뒤 HEAD 를 돌려준다.
    pub fn rewrite(&self, kind: RewriteKind, commit: &str, new_message: Option<&str>) -> Result<String> {
        let head = self.head().ok_or_else(|| GitError::new(tr("아직 커밋이 없습니다.", "There are no commits yet.")))?;
        if self.git_run(&["merge-base", "--is-ancestor", commit, "HEAD"]).is_err() {
            return Err(GitError::new(tr("지금 브랜치의 히스토리에 있는 커밋만 고칠 수 있습니다.", "Only commits in the current branch's history can be edited.")));
        }
        let target = self.read_rewrite_commit(commit)?;
        if let Some(why) = unsupported(kind, target.parents.len()) {
            return Err(GitError::new(why));
        }
        if kind == RewriteKind::Drop {
            if self.git_dir().join("rebase-merge").exists() || self.git_dir().join("rebase-apply").exists() {
                return Err(GitError::new(tr("이미 진행 중인 rebase 가 있습니다. 먼저 끝내거나 중단해 주세요.", "A rebase is already in progress. Finish or abort it first.")));
            }
            let result = if target.hash == head {
                self.git_run(&["reset", "--keep", &target.parents[0]])
            } else {
                self.git_run_full(&["rebase", "--rebase-merges", "--autostash", "--onto", &format!("{}^", target.hash), &target.hash], None, &[("GIT_SEQUENCE_EDITOR", "true")])
            };
            if let Err(e) = result {
                if self.git_dir().join("rebase-merge").exists() {
                    let _ = self.git_run(&["rebase", "--abort"]);
                    return Err(GitError::new(crate::trf!("커밋을 빼다 충돌이 나서 시작하기 전으로 되돌렸습니다.\n\n{}", "Dropping the commit caused a conflict, so it was rolled back to where it started.\n\n{}", e.message)));
                }
                return Err(e);
            }
            return Ok(self.head().unwrap_or_default());
        }

        let mut replaced: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let rewritten = if kind == RewriteKind::Reword {
            let message = new_message.filter(|m| !m.trim().is_empty()).ok_or_else(|| GitError::new(tr("커밋 메시지를 적어 주세요.", "Enter a commit message.")))?;
            self.commit_tree(&target.tree, &target.parents, &ensure_newline(message), &target)?
        } else {
            let parent = self.read_rewrite_commit(&target.parents[0])?;
            if parent.parents.len() > 1 {
                return Err(GitError::new(tr("부모가 병합 커밋이라 합칠 수 없습니다.", "Can't squash because the parent is a merge commit.")));
            }
            let message = match new_message.filter(|m| !m.trim().is_empty()) {
                Some(m) => ensure_newline(m),
                None => combined_message(kind, &parent.message, &target.message),
            };
            // 합친 커밋은 부모 커밋의 작성자·날짜를 이어받는다.
            self.commit_tree(&target.tree, &parent.parents, &message, &parent)?
        };
        replaced.insert(target.hash.clone(), rewritten);
        if target.hash != head {
            let log = self.git_run(&["log", "--ancestry-path", "--topo-order", "--reverse", "--date=raw", FORMAT, &format!("{}..HEAD", target.hash)])?;
            for d in parse(&log) {
                let mut changed = false;
                let parents: Vec<String> = d
                    .parents
                    .iter()
                    .map(|p| match replaced.get(p) {
                        Some(r) => {
                            changed = true;
                            r.clone()
                        }
                        None => p.clone(),
                    })
                    .collect();
                if !changed {
                    continue;
                }
                let copy = self.commit_tree(&d.tree, &parents, &d.message, &d)?;
                replaced.insert(d.hash.clone(), copy);
            }
        }
        let new_head = replaced.get(&head).cloned().ok_or_else(|| GitError::new(tr("커밋을 다시 만들지 못했습니다.", "Couldn't recreate the commit.")))?;
        self.git_run(&["reset", "--soft", &new_head])?;
        Ok(new_head)
    }

    /// 커밋 하나를 패치 파일로 쓴다(format-patch).
    pub fn save_patch(&self, commit: &str, path: &str) -> Result<()> {
        let patch = self.git_run(&["format-patch", "-1", "--stdout", commit])?;
        std::fs::write(path, patch).map_err(|e| GitError::new(crate::trf!("패치를 쓰지 못했습니다: {e}", "Couldn't write the patch: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_and_rules() {
        assert_eq!(combined_message(RewriteKind::Squash, "a\n", "b\n\n"), "a\n\nb\n");
        assert_eq!(combined_message(RewriteKind::Fixup, "a  ", "b"), "a\n");
        assert!(unsupported(RewriteKind::Reword, 0).is_none());
        assert!(unsupported(RewriteKind::Squash, 0).is_some());
        assert!(unsupported(RewriteKind::Drop, 2).is_some());
        let c = parse("h\x1fp1 p2\x1ft\x1fA\x1fa@x\x1f1 +0900\x1fmsg\nbody\x1e\n");
        assert_eq!(c[0].parents, ["p1", "p2"]);
        assert_eq!(c[0].message, "msg\nbody");
    }
}
