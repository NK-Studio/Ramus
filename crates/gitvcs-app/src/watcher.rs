//! 저장소 폴더의 바깥 변경(편집기 저장, 터미널 git)을 감시해 화면에 다시 읽으라고 알린다.
//!
//! 작업 트리의 변경과 .git 안의 참조·인덱스 변경만 본다. .git 안의 다른 파일(objects, *.lock, logs)은 git 이 일하는 동안
//! 수없이 바뀌므로 거른다. 알림은 잠잠해질 때까지 모아(디바운스) 한 번만 보낸다.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

/// 마지막 변경 뒤 이만큼 잠잠하면 알린다.
const QUIET: Duration = Duration::from_millis(300);
/// 변경이 계속 와도(빌드 등) 이 시간이 지나면 한 번은 알린다.
const MAX_WAIT: Duration = Duration::from_secs(2);

/// .git 안에서 상태가 바뀌었다는 뜻인 파일.
fn is_interesting_git_file(relative: &Path) -> bool {
    let name = relative.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".lock") {
        return false;
    }
    let first = relative.components().next().and_then(|c| c.as_os_str().to_str()).unwrap_or("");
    // logs/HEAD 같은 reflog 는 참조가 바뀔 때 함께 바뀌므로 참조 쪽만 본다.
    if matches!(first, "logs" | "objects" | "hooks" | "info") {
        return false;
    }
    matches!(name, "index" | "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "packed-refs")
        || first == "refs"
        || first == "rebase-merge"
        || first == "rebase-apply"
}

pub fn is_interesting(path: &Path, root: &Path, git_dir: &Path) -> bool {
    if let Ok(relative) = path.strip_prefix(git_dir) {
        return is_interesting_git_file(relative);
    }
    // worktree·서브모듈의 git 폴더가 저장소 안에 있을 수도 있다.
    if let Ok(relative) = path.strip_prefix(root) {
        return !relative.components().any(|c| c.as_os_str() == ".git");
    }
    false
}

/// 감시를 시작한다. 돌려준 값을 버리면 감시가 멈춘다.
pub fn watch(root: PathBuf, git_dir: PathBuf, on_change: impl Fn() + Send + 'static) -> notify::Result<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    // git 폴더가 저장소 밖에 있으면(worktree) 따로 본다.
    if !git_dir.starts_with(&root) {
        watcher.watch(&git_dir, RecursiveMode::Recursive)?;
    }
    thread::spawn(move || {
        let relevant = |event: &notify::Result<Event>| match event {
            Ok(e) => e.paths.iter().any(|p| is_interesting(p, &root, &git_dir)),
            // 이벤트를 놓쳤을 수 있다 — 다시 읽게 한다.
            Err(_) => true,
        };
        // 보낸 쪽(watcher)이 사라지면 recv 가 실패해 끝난다.
        while let Ok(event) = rx.recv() {
            if !relevant(&event) {
                continue;
            }
            let started = Instant::now();
            loop {
                let left = MAX_WAIT.saturating_sub(started.elapsed());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(QUIET.min(left)) {
                    Ok(_) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            on_change();
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_git_internals() {
        let root = Path::new("/r");
        let git = Path::new("/r/.git");
        assert!(is_interesting(Path::new("/r/src/a.rs"), root, git));
        assert!(is_interesting(Path::new("/r/.git/index"), root, git));
        assert!(is_interesting(Path::new("/r/.git/refs/heads/main"), root, git));
        assert!(is_interesting(Path::new("/r/.git/FETCH_HEAD"), root, git));
        assert!(!is_interesting(Path::new("/r/.git/index.lock"), root, git));
        assert!(!is_interesting(Path::new("/r/.git/objects/ab/cdef"), root, git));
        assert!(!is_interesting(Path::new("/r/.git/logs/HEAD"), root, git));
        assert!(!is_interesting(Path::new("/r/sub/.git/index"), root, git));
        assert!(!is_interesting(Path::new("/elsewhere/x"), root, git));
    }

    #[test]
    fn reports_changes_once_after_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = watch(root.clone(), root.join(".git"), move || tx.send(()).unwrap()).unwrap();
        thread::sleep(Duration::from_millis(200));
        for i in 0..5 {
            std::fs::write(root.join(format!("f{i}")), "x").unwrap();
        }
        rx.recv_timeout(Duration::from_secs(5)).expect("변경 알림이 와야 한다");
        // 몰려온 변경은 한 번으로 묶인다.
        assert!(rx.recv_timeout(Duration::from_millis(800)).is_err());
        // .git 안의 objects 변경은 알리지 않는다.
        std::fs::create_dir_all(root.join(".git/objects/ab")).unwrap();
        std::fs::write(root.join(".git/objects/ab/cd"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1200)).is_err());
    }
}
