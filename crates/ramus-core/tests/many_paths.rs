//! 파일이 수천 개여도 Stage · Unstage · 버리기 · 일부 Stash · 패치가 된다.
//! 경로를 명령줄로 넘기면 Windows 명령줄 한계(32,767자)를 넘어 git 을 띄우지도 못한다(os error 206).

use std::path::Path;

use ramus_core::{GitRunner, Repository};

/// 경로 길이를 다 더하면 명령줄 한계를 훌쩍 넘는다(약 3000 × 70자).
const COUNT: usize = 3000;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = GitRunner::default().run(dir, args);
    assert!(out.success(), "git {args:?}: {}", out.message());
    out.stdout
}

fn path(i: usize) -> String {
    format!("Assets/Distant Lands/COZY Pro/Folder{:02}/Some_Long_Asset_Name_{i:05}.prefab", i % 40)
}

fn setup() -> (tempfile::TempDir, Repository, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "테스터"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    git(d, &["config", "core.autocrlf", "false"]);
    let paths: Vec<String> = (0..COUNT).map(path).collect();
    assert!(paths.iter().map(|p| p.len() + 1).sum::<usize>() > 40_000);
    for p in &paths {
        let full = d.join(p);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, "1\n").unwrap();
    }
    git(d, &["add", "-A"]);
    git(d, &["commit", "-qm", "base"]);
    let repo = Repository::open(GitRunner::default(), d).unwrap();
    (dir, repo, paths)
}

fn modify_all(d: &Path, paths: &[String]) {
    for p in paths {
        std::fs::write(d.join(p), "2\n").unwrap();
    }
}

#[test]
fn stage_unstage_and_discard_thousands_of_files() {
    let (dir, repo, paths) = setup();
    let d = dir.path();
    modify_all(d, &paths);

    repo.stage(&paths).unwrap();
    assert_eq!(repo.status().unwrap().staged.len(), COUNT);
    repo.unstage(&paths).unwrap();
    let st = repo.status().unwrap();
    assert!(st.staged.is_empty());
    assert_eq!(st.unstaged.len(), COUNT);

    repo.discard_worktree(&paths).unwrap();
    assert!(repo.status().unwrap().unstaged.is_empty());
    assert_eq!(std::fs::read_to_string(d.join(&paths[0])).unwrap(), "1\n");

    // Stage 한 것까지 마지막 커밋 상태로(모든 변경 버리기).
    modify_all(d, &paths);
    repo.stage(&paths[..COUNT / 2]).unwrap();
    repo.discard(&paths).unwrap();
    let st = repo.status().unwrap();
    assert!(st.staged.is_empty() && st.unstaged.is_empty());
}

#[test]
fn discard_removes_thousands_of_added_files() {
    let (dir, repo, _) = setup();
    let d = dir.path();
    let added: Vec<String> = (0..COUNT).map(|i| format!("New Folder/Another_Long_New_File_Name_{i:05}.asset")).collect();
    for p in &added {
        let full = d.join(p);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, "n\n").unwrap();
    }
    repo.stage(&added).unwrap();
    assert_eq!(repo.status().unwrap().staged.len(), COUNT);
    repo.discard(&added).unwrap();
    let st = repo.status().unwrap();
    assert!(st.staged.is_empty() && st.unstaged.is_empty());
    assert!(!d.join(&added[0]).exists());
}

#[test]
fn stash_and_patch_thousands_of_files() {
    let (dir, repo, paths) = setup();
    let d = dir.path();
    modify_all(d, &paths);

    let patch = repo.create_patch(&paths, false).unwrap();
    assert_eq!(patch.matches("diff --git ").count(), COUNT);

    repo.stash_paths(&paths, "많은 파일").unwrap();
    assert!(repo.status().unwrap().unstaged.is_empty());
    assert_eq!(git(d, &["stash", "list"]).lines().count(), 1);
}

/// "모든 변경 버리기": 수정·삭제·Stage 한 새 파일·새 폴더를 한 번에 되돌리고, .gitignore 로 무시한 파일은 남긴다.
#[test]
fn discard_all_restores_everything_but_ignored_files() {
    let (dir, repo, paths) = setup();
    let d = dir.path();
    std::fs::write(d.join(".gitignore"), "Library/\n").unwrap();
    git(d, &["add", ".gitignore"]);
    git(d, &["commit", "-qm", "ignore"]);
    modify_all(d, &paths[..COUNT / 2]);
    for p in &paths[COUNT / 2..] {
        std::fs::remove_file(d.join(p)).unwrap();
    }
    std::fs::create_dir_all(d.join("New Folder/Deep")).unwrap();
    std::fs::write(d.join("New Folder/Deep/a.asset"), "n\n").unwrap();
    std::fs::write(d.join("staged.txt"), "s\n").unwrap();
    git(d, &["add", "staged.txt"]);
    std::fs::create_dir_all(d.join("Library")).unwrap();
    std::fs::write(d.join("Library/cache.bin"), "c\n").unwrap();

    let seen: Vec<String> = { let st = repo.status().unwrap(); st.unstaged.iter().chain(&st.staged).map(|e| e.path.clone()).collect() };
    repo.discard_all(&seen).unwrap();
    let st = repo.status().unwrap();
    assert!(st.staged.is_empty() && st.unstaged.is_empty());
    assert_eq!(std::fs::read_to_string(d.join(&paths[0])).unwrap(), "1\n");
    assert!(d.join(&paths[COUNT - 1]).exists());
    assert!(!d.join("New Folder").exists() && !d.join("staged.txt").exists());
    assert!(d.join("Library/cache.bin").exists(), "무시한 파일은 남긴다");
}

/// 숨긴 파일(keep)이 있으면 그 파일만 남기고 나머지를 버린다.
#[test]
fn discard_all_keeps_hidden_paths() {
    let (dir, repo, paths) = setup();
    let d = dir.path();
    modify_all(d, &paths[..10]);
    std::fs::write(d.join("keep-me.txt"), "k\n").unwrap();
    std::fs::write(d.join("drop-me.txt"), "d\n").unwrap();

    // 화면은 숨긴 파일(paths[0], keep-me.txt)을 빼고 넘긴다.
    let seen: Vec<String> = paths[1..10].iter().cloned().chain(["drop-me.txt".to_string()]).collect();
    repo.discard_all(&seen).unwrap();
    let st = repo.status().unwrap();
    let left: Vec<&str> = st.unstaged.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(left.contains(&paths[0].as_str()) && left.contains(&"keep-me.txt"));
    assert!(!d.join("drop-me.txt").exists());
}

/// 확인 창을 띄운 뒤 새로 생긴 파일은 화면이 보지 못했으니 버리지 않는다.
#[test]
fn discard_all_leaves_changes_the_screen_did_not_see() {
    let (dir, repo, paths) = setup();
    let d = dir.path();
    modify_all(d, &paths[..10]);
    let seen: Vec<String> = repo.status().unwrap().unstaged.iter().map(|e| e.path.clone()).collect();
    std::fs::write(d.join("made-after-confirm.txt"), "new\n").unwrap();

    repo.discard_all(&seen).unwrap();
    let left: Vec<String> = repo.status().unwrap().unstaged.iter().map(|e| e.path.clone()).collect();
    assert_eq!(left, ["made-after-confirm.txt"]);
    assert_eq!(std::fs::read_to_string(d.join(&paths[0])).unwrap(), "1\n");
}

/// assume-unchanged 로 표시한 파일의 로컬 수정은 지우지 않는다(reset --hard 를 쓰지 않는다).
#[test]
fn discard_all_keeps_assume_unchanged_local_edits() {
    let (dir, repo, paths) = setup();
    let d = dir.path();
    git(d, &["update-index", "--assume-unchanged", &paths[0]]);
    std::fs::write(d.join(&paths[0]), "local settings\n").unwrap();
    modify_all(d, &paths[1..10]);
    let seen: Vec<String> = repo.status().unwrap().unstaged.iter().map(|e| e.path.clone()).collect();
    assert_eq!(seen.len(), 9, "assume-unchanged 파일은 변경 목록에 없다");

    repo.discard_all(&seen).unwrap();
    assert!(repo.status().unwrap().unstaged.is_empty());
    assert_eq!(std::fs::read_to_string(d.join(&paths[0])).unwrap(), "local settings\n");
    assert_eq!(std::fs::read_to_string(d.join(&paths[1])).unwrap(), "1\n");
}
