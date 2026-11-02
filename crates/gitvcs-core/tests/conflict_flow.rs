//! 실제 git 으로 병합 충돌 → 읽기 → 고른 글로 해결 → 이어가기, 한쪽 고르기, rebase 충돌 취소·건너뛰기.

use std::path::Path;

use gitvcs_core::conflict::{Operation, Segment, Side};
use gitvcs_core::{GitRunner, Repository};

fn git(dir: &Path, args: &[&str]) -> (bool, String) {
    let out = GitRunner::default().run(dir, args);
    (out.success(), out.message())
}

fn ok(dir: &Path, args: &[&str]) {
    let (success, msg) = git(dir, args);
    assert!(success, "git {args:?}: {msg}");
}

/// main 과 side 가 같은 줄을 다르게 고친 저장소. main 에 체크아웃된 채로.
fn conflicted_repo() -> (tempfile::TempDir, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    ok(d, &["init", "-q", "-b", "main"]);
    ok(d, &["config", "user.name", "테스터"]);
    ok(d, &["config", "user.email", "t@example.com"]);
    ok(d, &["config", "commit.gpgsign", "false"]);
    std::fs::write(d.join("f.txt"), "a\n공통\nz\n").unwrap();
    std::fs::write(d.join("other.txt"), "o\n").unwrap();
    ok(d, &["add", "-A"]);
    ok(d, &["commit", "-qm", "base"]);
    ok(d, &["switch", "-qc", "side"]);
    std::fs::write(d.join("f.txt"), "a\n옆 가지\nz\n").unwrap();
    std::fs::write(d.join("other.txt"), "side\n").unwrap();
    ok(d, &["commit", "-qam", "side"]);
    ok(d, &["switch", "-q", "main"]);
    std::fs::write(d.join("f.txt"), "a\n메인\nz\n").unwrap();
    std::fs::write(d.join("other.txt"), "main\n").unwrap();
    ok(d, &["commit", "-qam", "main"]);
    let repo = Repository::open(GitRunner::default(), d).unwrap();
    (dir, repo)
}

#[test]
fn merge_conflict_resolve_and_continue() {
    let (dir, repo) = conflicted_repo();
    let d = dir.path();
    assert!(repo.merge("side").is_err());
    let st = repo.status().unwrap();
    assert_eq!(st.operation, Some(Operation::Merge));
    assert_eq!(st.conflicted, 2);

    let doc = repo.conflict("f.txt").unwrap();
    let file = doc.file.unwrap();
    assert_eq!(file.a_label, "HEAD");
    assert_eq!(file.b_label, "side");
    let conflict = file.segments.iter().find(|s| matches!(s, Segment::Conflict { .. })).unwrap();
    assert_eq!(*conflict, Segment::Conflict { a: vec!["메인".into()], base: vec![], b: vec!["옆 가지".into()] });

    // 이어가기는 충돌이 남으면 막힌다.
    assert!(repo.continue_blocker().unwrap().unwrap().contains("2개"));
    // 표시가 남은 글은 저장하지 않는다.
    assert!(repo.save_resolution("f.txt", "<<<<<<< A\nx\n=======\ny\n>>>>>>> B\n").is_err());
    repo.save_resolution("f.txt", "a\n메인\n옆 가지\nz\n").unwrap();
    // 다른 파일은 들어오는 쪽으로.
    repo.resolve("other.txt", Side::Theirs).unwrap();
    assert_eq!(std::fs::read_to_string(d.join("other.txt")).unwrap(), "side\n");
    assert_eq!(repo.continue_blocker().unwrap(), None);
    repo.continue_operation().unwrap();
    let st = repo.status().unwrap();
    assert_eq!(st.operation, None);
    assert!(st.staged.is_empty() && st.unstaged.is_empty());
    assert_eq!(std::fs::read_to_string(d.join("f.txt")).unwrap(), "a\n메인\n옆 가지\nz\n");
}

#[test]
fn conflict_text_is_rebuilt_from_stages_when_markers_were_erased() {
    let (dir, repo) = conflicted_repo();
    let _ = repo.merge("side");
    // 손으로 고치다 표시를 지워 버렸다.
    std::fs::write(dir.path().join("f.txt"), "망가짐\n").unwrap();
    let doc = repo.conflict("f.txt").unwrap();
    let file = doc.file.expect("인덱스의 세 판으로 다시 만든다");
    assert!(file.segments.iter().any(|s| matches!(s, Segment::Conflict { a, b, .. } if a == &vec!["메인".to_string()] && b == &vec!["옆 가지".to_string()])));
    // 작업 사본은 건드리지 않는다.
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "망가짐\n");
}

#[test]
fn resolve_ours_and_abort() {
    let (dir, repo) = conflicted_repo();
    let _ = repo.merge("side");
    repo.resolve("f.txt", Side::Ours).unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "a\n메인\nz\n");
    // 표시가 남은 파일을 그대로 해결로 올리면 거절한다.
    assert!(repo.resolve("other.txt", Side::AsIs).is_err());
    repo.abort_operation().unwrap();
    let st = repo.status().unwrap();
    assert_eq!(st.operation, None);
    assert_eq!(st.conflicted, 0);
}

#[test]
fn deleted_on_one_side() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    ok(d, &["init", "-q", "-b", "main"]);
    ok(d, &["config", "user.name", "t"]);
    ok(d, &["config", "user.email", "t@x"]);
    ok(d, &["config", "commit.gpgsign", "false"]);
    std::fs::write(d.join("g.txt"), "1\n").unwrap();
    ok(d, &["add", "-A"]);
    ok(d, &["commit", "-qm", "base"]);
    ok(d, &["switch", "-qc", "side"]);
    ok(d, &["rm", "-q", "g.txt"]);
    ok(d, &["commit", "-qm", "delete"]);
    ok(d, &["switch", "-q", "main"]);
    std::fs::write(d.join("g.txt"), "2\n").unwrap();
    ok(d, &["commit", "-qam", "edit"]);
    let repo = Repository::open(GitRunner::default(), d).unwrap();
    assert!(repo.merge("side").is_err());
    let doc = repo.conflict("g.txt").unwrap();
    assert!(doc.theirs_deleted && !doc.ours_deleted);
    assert!(doc.file.is_none());
    repo.resolve("g.txt", Side::Theirs).unwrap();
    assert!(!d.join("g.txt").exists());
    repo.continue_operation().unwrap();
}

#[test]
fn rebase_conflict_skip() {
    let (dir, repo) = conflicted_repo();
    let d = dir.path();
    assert!(repo.rebase("side").is_err());
    assert_eq!(repo.status().unwrap().operation, Some(Operation::Rebase));
    repo.skip_operation().unwrap();
    assert_eq!(repo.status().unwrap().operation, None);
    // main 의 커밋을 건너뛰었으니 side 와 같다.
    assert_eq!(std::fs::read_to_string(d.join("f.txt")).unwrap(), "a\n옆 가지\nz\n");
}
