//! 임시 저장소에서 실제 git 으로 열기 → 변경 → Stage → 커밋 → 푸시 흐름을 돌린다.

use std::path::Path;

use gitvcs_core::status::FileState;
use gitvcs_core::{GitRunner, Repository};

fn git(dir: &Path, args: &[&str]) {
    let out = GitRunner::default().run(dir, args);
    assert!(out.success(), "git {args:?}: {}", out.message());
}

fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "테스터"]);
    git(dir, &["config", "user.email", "tester@example.com"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
}

#[test]
fn open_rejects_non_repository() {
    let dir = tempfile::tempdir().unwrap();
    let err = Repository::open(GitRunner::default(), dir.path()).err().unwrap();
    assert!(err.message.contains("Git 저장소가 아닙니다"), "{}", err.message);
}

#[test]
fn open_finds_root_from_subfolder() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let repo = Repository::open(GitRunner::default(), &dir.path().join("sub")).unwrap();
    assert_eq!(repo.root().canonicalize().unwrap(), dir.path().canonicalize().unwrap());
}

#[test]
fn stage_commit_push_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    let work = tmp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    init(&work);
    git(&work, &["remote", "add", "origin", remote.to_str().unwrap()]);

    let repo = Repository::open(GitRunner::default(), &work).unwrap();
    // 커밋 전: 빈 히스토리, 새 파일은 Untracked.
    assert!(repo.snapshot(100).unwrap().history.commits.is_empty());
    std::fs::write(work.join("한글 [1].txt"), "안녕\n").unwrap();
    std::fs::write(work.join("b.txt"), "b\n").unwrap();
    let st = repo.status().unwrap();
    assert!(!st.branch.has_commits);
    assert_eq!(st.unstaged.len(), 2);
    assert!(st.unstaged.iter().all(|e| e.state == FileState::Untracked));

    // glob 글자가 든 경로도 그대로 Stage 된다.
    repo.stage(&["한글 [1].txt".into()]).unwrap();
    let st = repo.status().unwrap();
    assert_eq!(st.staged.len(), 1);
    assert_eq!(st.staged[0].path, "한글 [1].txt");
    // 첫 커밋 전 Unstage.
    repo.unstage(&["한글 [1].txt".into()]).unwrap();
    assert!(repo.status().unwrap().staged.is_empty());

    assert!(repo.commit("  ", false).is_err());
    repo.stage_all().unwrap();
    let head = repo.commit("첫 커밋\n\n본문 \"따옴표\"", false).unwrap();
    assert_eq!(head.len(), 40);
    assert_eq!(repo.last_message().unwrap(), "첫 커밋\n\n본문 \"따옴표\"");

    // upstream 이 없으면 origin 에 올리고 추적을 건다.
    repo.push().unwrap();
    let st = repo.status().unwrap();
    assert_eq!(st.branch.upstream.as_deref(), Some("origin/main"));

    // 두 번째 커밋 → ahead 1 → push → 0.
    std::fs::write(work.join("b.txt"), "b2\n").unwrap();
    let st = repo.status().unwrap();
    assert_eq!(st.unstaged[0].state, FileState::Modified);
    repo.stage(&["b.txt".into()]).unwrap();
    repo.unstage(&["b.txt".into()]).unwrap();
    assert_eq!(repo.status().unwrap().unstaged.len(), 1);
    repo.stage_all().unwrap();
    repo.commit("둘째", false).unwrap();
    assert_eq!(repo.status().unwrap().branch.ahead, 1);
    repo.push().unwrap();
    assert_eq!(repo.status().unwrap().branch.ahead, 0);

    let h = repo.snapshot(100).unwrap().history;
    assert_eq!(h.commits.len(), 2);
    assert_eq!(h.commits[0].subject, "둘째");
    assert!(h.commits[0].refs.iter().any(|r| r.name == "origin/main"));
    assert_eq!(h.graph.nodes.len(), 2);
    // 지금 브랜치가 끝인 커밋에 이름표 하나(로컬+원격 합침).
    assert_eq!(h.graph.nodes[0].refs.len(), 1);
    assert!(h.graph.nodes[0].refs[0].has_remote);

    let detail = repo.commit_detail(&h.commits[1].hash).unwrap();
    assert_eq!(detail.files.len(), 2);
    assert!(detail.parents.is_empty());

    // Amend 는 HEAD 를 바꿔 끼운다. 이미 올린 옛 커밋은 origin/main 이 가리키므로 그래프에 가지로 남는다.
    repo.commit("둘째 (고침)", true).unwrap();
    let h = repo.snapshot(100).unwrap().history;
    assert_eq!(h.commits.len(), 3);
    assert_eq!(h.commits.iter().find(|c| Some(&c.hash) == h.head.as_ref()).unwrap().subject, "둘째 (고침)");
    // 지금 브랜치(main)가 맨 왼쪽 열, 원격에만 남은 옛 커밋은 그 오른쪽.
    let lane = |i: usize| &h.graph.lanes[h.graph.nodes[i].lane];
    let head_row = h.commits.iter().position(|c| Some(&c.hash) == h.head.as_ref()).unwrap();
    assert_eq!(lane(head_row).name, "main");
    assert_eq!(lane(head_row).column, 0);
    let old_row = h.commits.iter().position(|c| c.subject == "둘째").unwrap();
    assert_eq!(lane(old_row).name, "origin/main");
    assert_eq!(lane(old_row).column, 1);
    assert_eq!(repo.status().unwrap().branch.ahead, 1);
    assert_eq!(repo.status().unwrap().branch.behind, 1);
}

#[test]
fn push_without_remote_explains() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    std::fs::write(dir.path().join("a"), "a").unwrap();
    let repo = Repository::open(GitRunner::default(), dir.path()).unwrap();
    repo.stage_all().unwrap();
    repo.commit("a", false).unwrap();
    let err = repo.push().err().unwrap();
    assert!(err.message.contains("원격 저장소가 없습니다"));
}

#[test]
fn global_config_args_reach_git() {
    // SSL 설정처럼 앞에 붙인 -c 가 실제 git 에 닿는지(사용자 .gitconfig 는 건드리지 않는다).
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let runner = GitRunner::new(gitvcs_core::GitGlobals {
        config_args: gitvcs_core::ssl::build_arguments(&gitvcs_core::ssl::SslSettings { verify: false, ..Default::default() }, false),
        ..Default::default()
    });
    let out = runner.run(dir.path(), &["config", "--get", "http.sslVerify"]);
    assert_eq!(out.stdout.trim(), "false");
    let plain = GitRunner::default().run(dir.path(), &["config", "--get", "http.sslVerify"]);
    assert!(plain.stdout.trim().is_empty());
}

#[test]
fn clone_and_test_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    let work = tmp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    init(&work);
    std::fs::write(work.join("a"), "a").unwrap();
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "-qm", "a"]);
    git(&work, &["push", "-q", remote.to_str().unwrap(), "main"]);

    let runner = GitRunner::default();
    let url = remote.to_str().unwrap();
    assert_eq!(gitvcs_core::remote::test_connection(&runner, tmp.path(), url).unwrap(), 1);
    assert!(gitvcs_core::remote::test_connection(&runner, tmp.path(), "/없는/곳.git").is_err());

    let dest = tmp.path().join("받은 저장소");
    let repo = gitvcs_core::remote::clone(&runner, url, &dest).unwrap();
    assert!(dest.join("a").exists());
    assert_eq!(repo.default_remote_url().as_deref(), Some(url));
    // 이미 파일이 있는 폴더에는 받지 않는다.
    assert!(gitvcs_core::remote::clone(&runner, url, &dest).is_err());
    // 실패하면 만들다 만 폴더를 남기지 않는다.
    let bad = tmp.path().join("bad");
    assert!(gitvcs_core::remote::clone(&runner, "/없는/곳.git", &bad).is_err());
    assert!(!bad.exists());
}
