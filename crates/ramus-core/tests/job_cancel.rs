//! 이름 붙은 작업(`with_job`)을 `cancel_job` 으로 멈추면 도는 git 이 끝나고 취소로 알려지는지 본다.

use std::time::{Duration, Instant};

use ramus_core::{GitRunner, cancel_job, with_job};

#[test]
fn cancelled_before_start_skips_git() {
    let dir = tempfile::tempdir().unwrap();
    // 시작 전에 온 취소는 with_job 이 지우므로, 작업 안에서 먼저 취소한 뒤 git 을 부른다.
    let (out, cancelled) = with_job("job-before", || {
        cancel_job("job-before");
        GitRunner::default().run(dir.path(), &["--version"])
    });
    assert!(cancelled);
    assert!(!out.success());
}

#[cfg(unix)]
#[test]
fn cancel_kills_running_git() {
    let dir = tempfile::tempdir().unwrap();
    // 표준 입력이 없으면 끝나지 않는 git 대신, 오래 도는 별칭(셸 sleep)을 git 으로 띄운다.
    let started = Instant::now();
    let canceller = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(300));
        cancel_job("job-running");
    });
    let (out, cancelled) = with_job("job-running", || GitRunner::default().run(dir.path(), &["-c", "alias.wait=!sleep 30", "wait"]));
    canceller.join().unwrap();
    assert!(cancelled);
    assert!(!out.success());
    assert!(started.elapsed() < Duration::from_secs(10), "취소했는데 {:?} 걸렸다", started.elapsed());
}
