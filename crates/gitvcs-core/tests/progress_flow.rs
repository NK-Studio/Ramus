//! 실제 git 으로 clone·push 하며 `--progress` 진행 줄이 알림으로 나가고, 돌려받는 글에는 섞이지 않는지 본다.
//! 진행 알림을 받을 곳은 프로세스에 한 번만 정할 수 있으므로 이 파일에는 테스트를 하나만 둔다.

use std::path::Path;
use std::sync::{Arc, Mutex};

use gitvcs_core::{GitRunner, Progress, Repository, remote, set_progress_sink};

fn git(dir: &Path, args: &[&str]) {
    let out = GitRunner::default().run(dir, args);
    assert!(out.success(), "git {args:?}: {}", out.message());
}

#[test]
fn clone_and_push_report_progress() {
    let seen: Arc<Mutex<Vec<Progress>>> = Arc::default();
    let sink = seen.clone();
    set_progress_sink(move |p| sink.lock().unwrap().push(p.clone()));

    let root = tempfile::tempdir().unwrap();
    let origin = root.path().join("origin.git");
    let work = root.path().join("work");
    git(root.path(), &["init", "-q", "--bare", "-b", "main", &origin.display().to_string()]);
    git(root.path(), &["init", "-q", "-b", "main", &work.display().to_string()]);
    for (k, v) in [("user.name", "테스터"), ("user.email", "tester@example.com"), ("commit.gpgsign", "false")] {
        git(&work, &["config", k, v]);
    }
    for i in 0..40 {
        std::fs::write(work.join(format!("f{i}.txt")), format!("{i}\n").repeat(200)).unwrap();
    }
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "-q", "-m", "많은 파일"]);
    let url = format!("file://{}", origin.display());
    git(&work, &["remote", "add", "origin", &url]);

    // push: "Writing objects" 같은 진행이 와야 하고, 돌려받는 글에는 진행 줄이 없어야 한다.
    let repo = Repository::open(GitRunner::default(), &work).unwrap();
    let message = repo.push().unwrap();
    assert!(!message.contains("Writing objects"), "{message}");
    assert!(seen.lock().unwrap().iter().any(|p| p.phase == "Writing objects"), "{:?}", seen.lock().unwrap());

    // clone: "Receiving objects" 가 와야 한다.
    seen.lock().unwrap().clear();
    remote::clone(&GitRunner::default(), &url, &root.path().join("copy")).unwrap();
    let phases: Vec<String> = seen.lock().unwrap().iter().map(|p| p.phase.clone()).collect();
    assert!(phases.iter().any(|p| p == "Receiving objects"), "{phases:?}");
}
