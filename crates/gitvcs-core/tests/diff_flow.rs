//! 실제 git 으로 diff 읽기 → 줄·hunk 단위 Stage·Unstage·버리기 → 파일 버리기 → 페치·풀.

use std::path::Path;

use gitvcs_core::diff::LineKind;
use gitvcs_core::repo::{DiffTarget, LineAction, PullMode};
use gitvcs_core::{GitRunner, Repository};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = GitRunner::default().run(dir, args);
    assert!(out.success(), "git {args:?}: {}", out.message());
    out.stdout
}

fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "테스터"]);
    git(dir, &["config", "user.email", "t@example.com"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
}

fn repo_with_file(content: &str) -> (tempfile::TempDir, Repository) {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    std::fs::write(dir.path().join("한글 파일.txt"), content).unwrap();
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-qm", "init"]);
    let repo = Repository::open(GitRunner::default(), dir.path()).unwrap();
    (dir, repo)
}

const PATH: &str = "한글 파일.txt";

fn unstaged() -> DiffTarget {
    DiffTarget::Unstaged { path: PATH.into(), untracked: false }
}

fn staged() -> DiffTarget {
    DiffTarget::Staged { path: PATH.into(), original_path: None }
}

fn index_of(doc: &gitvcs_core::diff::DiffDocument, kind: LineKind, text: &str) -> usize {
    doc.lines.iter().position(|l| l.kind == kind && l.text == text).unwrap_or_else(|| panic!("{text} 없음"))
}

#[test]
fn stage_unstage_and_discard_single_lines() {
    let (dir, repo) = repo_with_file("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n");
    // 떨어진 두 곳을 고친다 → hunk 두 개.
    std::fs::write(dir.path().join(PATH), "1\n2a\n3\n4\n5\n6\n7\n8\n9\n10\n11b\n12\nnew\n").unwrap();
    let doc = repo.diff(&unstaged()).unwrap();
    assert_eq!(doc.hunk_count, 2);
    assert_eq!((doc.added, doc.removed), (3, 2));

    // 둘째 hunk 의 "new" 한 줄만 Stage.
    let line = index_of(&doc, LineKind::Added, "new");
    repo.apply_lines(LineAction::Stage, PATH, false, &doc.fingerprint, &[line]).unwrap();
    let cached = git(dir.path(), &["diff", "--cached", "--no-color"]);
    assert!(cached.contains("+new") && !cached.contains("+2a") && !cached.contains("+11b"), "{cached}");

    // 지문이 다르면 거절한다.
    let err = repo.apply_lines(LineAction::Stage, PATH, false, "0000", &[line]).err().unwrap();
    assert!(err.message.contains("바뀌었습니다"));

    // 첫 hunk(2 → 2a)를 통째로 Stage.
    let doc = repo.diff(&unstaged()).unwrap();
    let hunk0 = gitvcs_core::patch::changed_lines_of_hunk(&doc.lines, 0);
    repo.apply_lines(LineAction::Stage, PATH, false, &doc.fingerprint, &hunk0).unwrap();
    let cached = git(dir.path(), &["diff", "--cached", "--no-color"]);
    assert!(cached.contains("+2a") && cached.contains("-2\n"));

    // Staged 에서 "new" 를 Unstage.
    let doc = repo.diff(&staged()).unwrap();
    let line = index_of(&doc, LineKind::Added, "new");
    repo.apply_lines(LineAction::Unstage, PATH, false, &doc.fingerprint, &[line]).unwrap();
    let cached = git(dir.path(), &["diff", "--cached", "--no-color"]);
    assert!(!cached.contains("+new") && cached.contains("+2a"));

    // 남은 Unstaged 변경 중 "11b" 줄을 버린다 → 작업 트리에서 11 로 돌아간다. "new" 는 남는다.
    let doc = repo.diff(&unstaged()).unwrap();
    let removed = index_of(&doc, LineKind::Removed, "11");
    let added = index_of(&doc, LineKind::Added, "11b");
    repo.apply_lines(LineAction::Discard, PATH, false, &doc.fingerprint, &[removed, added]).unwrap();
    let text = std::fs::read_to_string(dir.path().join(PATH)).unwrap();
    assert_eq!(text, "1\n2a\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\nnew\n");
}

#[test]
fn stage_lines_of_new_file() {
    let (dir, repo) = repo_with_file("x\n");
    std::fs::write(dir.path().join("새.txt"), "a\nb\nc\n").unwrap();
    let target = DiffTarget::Unstaged { path: "새.txt".into(), untracked: true };
    let doc = repo.diff(&target).unwrap();
    assert_eq!(doc.added, 3);
    let b = index_of(&doc, LineKind::Added, "b");
    repo.apply_lines(LineAction::Stage, "새.txt", true, &doc.fingerprint, &[b]).unwrap();
    let blob = git(dir.path(), &["show", ":새.txt"]);
    assert_eq!(blob, "b\n");
}

#[test]
fn crlf_lines_round_trip() {
    let (dir, repo) = repo_with_file("a\r\nb\r\n");
    std::fs::write(dir.path().join(PATH), "a\r\nx\r\nb\r\ny\r\n").unwrap();
    let doc = repo.diff(&unstaged()).unwrap();
    let x = index_of(&doc, LineKind::Added, "x");
    repo.apply_lines(LineAction::Stage, PATH, false, &doc.fingerprint, &[x]).unwrap();
    assert_eq!(git(dir.path(), &["show", &format!(":{PATH}")]), "a\r\nx\r\nb\r\n");
}

#[test]
fn discard_files_of_every_kind() {
    let (dir, repo) = repo_with_file("orig\n");
    std::fs::write(dir.path().join(PATH), "changed\n").unwrap();
    git(dir.path(), &["add", "-A"]);
    std::fs::write(dir.path().join(PATH), "changed again\n").unwrap();
    std::fs::write(dir.path().join("untracked.txt"), "u").unwrap();
    std::fs::write(dir.path().join("added.txt"), "a").unwrap();
    git(dir.path(), &["add", "added.txt"]);
    repo.discard(&[PATH.into(), "untracked.txt".into(), "added.txt".into()]).unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join(PATH)).unwrap(), "orig\n");
    assert!(!dir.path().join("untracked.txt").exists());
    assert!(!dir.path().join("added.txt").exists());
    let st = repo.status().unwrap();
    assert!(st.staged.is_empty() && st.unstaged.is_empty());
}

#[test]
fn discard_rejects_paths_outside() {
    let (_dir, repo) = repo_with_file("x\n");
    // 상태에 없는 경로는 아무것도 하지 않는다.
    repo.discard(&["../../etc/passwd".into()]).unwrap();
}

#[test]
fn commit_diff_and_binary() {
    let (dir, repo) = repo_with_file("a\n");
    std::fs::write(dir.path().join("bin.dat"), [0u8, 1, 2, 0, 255]).unwrap();
    std::fs::write(dir.path().join(PATH), "a\nb\n").unwrap();
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-qm", "two"]);
    let head = git(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
    let doc = repo.diff(&DiffTarget::Commit { hash: head.clone(), path: PATH.into(), original_path: None }).unwrap();
    assert_eq!(doc.added, 1);
    let bin = repo.diff(&DiffTarget::Commit { hash: head, path: "bin.dat".into(), original_path: None }).unwrap();
    assert!(bin.binary);
}

#[test]
fn fetch_and_pull() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    for dir in [&a, &b] {
        std::fs::create_dir(dir).unwrap();
    }
    init(&a);
    std::fs::write(a.join("f"), "1\n").unwrap();
    git(&a, &["add", "-A"]);
    git(&a, &["commit", "-qm", "one"]);
    git(&a, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&a, &["push", "-qu", "origin", "main"]);
    git(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), b.to_str().unwrap()]);
    init(&b);

    let repo_a = Repository::open(GitRunner::default(), &a).unwrap();
    let repo_b = Repository::open(GitRunner::default(), &b).unwrap();
    assert!(repo_b.last_fetch().is_none() || repo_b.last_fetch().is_some());

    // b 가 올린 커밋을 a 가 페치하면 behind 1, 풀하면 0.
    std::fs::write(b.join("f"), "1\n2\n").unwrap();
    git(&b, &["commit", "-qam", "two"]);
    git(&b, &["push", "-q"]);
    assert!(repo_a.fetch(true).unwrap());
    assert!(repo_a.last_fetch().is_some());
    assert_eq!(repo_a.status().unwrap().branch.behind, 1);
    repo_a.pull(PullMode::FfOnly).unwrap();
    assert_eq!(repo_a.status().unwrap().branch.behind, 0);

    // 갈라지면 ff-only 는 안내와 함께 실패하고, rebase 는 된다.
    std::fs::write(b.join("g"), "b\n").unwrap();
    git(&b, &["add", "-A"]);
    git(&b, &["commit", "-qm", "b"]);
    git(&b, &["push", "-q"]);
    std::fs::write(a.join("h"), "a\n").unwrap();
    git(&a, &["add", "-A"]);
    git(&a, &["commit", "-qm", "a"]);
    repo_a.fetch(false).unwrap();
    let err = repo_a.pull(PullMode::FfOnly).err().unwrap();
    assert!(err.message.contains("갈라져"), "{}", err.message);
    repo_a.pull(PullMode::Rebase).unwrap();
    let st = repo_a.status().unwrap().branch;
    assert_eq!((st.ahead, st.behind), (1, 0));

    // 원격이 없으면 페치하지 않는다.
    let lone = tempfile::tempdir().unwrap();
    init(lone.path());
    assert!(!Repository::open(GitRunner::default(), lone.path()).unwrap().fetch(true).unwrap());
}
