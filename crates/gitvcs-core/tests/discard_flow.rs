//! 실제 git 으로 "변경 버리기" 두 가지를 본다.
//! Unstaged 목록의 버리기(discard_worktree)는 작업 트리 쪽만 되돌리고 Stage 한 내용은 남긴다(원본 DiscardWorkTreeAsync).
//! Staged 쪽·전체 버리기(discard)는 Stage 한 것까지 HEAD 상태로 되돌린다.

use std::path::Path;

use gitvcs_core::{GitRunner, Repository};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = GitRunner::default().run(dir, args);
    assert!(out.success(), "git {args:?}: {}", out.message());
    out.stdout
}

fn repo_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Repository) {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    git(dir.path(), &["config", "user.name", "테스터"]);
    git(dir.path(), &["config", "user.email", "t@example.com"]);
    git(dir.path(), &["config", "commit.gpgsign", "false"]);
    for (name, content) in files {
        std::fs::write(dir.path().join(name), content).unwrap();
    }
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-qm", "init"]);
    let repo = Repository::open(GitRunner::default(), dir.path()).unwrap();
    (dir, repo)
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

#[test]
fn worktree_discard_keeps_staged_changes() {
    let (dir, repo) = repo_with(&[("한글 a.txt", "1\n2\n3\n")]);
    let path = "한글 a.txt".to_string();
    // 일부만 Stage: 첫 줄을 고쳐 Stage 한 뒤, 끝 줄을 더 고친다.
    std::fs::write(dir.path().join(&path), "1x\n2\n3\n").unwrap();
    git(dir.path(), &["add", "--", &path]);
    std::fs::write(dir.path().join(&path), "1x\n2\n3y\n").unwrap();
    // 새 파일도 하나.
    std::fs::write(dir.path().join("새 파일.txt"), "new\n").unwrap();

    repo.discard_worktree(&[path.clone(), "새 파일.txt".to_string()]).unwrap();

    // 작업 트리는 Stage 한 판(1x)으로 돌아가고, 인덱스의 1x 는 그대로다.
    assert_eq!(read(dir.path(), &path), "1x\n2\n3\n");
    let cached = git(dir.path(), &["diff", "--cached", "--no-color"]);
    assert!(cached.contains("+1x"), "{cached}");
    assert!(git(dir.path(), &["diff", "--no-color"]).is_empty());
    assert!(!dir.path().join("새 파일.txt").exists());
    let st = repo.status().unwrap();
    assert_eq!(st.staged.len(), 1);
    assert!(st.unstaged.is_empty());
}

#[test]
fn worktree_discard_restores_deleted_file_from_index() {
    let (dir, repo) = repo_with(&[("b.txt", "b\n")]);
    std::fs::remove_file(dir.path().join("b.txt")).unwrap();
    repo.discard_worktree(&["b.txt".to_string()]).unwrap();
    assert_eq!(read(dir.path(), "b.txt"), "b\n");
    assert!(repo.status().unwrap().unstaged.is_empty());
}

#[test]
fn full_discard_resets_staged_and_worktree() {
    let (dir, repo) = repo_with(&[("c.txt", "1\n2\n")]);
    std::fs::write(dir.path().join("c.txt"), "1x\n2\n").unwrap();
    git(dir.path(), &["add", "--", "c.txt"]);
    std::fs::write(dir.path().join("c.txt"), "1x\n2y\n").unwrap();
    repo.discard(&["c.txt".to_string()]).unwrap();
    assert_eq!(read(dir.path(), "c.txt"), "1\n2\n");
    let st = repo.status().unwrap();
    assert!(st.staged.is_empty() && st.unstaged.is_empty());
}
