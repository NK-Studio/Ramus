//! 실제 git 으로 실행 취소·다시 실행, 원격·워크트리·서브모듈 관리, 병합 방식, 앞으로 감기.

use std::path::Path;

use gitvcs_core::ops::MergeMode;
use gitvcs_core::undo::{self, Journal, UndoEntry, UndoKind};
use gitvcs_core::{GitRunner, Repository};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = GitRunner::default().run(dir, args);
    assert!(out.success(), "git {args:?}: {}", out.message());
    out.stdout
}

fn init(d: &Path) {
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "테스터"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
}

fn commit(d: &Path, file: &str, msg: &str) -> String {
    std::fs::write(d.join(file), msg).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-qm", msg]);
    git(d, &["rev-parse", "HEAD"]).trim().to_string()
}

#[test]
fn undo_and_redo_commit_and_branch() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    init(d);
    let first = commit(d, "a.txt", "one");
    let repo = Repository::open(GitRunner::default(), d).unwrap();
    let mut journal = Journal::default();

    let before = repo.undo_snapshot();
    let second = commit(d, "a.txt", "two");
    let mut e = UndoEntry::new(UndoKind::Commit, "커밋 'two'");
    e.head_before = before.head.clone();
    e.head_after = second.clone();
    journal.record(e);

    assert_eq!(undo::undo(&repo, &mut journal).unwrap(), "커밋 'two'");
    assert_eq!(repo.undo_snapshot().head, first);
    // soft reset: 바뀐 내용은 Stage 된 채 남는다.
    assert_eq!(repo.status().unwrap().staged.len(), 1);
    undo::redo(&repo, &mut journal).unwrap();
    assert_eq!(repo.undo_snapshot().head, second);

    repo.create_branch("feat", "HEAD", true).unwrap();
    let mut e = UndoEntry::new(UndoKind::CreateBranch, "b");
    e.name = "feat".into();
    e.hash = repo.branch_tip("feat");
    e.branch_before = "main".into();
    e.head_before = second.clone();
    e.switched = true;
    journal.record(e);
    undo::undo(&repo, &mut journal).unwrap();
    assert_eq!(repo.undo_snapshot().branch, "main");
    assert!(repo.branch_tip("feat").is_empty());

    // 기록 뒤 저장소가 바뀌면 되돌리지 않고 기록을 뺀다.
    let mut stale = Journal::default();
    let mut e = UndoEntry::new(UndoKind::Commit, "x");
    e.head_before = first.clone();
    e.head_after = "0000000000000000000000000000000000000000".into();
    stale.record(e);
    assert!(undo::undo(&repo, &mut stale).is_err());
    assert!(stale.undo.is_empty());
}

#[test]
fn remotes_worktrees_and_merge_modes() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("work");
    std::fs::create_dir(&d).unwrap();
    init(&d);
    commit(&d, "a.txt", "one");
    let repo = Repository::open(GitRunner::default(), &d).unwrap();

    let bare = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
    repo.add_remote("origin", bare.to_str().unwrap(), "").unwrap();
    assert_eq!(repo.remote_list().unwrap()[0].fetch_url, bare.to_str().unwrap());
    repo.push_branch("main", "origin", true, false).unwrap();
    assert_eq!(repo.status().unwrap().branch.upstream.as_deref(), Some("origin/main"));
    repo.rename_remote("origin", "up").unwrap();
    assert_eq!(repo.remote_list().unwrap()[0].name, "up");

    // 워크트리: 새 브랜치로 더하고 지운다.
    let wt = tmp.path().join("work-feat");
    repo.add_worktree(wt.to_str().unwrap(), "HEAD", Some("feat")).unwrap();
    let list = repo.worktrees().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].current);
    assert_eq!(list[1].branch.as_deref(), Some("feat"));
    commit(&wt, "b.txt", "feat");
    repo.remove_worktree(wt.to_str().unwrap(), false).unwrap();
    assert_eq!(repo.worktrees().unwrap().len(), 1);

    // No-FF 는 앞으로 감을 수 있어도 병합 커밋을 만든다.
    repo.merge_with("feat", MergeMode::NoFf).unwrap();
    let parents = git(&d, &["rev-list", "--parents", "-n1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 3);

    // 체크아웃하지 않은 브랜치 앞으로 감기.
    git(&d, &["branch", "-f", "old", "HEAD~1"]);
    git(&d, &["branch", "--set-upstream-to", "main", "old"]);
    repo.fast_forward("old", false).unwrap();
    assert_eq!(repo.branch_tip("old"), repo.branch_tip("main"));

    // 서브모듈 더하기·목록.
    let sub_src = tmp.path().join("lib");
    std::fs::create_dir(&sub_src).unwrap();
    init(&sub_src);
    commit(&sub_src, "lib.txt", "lib");
    repo.add_submodule(sub_src.to_str().unwrap(), "vendor/lib", None).unwrap();
    let subs = repo.submodules().unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].path, "vendor/lib");
    assert_eq!(subs[0].state, gitvcs_core::ops::SubmoduleState::Ok);
}

#[test]
fn rewrite_reword_squash_drop() {
    use gitvcs_core::rewrite::RewriteKind;
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    init(d);
    commit(d, "a.txt", "one");
    let two = commit(d, "b.txt", "two");
    commit(d, "c.txt", "three");
    let repo = Repository::open(GitRunner::default(), d).unwrap();
    repo.rewrite(RewriteKind::Reword, &two, Some("둘째 (고침)")).unwrap();
    let log = git(d, &["log", "--format=%s"]);
    assert_eq!(log.lines().collect::<Vec<_>>(), ["three", "둘째 (고침)", "one"]);
    let second = git(d, &["rev-parse", "HEAD~1"]).trim().to_string();
    repo.rewrite(RewriteKind::Fixup, &second, None).unwrap();
    assert_eq!(git(d, &["log", "--format=%s"]).lines().collect::<Vec<_>>(), ["three", "one"]);
    assert!(d.join("b.txt").exists());
    let head = git(d, &["rev-parse", "HEAD"]).trim().to_string();
    repo.rewrite(RewriteKind::Drop, &head, None).unwrap();
    assert_eq!(git(d, &["log", "--format=%s"]).lines().collect::<Vec<_>>(), ["one"]);
    assert!(!d.join("c.txt").exists());
}

#[test]
fn whole_file_partial_stage_ignore_and_path_stash() {
    use gitvcs_core::diff::LineKind;
    use gitvcs_core::files::PatternKind;
    use gitvcs_core::repo::{DiffOptions, DiffTarget, FULL_CONTEXT, LineAction};
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    init(d);
    let body: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    std::fs::write(d.join("a.txt"), &body).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-qm", "base"]);
    std::fs::write(d.join("a.txt"), body.replace("line 2\n", "line 2 changed\n").replace("line 28\n", "line 28 changed\n")).unwrap();
    let repo = Repository::open(GitRunner::default(), d).unwrap();

    // 파일 전체 문맥으로 본 diff 에서 위쪽 바뀐 줄만 Stage 한다.
    let target = DiffTarget::Unstaged { path: "a.txt".into(), untracked: false };
    let full = DiffOptions { context: FULL_CONTEXT, ..DiffOptions::default() };
    let doc = repo.diff_with(&target, full.clone()).unwrap();
    assert_eq!(doc.hunk_count, 1);
    assert_eq!(doc.lines.iter().filter(|l| l.kind == LineKind::Context).count(), 28);
    let picked: Vec<usize> = doc.lines.iter().enumerate().filter(|(_, l)| l.kind != LineKind::Context && l.kind != LineKind::Hunk && (l.text == "line 2" || l.text == "line 2 changed")).map(|(i, _)| i).collect();
    repo.apply_lines_with(LineAction::Stage, "a.txt", false, &doc.fingerprint, &picked, FULL_CONTEXT).unwrap();
    let staged = repo.diff(&DiffTarget::Staged { path: "a.txt".into(), original_path: None }).unwrap();
    assert_eq!((staged.added, staged.removed), (1, 1));
    assert!(staged.lines.iter().any(|l| l.text == "line 2 changed"));

    // Stage 전 확인: 충돌 표시가 남은 파일.
    std::fs::write(d.join("c.txt"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n").unwrap();
    let w = repo.stage_warnings(&["c.txt".into(), "a.txt".into()]);
    assert_eq!(w.conflict_markers, ["c.txt"]);

    // 확장자 무시: .gitignore 에 *.log, 상태에서 빠진다.
    std::fs::write(d.join("x.log"), "x").unwrap();
    assert_eq!(repo.ignore("x.log", PatternKind::Extension).unwrap(), "*.log");
    assert!(repo.status().unwrap().unstaged.iter().all(|e| e.path != "x.log"));

    // 고른 파일만 stash.
    repo.stash_paths(&["c.txt".into()], "c 만").unwrap();
    assert!(!d.join("c.txt").exists());
    assert!(d.join(".gitignore").exists());
}

#[test]
fn file_log_follows_rename_and_blame_and_compare() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    init(d);
    std::fs::write(d.join("old.txt"), "a\nb\nc\nd\ne\n").unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-qm", "추가"]);
    git(d, &["mv", "old.txt", "new.txt"]);
    git(d, &["commit", "-qm", "이름 바꿈"]);
    std::fs::write(d.join("new.txt"), "a\nB\nc\nd\ne\n").unwrap();
    git(d, &["commit", "-qam", "고침"]);
    let repo = Repository::open(GitRunner::default(), d).unwrap();
    let log = repo.file_log("new.txt", 100).unwrap();
    assert_eq!(log.iter().map(|r| r.commit.subject.as_str()).collect::<Vec<_>>(), ["고침", "이름 바꿈", "추가"]);
    assert_eq!(log[1].status, 'R');
    assert_eq!(log[1].original_path.as_deref(), Some("old.txt"));
    assert_eq!(log[2].path, "old.txt");

    std::fs::write(d.join("new.txt"), "a\nB\nc\nd\nE\n").unwrap();
    let blame = repo.blame("new.txt", None).unwrap();
    assert_eq!(blame.len(), 5);
    assert_eq!(blame[1].text, "B");
    assert!(blame[4].hash.chars().all(|c| c == '0'));

    let files = repo.compare_files("HEAD~2", Some("HEAD"), false).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, 'R');
    let text = repo.read_text("new.txt").unwrap();
    assert_eq!(text.eol, "\n");
    let stamp = repo.write_text("new.txt", "x\n", &text, false).unwrap();
    assert!(stamp > 0);
    assert!(repo.write_text("new.txt", "y\n", &text, false).is_err() || stamp == text.modified);
}
