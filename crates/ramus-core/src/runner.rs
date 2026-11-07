//! PC 에 설치된 `git` CLI 를 실행한다.
//!
//! 앱에는 터미널이 없으므로 git 의 사용자 이름·비밀번호 질문을 끈다(`GIT_TERMINAL_PROMPT=0`). 질문을 켜 두면 영원히 기다린다.
//! SSL 설정(`ssl::build_arguments`)은 git 호출마다 `-c` 로 앞에 붙인다 — 사용자의 `.gitconfig` 는 건드리지 않는다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};

/// git 이 `--progress` 로 stderr 에 쓰는 진행 한 줄("Receiving objects:  45% (1234/2700), 1.20 MiB | 2.00 MiB/s").
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Progress {
    /// 원격 서버가 알린 단계면 true("remote: Counting objects: …").
    pub remote: bool,
    /// 단계 이름(영어 그대로): "Receiving objects", "Resolving deltas", "Writing objects" 등.
    pub phase: String,
    pub percent: Option<u8>,
    pub current: Option<u64>,
    pub total: Option<u64>,
    /// 쉼표 뒤 덧붙임(받은 양·속도). 없으면 빈 글.
    pub detail: String,
    pub done: bool,
}

type ProgressSink = Box<dyn Fn(&Progress) + Send + Sync>;
static PROGRESS_SINK: OnceLock<ProgressSink> = OnceLock::new();

/// `RAMUS_TRACE` 환경 변수가 있으면 git 호출마다 걸린 시간을 stderr 에 적는다(개발 중 병목 찾기).
pub fn trace_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("RAMUS_TRACE").is_some())
}

/// `[trace] 이름 12ms` 꼴로 stderr 에 적는다. `RAMUS_TRACE` 가 없으면 아무것도 하지 않는다.
pub fn trace(name: &str, started: Instant) {
    if trace_enabled() {
        eprintln!("[trace] {name} {}ms", started.elapsed().as_millis());
    }
}

/// git 진행 줄을 받을 곳을 한 번 정한다(앱이 화면으로 보낸다). 모든 GitRunner 가 함께 쓴다.
pub fn set_progress_sink(sink: impl Fn(&Progress) + Send + Sync + 'static) {
    let _ = PROGRESS_SINK.set(Box::new(sink));
}

/// 진행 줄인지 보고 나눈다. 단계 이름이 objects·deltas·files·content 로 끝나는 "단계: 숫자…" 꼴만 진행으로 친다.
pub fn parse_progress(line: &str) -> Option<Progress> {
    let line = line.trim();
    let (remote, body) = match line.strip_prefix("remote:") {
        Some(rest) => (true, rest.trim_start()),
        None => (false, line),
    };
    let (phase, rest) = body.split_once(':')?;
    let phase = phase.trim();
    let known = ["objects", "deltas", "files", "content"];
    if phase.is_empty() || !phase.starts_with(|c: char| c.is_ascii_uppercase()) || !known.iter().any(|k| phase.ends_with(k)) {
        return None;
    }
    let rest = rest.trim();
    if !rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let done = rest.ends_with(", done.") || rest.ends_with("done.");
    let (head, detail) = match rest.split_once(", ") {
        Some((h, d)) => (h.trim(), d.trim_end_matches("done.").trim().trim_end_matches(',').trim().to_string()),
        None => (rest.trim_end_matches(", done.").trim_end_matches('.'), String::new()),
    };
    let mut percent = None;
    let (mut current, mut total) = (None, None);
    if let Some((pct, after)) = head.split_once('%') {
        percent = pct.trim().parse::<u8>().ok();
        if let Some(inner) = after.trim().strip_prefix('(').and_then(|t| t.split(')').next()) {
            if let Some((c, t)) = inner.split_once('/') {
                current = c.trim().parse().ok();
                total = t.trim().parse().ok();
            }
        }
    } else {
        current = head.trim().trim_end_matches(',').parse().ok();
    }
    Some(Progress { remote, phase: phase.to_string(), percent, current, total, detail, done })
}

/// stderr 를 흘려 읽으며 진행 줄은 알림으로 보내고(너무 잦지 않게), 나머지만 모아 돌려준다.
fn drain_stderr(mut stderr: impl Read) -> Vec<u8> {
    let sink = PROGRESS_SINK.get();
    let mut kept = Vec::new();
    let mut line = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut last: Option<(Instant, String)> = None;
    let mut flush = |line: &mut Vec<u8>, kept: &mut Vec<u8>, ended_by_newline: bool| {
        if line.is_empty() {
            if ended_by_newline {
                kept.push(b'\n');
            }
            return;
        }
        let text = String::from_utf8_lossy(line).into_owned();
        match parse_progress(&text) {
            Some(progress) => {
                if let Some(sink) = sink {
                    // 단계가 바뀌거나 끝났거나 0.1초가 지났을 때만 보낸다.
                    let due = match &last {
                        Some((at, phase)) => progress.done || *phase != progress.phase || at.elapsed() >= Duration::from_millis(100),
                        None => true,
                    };
                    if due {
                        sink(&progress);
                        last = Some((Instant::now(), progress.phase.clone()));
                    }
                }
            }
            None => {
                kept.extend_from_slice(line);
                kept.push(b'\n');
            }
        }
        line.clear();
    };
    loop {
        let n = match stderr.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &chunk[..n] {
            match byte {
                b'\r' => flush(&mut line, &mut kept, false),
                b'\n' => flush(&mut line, &mut kept, true),
                _ => line.push(byte),
            }
        }
    }
    flush(&mut line, &mut kept, false);
    kept
}

/// git 한 번 실행한 결과.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.code == 0
    }

    /// 실패했을 때 사용자에게 보일 글. stderr 가 비면 stdout.
    pub fn message(&self) -> String {
        let err = self.stderr.trim();
        if err.is_empty() { self.stdout.trim().to_string() } else { err.to_string() }
    }

    fn failed(message: String) -> Self {
        GitOutput { code: -1, stdout: String::new(), stderr: message }
    }
}

/// 모든 git 호출에 같이 붙는 것: git 경로, 전역 `-c` 인자, 추가 환경 변수(SSH 로그인 등).
#[derive(Debug, Clone, Default)]
pub struct GitGlobals {
    pub git_path: Option<PathBuf>,
    pub config_args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// 여러 스레드가 함께 쓰는 git 실행기. 설정이 바뀌면 `set_globals` 로 갈아 끼운다.
#[derive(Clone, Default)]
pub struct GitRunner {
    globals: Arc<RwLock<GitGlobals>>,
}

impl GitRunner {
    pub fn new(globals: GitGlobals) -> Self {
        GitRunner { globals: Arc::new(RwLock::new(globals)) }
    }

    pub fn set_globals(&self, globals: GitGlobals) {
        *self.globals.write().unwrap() = globals;
    }

    pub fn globals(&self) -> GitGlobals {
        self.globals.read().unwrap().clone()
    }

    pub fn run<S: AsRef<str>>(&self, dir: &Path, args: &[S]) -> GitOutput {
        self.run_with(dir, args, None, &HashMap::new())
    }

    /// 바이트 그대로 받는다(그림 등). (종료 코드, stdout)
    pub fn run_bytes<S: AsRef<str>>(&self, dir: &Path, args: &[S]) -> (i32, Vec<u8>) {
        let globals = self.globals();
        let git = globals.git_path.clone().unwrap_or_else(|| PathBuf::from("git"));
        let mut cmd = Command::new(&git);
        cmd.current_dir(dir).args(&globals.config_args).args(args.iter().map(|a| a.as_ref()));
        apply_environment(&mut cmd);
        cmd.envs(&globals.env);
        hide_console(&mut cmd);
        cmd.stdin(Stdio::null()).stderr(Stdio::null());
        match cmd.output() {
            Ok(out) => (out.status.code().unwrap_or(-1), out.stdout),
            Err(_) => (-1, Vec::new()),
        }
    }

    /// `input` 은 표준 입력으로 흘려 넣는다(`git apply --cached` 의 패치 등).
    pub fn run_with<S: AsRef<str>>(&self, dir: &Path, args: &[S], input: Option<&str>, extra_env: &HashMap<String, String>) -> GitOutput {
        let started = Instant::now();
        let out = self.run_inner(dir, args, input, extra_env);
        if trace_enabled() {
            let mut line = args.iter().map(|a| a.as_ref()).collect::<Vec<_>>().join(" ");
            if line.len() > 72 {
                line = format!("{}…", line.chars().take(72).collect::<String>());
            }
            trace(&format!("git {line} ({}B)", out.stdout.len()), started);
        }
        out
    }

    fn run_inner<S: AsRef<str>>(&self, dir: &Path, args: &[S], input: Option<&str>, extra_env: &HashMap<String, String>) -> GitOutput {
        let globals = self.globals();
        let git = globals.git_path.clone().unwrap_or_else(|| PathBuf::from("git"));
        let mut cmd = Command::new(&git);
        cmd.current_dir(dir);
        cmd.args(&globals.config_args);
        cmd.args(args.iter().map(|a| a.as_ref()));
        apply_environment(&mut cmd);
        cmd.envs(&globals.env);
        cmd.envs(extra_env);
        hide_console(&mut cmd);
        cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => return GitOutput::failed(format!("git 을 실행하지 못했습니다({}): {e}", git.display())),
        };
        if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
            let text = text.to_string();
            // 큰 패치를 쓰는 동안 stdout 이 차서 멈추지 않게 따로 쓴다.
            thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            });
        }
        // stdout·stderr 를 동시에 비우지 않으면 한쪽 파이프 버퍼가 차서 git 이 멈춘다.
        // `--progress` 로 부른 명령의 진행 줄은 여기서 알림으로 나가고 stderr 글에는 남지 않는다.
        let stderr = child.stderr.take().unwrap();
        let err_thread = thread::spawn(move || drain_stderr(stderr));
        let mut out = Vec::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_end(&mut out);
        }
        let err = err_thread.join().unwrap_or_default();
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        GitOutput {
            code,
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
        }
    }
}

fn apply_environment(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // 읽기 명령(status 등)이 index.lock 을 잡아 사용자의 터미널 git 과 부딪히지 않게 한다.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    // 경로의 [ ] * 같은 글자가 glob 으로 읽히지 않게 한다.
    cmd.env("GIT_LITERAL_PATHSPECS", "1");
    // 오류 글을 영어로 받아야 SSL·인증 실패를 알아본다.
    cmd.env("LC_MESSAGES", "C");
    cmd.env("LANGUAGE", "en");
    // 편집기를 띄우지 않는다(병합 커밋 메시지 등).
    cmd.env("GIT_EDITOR", "true");
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines() {
        let p = parse_progress("Receiving objects:  45% (1234/2700), 1.20 MiB | 2.00 MiB/s").unwrap();
        assert_eq!((p.remote, p.phase.as_str(), p.percent, p.current, p.total), (false, "Receiving objects", Some(45), Some(1234), Some(2700)));
        assert_eq!(p.detail, "1.20 MiB | 2.00 MiB/s");
        assert!(!p.done);
        let p = parse_progress("remote: Counting objects: 100% (12/12), done.").unwrap();
        assert!(p.remote && p.done);
        assert_eq!(p.percent, Some(100));
        let p = parse_progress("remote: Enumerating objects: 15, done.").unwrap();
        assert_eq!((p.percent, p.current), (None, Some(15)));
        let p = parse_progress("Resolving deltas: 100% (3/3), completed with 2 local objects.").unwrap();
        assert_eq!(p.percent, Some(100));
        assert!(parse_progress("Updating files:  50% (5/10)").is_some());
        assert!(parse_progress("error: failed to push some refs").is_none());
        assert!(parse_progress("To https://github.com/a/b.git").is_none());
        assert!(parse_progress("fatal: repository 'x' not found").is_none());
        assert!(parse_progress("Already up to date.").is_none());
    }

    #[test]
    fn drain_keeps_messages_and_drops_progress() {
        let raw = b"remote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\nTo origin\n   abc..def  main -> main\n";
        let kept = String::from_utf8(drain_stderr(&raw[..])).unwrap();
        assert_eq!(kept, "To origin\n   abc..def  main -> main\n");
    }
}
