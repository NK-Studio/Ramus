//! 실행 취소·다시 실행. 원본 `Core/GitUndo.cs` 를 옮겼다.
//!
//! 작업마다 전후 상태(HEAD·브랜치·stash 꼭대기)를 기록해 두고, 되돌릴 때는 먼저 레포지토리가 기록한 뒤 그대로인지 확인한다(다른 커밋·전환이
//! 끼었으면 안전하지 않으니 하지 않고 그 기록을 뺀다). 기록은 앱을 끌 때까지만, 레포지토리마다 30개까지 둔다.

use serde::{Deserialize, Serialize};

use crate::i18n::tr;
use crate::repo::{GitError, Repository, Result};

pub const MAX_ENTRIES: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UndoKind {
    Commit,
    Switch,
    CreateBranch,
    DeleteBranch,
    Stash,
    Pull,
    /// merge·rebase·cherry-pick·revert·reset: HEAD 가 옮겨 간 것.
    MoveHead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoEntry {
    pub kind: UndoKind,
    /// 화면에 보일 작업 이름("커밋 '제목'").
    pub title: String,
    pub head_before: String,
    pub head_after: String,
    pub branch_before: String,
    pub branch_after: String,
    pub name: String,
    pub hash: String,
    pub switched: bool,
    pub paths: Vec<String>,
    /// MoveHead 를 되돌릴 reset 방식. 비면 --keep.
    pub reset_mode: String,
}

impl UndoEntry {
    pub fn new(kind: UndoKind, title: impl Into<String>) -> Self {
        UndoEntry {
            kind,
            title: title.into(),
            head_before: String::new(),
            head_after: String::new(),
            branch_before: String::new(),
            branch_after: String::new(),
            name: String::new(),
            hash: String::new(),
            switched: false,
            paths: Vec::new(),
            reset_mode: String::new(),
        }
    }
}

/// 되돌리기 전에 확인할 것.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Check {
    HeadIs(String),
    CurrentBranchIs(String),
    BranchTipIs(String, String),
    BranchMissing(String),
    StashTopIs(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub checks: Vec<Check>,
    pub commands: Vec<Vec<String>>,
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

fn switch_back(e: &UndoEntry) -> Vec<String> {
    if e.branch_before.is_empty() { args(&["switch", "--detach", &e.head_before]) } else { args(&["switch", &e.branch_before]) }
}

fn reset_mode(e: &UndoEntry) -> &str {
    if e.reset_mode.is_empty() { "--keep" } else { &e.reset_mode }
}

pub fn undo_plan(e: &UndoEntry) -> Plan {
    let mut p = Plan::default();
    match e.kind {
        UndoKind::Commit => {
            p.checks.push(Check::HeadIs(e.head_after.clone()));
            p.commands.push(args(&["reset", "--soft", &e.head_before]));
        }
        UndoKind::Switch => {
            p.checks.push(Check::CurrentBranchIs(e.branch_after.clone()));
            p.commands.push(switch_back(e));
        }
        UndoKind::CreateBranch => {
            if e.switched {
                p.checks.push(Check::CurrentBranchIs(e.name.clone()));
                p.checks.push(Check::HeadIs(e.hash.clone()));
                p.commands.push(switch_back(e));
            } else {
                p.checks.push(Check::BranchTipIs(e.name.clone(), e.hash.clone()));
            }
            p.commands.push(args(&["branch", "-D", &e.name]));
        }
        UndoKind::DeleteBranch => {
            p.checks.push(Check::BranchMissing(e.name.clone()));
            p.commands.push(args(&["branch", &e.name, &e.hash]));
        }
        UndoKind::Stash => {
            p.checks.push(Check::StashTopIs(e.hash.clone()));
            p.commands.push(args(&["stash", "pop"]));
        }
        UndoKind::Pull => {
            p.checks.push(Check::HeadIs(e.head_after.clone()));
            p.commands.push(args(&["reset", "--keep", &e.head_before]));
        }
        UndoKind::MoveHead => {
            p.checks.push(Check::HeadIs(e.head_after.clone()));
            p.commands.push(args(&["reset", reset_mode(e), &e.head_before]));
        }
    }
    p
}

pub fn redo_plan(e: &UndoEntry) -> Plan {
    let mut p = Plan::default();
    match e.kind {
        UndoKind::Commit => {
            p.checks.push(Check::HeadIs(e.head_before.clone()));
            p.commands.push(args(&["reset", "--soft", &e.head_after]));
        }
        UndoKind::Switch => {
            p.checks.push(Check::HeadIs(e.head_before.clone()));
            p.commands.push(if e.branch_after.is_empty() { args(&["switch", "--detach", &e.head_after]) } else { args(&["switch", &e.branch_after]) });
        }
        UndoKind::CreateBranch => {
            p.checks.push(Check::BranchMissing(e.name.clone()));
            if e.switched {
                p.checks.push(Check::HeadIs(e.head_before.clone()));
                p.commands.push(args(&["switch", "-c", &e.name, &e.hash]));
            } else {
                p.commands.push(args(&["branch", &e.name, &e.hash]));
            }
        }
        UndoKind::DeleteBranch => {
            p.checks.push(Check::BranchTipIs(e.name.clone(), e.hash.clone()));
            p.commands.push(args(&["branch", "-D", &e.name]));
        }
        UndoKind::Stash => {
            // 일부만 넣었던 기록은 같은 경로만 다시 넣는다.
            let mut c = args(&["stash", "push", "--include-untracked"]);
            if !e.paths.is_empty() {
                c.push("--".into());
                c.extend(e.paths.iter().cloned());
            }
            p.commands.push(c);
        }
        UndoKind::Pull => {
            p.checks.push(Check::HeadIs(e.head_before.clone()));
            p.commands.push(args(&["merge", "--ff-only", &e.head_after]));
        }
        UndoKind::MoveHead => {
            p.checks.push(Check::HeadIs(e.head_before.clone()));
            p.commands.push(args(&["reset", reset_mode(e), &e.head_after]));
        }
    }
    p
}

/// 실행 취소·다시 실행 목록.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub undo: Vec<UndoEntry>,
    pub redo: Vec<UndoEntry>,
}

impl Journal {
    pub fn record(&mut self, entry: UndoEntry) {
        self.undo.push(entry);
        if self.undo.len() > MAX_ENTRIES {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// 화면에 보일 다음 실행 취소·다시 실행 이름.
    pub fn titles(&self) -> (Option<&str>, Option<&str>) {
        (self.undo.last().map(|e| e.title.as_str()), self.redo.last().map(|e| e.title.as_str()))
    }
}

/// 작업 앞뒤로 재는 레포지토리 상태.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub head: String,
    pub branch: String,
    pub stash: String,
}

impl Repository {
    fn rev(&self, revision: &str) -> String {
        self.git_run(&["rev-parse", "--verify", "--quiet", revision]).map(|s| s.trim().to_string()).unwrap_or_default()
    }

    pub fn undo_snapshot(&self) -> Snapshot {
        Snapshot {
            head: self.rev("HEAD"),
            branch: self.git_run(&["symbolic-ref", "--short", "--quiet", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default(),
            stash: self.rev("refs/stash"),
        }
    }

    pub fn branch_tip(&self, name: &str) -> String {
        self.rev(&format!("refs/heads/{name}"))
    }

    fn satisfied(&self, check: &Check) -> bool {
        match check {
            Check::HeadIs(h) => self.rev("HEAD") == *h,
            Check::CurrentBranchIs(b) => self.undo_snapshot().branch == *b,
            Check::BranchTipIs(n, h) => self.branch_tip(n) == *h,
            Check::BranchMissing(n) => self.branch_tip(n).is_empty(),
            Check::StashTopIs(h) => self.rev("refs/stash") == *h,
        }
    }

    /// 계획을 실행한다. 확인이 맞지 않으면 Ok(false)(기록이 낡았다 — 부른 쪽이 뺀다).
    pub fn run_plan(&self, plan: &Plan) -> Result<bool> {
        if !plan.checks.iter().all(|c| self.satisfied(c)) {
            return Ok(false);
        }
        for command in &plan.commands {
            self.git_run(command)?;
        }
        Ok(true)
    }
}

/// 되돌리기·다시 하기. 성공하면 그 작업 이름. 기록이 낡았으면 목록에서 빼고 알린다.
pub fn undo(repo: &Repository, journal: &mut Journal) -> Result<String> {
    let entry = journal.undo.last().cloned().ok_or_else(|| GitError::new(tr("기록된 작업이 없습니다.", "There are no recorded actions.")))?;
    if !repo.run_plan(&undo_plan(&entry))? {
        journal.undo.pop();
        return Err(GitError::new(tr("기록한 뒤 레포지토리가 바뀌어(다른 커밋·전환 등) 안전하게 되돌릴 수 없습니다. 이 기록은 목록에서 뺐습니다.", "The repository changed after this was recorded (another commit, a switch, etc.), so it can't be safely reverted. The entry was removed from the list.")));
    }
    journal.redo.push(journal.undo.pop().unwrap());
    Ok(entry.title)
}

pub fn redo(repo: &Repository, journal: &mut Journal) -> Result<String> {
    let entry = journal.redo.last().cloned().ok_or_else(|| GitError::new(tr("기록된 작업이 없습니다.", "There are no recorded actions.")))?;
    if !repo.run_plan(&redo_plan(&entry))? {
        journal.redo.pop();
        return Err(GitError::new(tr("기록한 뒤 레포지토리가 바뀌어(다른 커밋·전환 등) 안전하게 되돌릴 수 없습니다. 이 기록은 목록에서 뺐습니다.", "The repository changed after this was recorded (another commit, a switch, etc.), so it can't be safely reverted. The entry was removed from the list.")));
    }
    let mut entry = journal.redo.pop().unwrap();
    // 다시 넣은 stash 는 새 커밋이다.
    if entry.kind == UndoKind::Stash {
        entry.hash = repo.undo_snapshot().stash;
    }
    let title = entry.title.clone();
    journal.undo.push(entry);
    Ok(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 원본 Tests/Editor/GitUndoTests.cs 의 계획 규칙.

    #[test]
    fn commit_undo_resets_soft() {
        let mut e = UndoEntry::new(UndoKind::Commit, "c");
        e.head_before = "a".into();
        e.head_after = "b".into();
        let p = undo_plan(&e);
        assert_eq!(p.checks, vec![Check::HeadIs("b".into())]);
        assert_eq!(p.commands, vec![args(&["reset", "--soft", "a"])]);
        assert_eq!(redo_plan(&e).commands, vec![args(&["reset", "--soft", "b"])]);
    }

    #[test]
    fn switch_back_to_detached_when_no_branch() {
        let mut e = UndoEntry::new(UndoKind::Switch, "s");
        e.head_before = "h".into();
        e.branch_after = "main".into();
        assert_eq!(undo_plan(&e).commands, vec![args(&["switch", "--detach", "h"])]);
        e.branch_before = "dev".into();
        assert_eq!(undo_plan(&e).commands, vec![args(&["switch", "dev"])]);
        e.branch_after = String::new();
        e.head_after = "x".into();
        assert_eq!(redo_plan(&e).commands, vec![args(&["switch", "--detach", "x"])]);
    }

    #[test]
    fn create_branch_with_switch_goes_back_then_deletes() {
        let mut e = UndoEntry::new(UndoKind::CreateBranch, "b");
        e.name = "f".into();
        e.hash = "h".into();
        e.branch_before = "main".into();
        e.switched = true;
        let p = undo_plan(&e);
        assert_eq!(p.commands, vec![args(&["switch", "main"]), args(&["branch", "-D", "f"])]);
        e.switched = false;
        assert_eq!(undo_plan(&e).checks, vec![Check::BranchTipIs("f".into(), "h".into())]);
    }

    #[test]
    fn partial_stash_redo_keeps_paths_and_move_head_uses_mode() {
        let mut e = UndoEntry::new(UndoKind::Stash, "s");
        e.paths = vec!["a.txt".into()];
        assert_eq!(redo_plan(&e).commands, vec![args(&["stash", "push", "--include-untracked", "--", "a.txt"])]);
        let mut m = UndoEntry::new(UndoKind::MoveHead, "m");
        m.head_before = "a".into();
        assert_eq!(undo_plan(&m).commands, vec![args(&["reset", "--keep", "a"])]);
        m.reset_mode = "--hard".into();
        assert_eq!(undo_plan(&m).commands, vec![args(&["reset", "--hard", "a"])]);
    }

    #[test]
    fn journal_caps_and_clears_redo() {
        let mut j = Journal::default();
        for i in 0..35 {
            j.record(UndoEntry::new(UndoKind::Commit, format!("{i}")));
        }
        assert_eq!(j.undo.len(), MAX_ENTRIES);
        assert_eq!(j.undo[0].title, "5");
        j.redo.push(UndoEntry::new(UndoKind::Commit, "r"));
        j.record(UndoEntry::new(UndoKind::Commit, "n"));
        assert!(j.redo.is_empty());
    }
}
