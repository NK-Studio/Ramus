//! PC 에 설치된 `git` CLI 를 실행한다.
//!
//! 앱에는 터미널이 없으므로 git 의 사용자 이름·비밀번호 질문을 끈다(`GIT_TERMINAL_PROMPT=0`). 질문을 켜 두면 영원히 기다린다.
//! SSL 설정(`ssl::build_arguments`)은 git 호출마다 `-c` 로 앞에 붙인다 — 사용자의 `.gitconfig` 는 건드리지 않는다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, RwLock};
use std::thread;

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
        let mut stderr = child.stderr.take().unwrap();
        let err_thread = thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            buf
        });
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
