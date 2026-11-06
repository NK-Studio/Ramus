//! 실제 git 으로 브랜치·태그·stash·cherry-pick·revert·reset·merge.

use std::path::Path;

use ramus_core::refs::ResetMode;
use ramus_core::{GitRunner, Repository};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = GitRunner::default().run(dir, args);
    assert!(out.success(), "git {args:?}: {}", out.message());
    out.stdout
}

fn setup() -> (tempfile::TempDir, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "테스터"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    std::fs::write(d.join("a.txt"), "1\n").unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-qm", "one"]);
    let repo = Repository::open(GitRunner::default(), d).unwrap();
    (dir, repo)
}

fn commit(d: &Path, file: &str, text: &str, msg: &str) -> String {
    std::fs::write(d.join(file), text).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-qm", msg]);
    git(d, &["rev-parse", "HEAD"]).trim().to_string()
}

#[test]
fn branches_create_checkout_rename_delete() {
    let (dir, repo) = setup();
    let d = dir.path();
    assert!(repo.check_branch_name("feature/좋은-이름").is_ok());
    assert!(repo.check_branch_name("bad name").is_err());
    assert!(repo.check_branch_name("..").is_err());

    repo.create_branch("feature/x", "HEAD", true).unwrap();
    assert_eq!(repo.status().unwrap().branch.name, "feature/x");
    commit(d, "b.txt", "b\n", "on feature");
    repo.checkout("main", false).unwrap();
    let refs = repo.refs().unwrap();
    assert_eq!(refs.local.len(), 2);
    assert!(refs.local.iter().find(|b| b.name == "main").unwrap().current);

    // 병합 안 된 브랜치는 그냥 지우면 안내, 강제면 지운다.
    repo.rename_branch("feature/x", "feature/y").unwrap();
    let err = repo.delete_branch("feature/y", false).err().unwrap();
    assert!(err.message.contains("병합하지 않은"), "{}", err.message);
    repo.delete_branch("feature/y", true).unwrap();
    assert_eq!(repo.refs().unwrap().local.len(), 1);
}

#[test]
fn remote_branch_checkout_creates_tracking_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("r.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    let (dir, repo) = setup();
    let d = dir.path();
    git(d, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(d, &["push", "-q", "origin", "main"]);
    git(d, &["push", "-q", "origin", "main:release"]);
    git(d, &["fetch", "-q"]);
    let refs = repo.refs().unwrap();
    assert!(refs.remote.iter().any(|b| b.name == "origin/release"));
    repo.checkout("origin/release", true).unwrap();
    let st = repo.status().unwrap().branch;
    assert_eq!(st.name, "release");
    assert_eq!(st.upstream.as_deref(), Some("origin/release"));
    // 원격 브랜치 지우기.
    repo.checkout("main", false).unwrap();
    repo.delete_remote_branch("origin", "release").unwrap();
    assert!(!repo.refs().unwrap().remote.iter().any(|b| b.name == "origin/release"));
}

#[test]
fn tags_and_detached_checkout() {
    let (dir, repo) = setup();
    let first = git(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
    commit(dir.path(), "a.txt", "2\n", "two");
    repo.create_tag("v1.0", &first, "").unwrap();
    repo.create_tag("v2.0", "HEAD", "릴리스 2").unwrap();
    assert!(repo.create_tag("bad tag", "HEAD", "").is_err());
    let tags = repo.refs().unwrap().tags;
    assert_eq!(tags.len(), 2);
    let v1 = tags.iter().find(|t| t.name == "v1.0").unwrap();
    assert_eq!(v1.hash, first);
    assert!(!v1.annotated);
    assert!(tags.iter().find(|t| t.name == "v2.0").unwrap().annotated);
    repo.delete_tag("v1.0").unwrap();
    repo.checkout_detached(&first).unwrap();
    assert!(repo.status().unwrap().branch.detached);
}

#[test]
fn stash_push_apply_pop_drop() {
    let (dir, repo) = setup();
    let d = dir.path();
    assert!(repo.stash_push("").err().unwrap().message.contains("stash 할 변경이 없습니다"));
    std::fs::write(d.join("a.txt"), "changed\n").unwrap();
    std::fs::write(d.join("새 [파일].txt"), "new\n").unwrap();
    repo.stash_push("작업 중").unwrap();
    // 새 파일도 함께 치워진다.
    assert!(!d.join("새 [파일].txt").exists());
    assert!(repo.status().unwrap().unstaged.is_empty());
    let stashes = repo.refs().unwrap().stashes;
    assert_eq!(stashes.len(), 1);
    assert!(stashes[0].message.contains("작업 중"));
    repo.stash_apply("stash@{0}", false).unwrap();
    assert!(d.join("새 [파일].txt").exists());
    assert_eq!(repo.refs().unwrap().stashes.len(), 1);
    git(d, &["checkout", "--", "a.txt"]);
    std::fs::remove_file(d.join("새 [파일].txt")).unwrap();
    repo.stash_apply("stash@{0}", true).unwrap();
    assert!(repo.refs().unwrap().stashes.is_empty());
    repo.stash_push("again").unwrap();
    repo.stash_drop("stash@{0}").unwrap();
    assert!(repo.refs().unwrap().stashes.is_empty());
}

#[test]
fn cherry_pick_revert_reset_merge() {
    let (dir, repo) = setup();
    let d = dir.path();
    repo.create_branch("side", "HEAD", true).unwrap();
    let side = commit(d, "s.txt", "s\n", "side commit");
    repo.checkout("main", false).unwrap();
    repo.cherry_pick(&side, false).unwrap();
    assert!(d.join("s.txt").exists());
    let head = git(d, &["rev-parse", "HEAD"]).trim().to_string();
    repo.revert(&head, false).unwrap();
    assert!(!d.join("s.txt").exists());
    // reset --hard 로 cherry-pick 전으로.
    let one = git(d, &["rev-list", "--max-parents=0", "HEAD"]).trim().to_string();
    repo.reset(&one, ResetMode::Hard).unwrap();
    assert_eq!(git(d, &["rev-list", "--count", "HEAD"]).trim(), "1");
    // mixed 는 변경을 작업 트리에 남긴다.
    commit(d, "m.txt", "m\n", "m");
    repo.reset(&one, ResetMode::Mixed).unwrap();
    assert!(d.join("m.txt").exists());
    std::fs::remove_file(d.join("m.txt")).unwrap();
    // 병합.
    commit(d, "a.txt", "main\n", "main change");
    repo.merge("side").unwrap();
    assert!(d.join("s.txt").exists());
    assert_eq!(git(d, &["log", "-1", "--format=%p"]).split_whitespace().count(), 2);
}
