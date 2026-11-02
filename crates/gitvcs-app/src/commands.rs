//! 화면이 보낸 요청을 git 작업으로 바꾼다. 작업 스레드에서 불린다 — 화면 스레드를 막지 않는다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gitvcs_core::conflict::Side;
use gitvcs_core::refs::ResetMode;
use gitvcs_core::repo::{DiffTarget, LineAction, PullMode, Result};
use gitvcs_core::{GitError, GitGlobals, GitRunner, Repository, Settings, login, remote, ssl};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::watcher;

/// 한 번에 읽는 커밋 수.
const HISTORY_PAGE: usize = 2000;

/// 화면에 요청 없이 알리는 함수(이벤트 이름, 내용).
pub type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;

pub struct AppState {
    pub runner: GitRunner,
    pub settings: Mutex<Settings>,
    settings_path: Option<PathBuf>,
    repo: Mutex<Option<Repository>>,
    /// 저장소를 바꾸는 작업(Stage·커밋·네트워크)은 한 번에 하나만. 읽기는 함께 돌아도 된다.
    write_lock: Mutex<()>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// 마지막 자동 페치 시도(실패해도). 실패한 페치를 30초마다 되풀이하지 않게.
    last_auto_fetch: Mutex<Option<Instant>>,
    /// 앱에서 로그인한 SSH 서버와 비밀번호. 앱을 끌 때까지만 기억한다(파일에 쓰지 않는다).
    ssh_login: Mutex<Option<(String, String)>>,
    emit: Emit,
}

/// 화면에 알릴 일. 응답 말고도 창 제목 같은 것을 바꿔야 할 때.
pub enum SideEffect {
    Title(String),
}

impl AppState {
    pub fn load(emit: Emit) -> AppState {
        let settings_path = std::env::var_os("GITVCS_SETTINGS").map(PathBuf::from).or_else(Settings::default_path);
        let settings = settings_path.as_deref().map(Settings::load).unwrap_or_default();
        let runner = GitRunner::new(globals_for(&settings));
        AppState {
            runner,
            settings: Mutex::new(settings),
            settings_path,
            repo: Mutex::new(None),
            write_lock: Mutex::new(()),
            watcher: Mutex::new(None),
            last_auto_fetch: Mutex::new(None),
            ssh_login: Mutex::new(None),
            emit,
        }
    }

    fn save_settings(&self, settings: &Settings) {
        if let Some(path) = &self.settings_path
            && let Err(e) = settings.save(path)
        {
            eprintln!("설정을 저장하지 못했습니다: {e}");
        }
    }

    /// 설정·SSH 로그인이 바뀌면 모든 git 호출에 붙는 것을 다시 만든다.
    fn apply_globals(&self) {
        let mut globals = globals_for(&self.settings.lock().unwrap());
        if let Some((host, password)) = self.ssh_login.lock().unwrap().clone() {
            match login::write_askpass(&std::env::temp_dir().join(format!("GitVcs-{}", whoami()))) {
                Ok(askpass) => globals.env = login::ssh_environment(&askpass, &host, &password),
                Err(e) => eprintln!("SSH 비밀번호 도우미를 만들지 못했습니다: {e}"),
            }
        }
        self.runner.set_globals(globals);
    }

    fn repo(&self) -> Result<Repository> {
        self.repo.lock().unwrap().clone().ok_or_else(|| GitError::new("열린 저장소가 없습니다."))
    }

    fn open_repo(self: &std::sync::Arc<Self>, path: &Path, effects: &mut Vec<SideEffect>) -> Result<Value> {
        let repo = Repository::open(self.runner.clone(), path)?;
        let root = repo.root().display().to_string();
        {
            let mut settings = self.settings.lock().unwrap();
            settings.touch_recent(&root, &repo.name(), now());
            settings.open_tab(&root);
            self.save_settings(&settings);
        }
        let info = repo_info(&repo);
        effects.push(SideEffect::Title(format!("{} — GitVcs", repo.name())));
        self.start_watching(&repo);
        *self.repo.lock().unwrap() = Some(repo);
        *self.last_auto_fetch.lock().unwrap() = None;
        Ok(info)
    }

    /// 바깥 변경을 감시한다. 알림이 오면 화면이 다시 읽는다(`changed`).
    fn start_watching(self: &std::sync::Arc<Self>, repo: &Repository) {
        let weak = std::sync::Arc::downgrade(self);
        let root = repo.root().display().to_string();
        let watched = watcher::watch(repo.root().to_path_buf(), repo.git_dir().to_path_buf(), move || {
            if let Some(state) = weak.upgrade() {
                (state.emit)("changed", json!({ "repo": root }));
            }
        });
        match watched {
            Ok(w) => *self.watcher.lock().unwrap() = Some(w),
            Err(e) => {
                eprintln!("파일 감시를 시작하지 못했습니다: {e}");
                *self.watcher.lock().unwrap() = None;
            }
        }
    }

    /// 자동 페치 할 때가 됐으면 한다. 앱이 30초마다 부른다. 다른 작업 중이면 건너뛴다.
    pub fn auto_fetch_tick(&self) {
        let minutes = self.settings.lock().unwrap().auto_fetch_minutes;
        let Ok(repo) = self.repo() else { return };
        if minutes == 0 {
            return;
        }
        let interval = Duration::from_secs(minutes as u64 * 60);
        // 손으로 한 페치·터미널 페치(FETCH_HEAD)와 마지막 시도 중 늦은 쪽에서 간격이 지났는가.
        let since_fetch = repo.last_fetch().and_then(|t| SystemTime::now().duration_since(t).ok());
        let since_try = self.last_auto_fetch.lock().unwrap().map(|t| t.elapsed());
        let due = |d: Option<Duration>| d.is_none_or(|d| d >= interval);
        if !(due(since_fetch) && due(since_try)) {
            return;
        }
        let Ok(_guard) = self.write_lock.try_lock() else { return };
        *self.last_auto_fetch.lock().unwrap() = Some(Instant::now());
        (self.emit)("fetching", json!(true));
        let result = repo.fetch(true);
        (self.emit)("fetched", match result {
            Ok(fetched) => json!({ "ok": true, "fetched": fetched, "auto": true }),
            Err(e) => json!({ "ok": false, "error": e, "auto": true }),
        });
    }

    /// 요청 하나를 처리한다. 결과는 화면에 JSON 으로 돌아간다.
    pub fn handle(self: &std::sync::Arc<Self>, cmd: &str, args: Value, effects: &mut Vec<SideEffect>) -> Result<Value> {
        match cmd {
            "init" => {
                let last = self.settings.lock().unwrap().last_repo.clone();
                // 마지막 저장소를 다시 연다. 지워졌으면 시작 화면.
                let repo = last.and_then(|p| self.open_repo(Path::new(&p), effects).ok());
                Ok(json!({ "settings": self.settings_json(), "repo": repo, "platform": std::env::consts::OS }))
            }
            "openRepo" => {
                let a: PathArg = parse(args)?;
                self.open_repo(Path::new(&a.path), effects)
            }
            "getSettings" => Ok(self.settings_json()),
            "closeTab" => {
                let a: PathArg = parse(args)?;
                let mut settings = self.settings.lock().unwrap();
                settings.close_tab(&a.path);
                self.save_settings(&settings);
                drop(settings);
                Ok(self.settings_json())
            }
            "clone" => {
                let a = Args(&args);
                let dest = PathBuf::from(a.s("dest")?);
                let repo = remote::clone(&self.runner, a.s("url")?, &dest)?;
                if let Some(parent) = dest.parent() {
                    let mut settings = self.settings.lock().unwrap();
                    settings.clone_dir = parent.display().to_string();
                    self.save_settings(&settings);
                }
                self.open_repo(repo.root(), effects)
            }
            "cloneName" => Ok(json!(remote::default_clone_name(Args(&args).s("url")?))),
            "testConnection" => {
                let url = match Args(&args).s("url").ok().filter(|u| !u.trim().is_empty()) {
                    Some(url) => url.to_string(),
                    None => self.repo()?.default_remote_url().ok_or_else(|| GitError::new("열린 저장소에 원격이 없습니다. 시험할 주소를 적어 주세요."))?,
                };
                let dir = self.repo().map(|r| r.root().to_path_buf()).unwrap_or_else(|_| dirs::home_dir().unwrap_or_else(std::env::temp_dir));
                remote::test_connection(&self.runner, &dir, &url).map(|count| json!({ "url": url, "branches": count }))
            }
            "exportKeychain" => {
                let dir = Settings::default_path().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(std::env::temp_dir);
                remote::export_mac_keychain(&dir).map(|p| json!(p.display().to_string()))
            }
            "loginTarget" => {
                let url = self.repo()?.default_remote_url();
                Ok(json!(url.as_deref().and_then(login::parse_url)))
            }
            "remoteLogin" => {
                let a = Args(&args);
                let host = a.s("host")?.trim().to_string();
                let password = a.s("password")?.to_string();
                if host.is_empty() || password.is_empty() {
                    return Err(GitError::new("서버와 비밀번호를 적어 주세요."));
                }
                if a.s("kind")? == "ssh" {
                    *self.ssh_login.lock().unwrap() = Some((host, password));
                    self.apply_globals();
                    Ok(Value::Null)
                } else {
                    let user = a.s("user")?.trim();
                    if user.is_empty() {
                        return Err(GitError::new("사용자 이름을 적어 주세요."));
                    }
                    let dir = self.repo().map(|r| r.root().to_path_buf()).unwrap_or_else(|_| std::env::temp_dir());
                    let protocol = a.s("protocol").unwrap_or("https");
                    login::save_https(&self.runner, &dir, protocol, &host, user, &password).map(|_| Value::Null).map_err(GitError::new)
                }
            }
            "forgetSshLogin" => {
                *self.ssh_login.lock().unwrap() = None;
                self.apply_globals();
                Ok(Value::Null)
            }
            "gitVersion" => {
                let dir = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
                let out = self.runner.run(&dir, &["--version"]);
                if out.success() { Ok(json!(out.stdout.trim())) } else { Err(GitError::new(out.message())) }
            }
            "closeRepo" => {
                *self.repo.lock().unwrap() = None;
                *self.watcher.lock().unwrap() = None;
                let mut settings = self.settings.lock().unwrap();
                settings.last_repo = None;
                self.save_settings(&settings);
                effects.push(SideEffect::Title("GitVcs".into()));
                Ok(Value::Null)
            }
            "removeRecent" => {
                let a: PathArg = parse(args)?;
                let mut settings = self.settings.lock().unwrap();
                settings.remove_recent(&a.path);
                self.save_settings(&settings);
                drop(settings);
                Ok(self.settings_json())
            }
            "setSettings" => {
                let a: SettingsArg = parse(args)?;
                let mut settings = self.settings.lock().unwrap();
                if let Some(theme) = a.theme {
                    settings.theme = if theme == "light" { "light".into() } else { "dark".into() };
                }
                if let Some(mode) = a.pull_mode {
                    settings.pull_mode = mode;
                }
                if let Some(layout) = a.diff_layout {
                    settings.diff_layout = if layout == "split" { "split".into() } else { "inline".into() };
                }
                if let Some(minutes) = a.auto_fetch_minutes {
                    settings.auto_fetch_minutes = minutes.min(24 * 60);
                }
                if let Some(ssl) = a.ssl {
                    settings.ssl = ssl;
                }
                if let Some(git_path) = a.git_path {
                    settings.git_path = git_path.trim().to_string();
                }
                self.save_settings(&settings);
                drop(settings);
                self.apply_globals();
                Ok(self.settings_json())
            }
            "status" => to_json(self.repo()?.status()?),
            "history" => to_json(self.repo()?.history(HISTORY_PAGE)?),
            "commitDetail" => {
                let a: HashArg = parse(args)?;
                to_json(self.repo()?.commit_detail(&a.hash)?)
            }
            "lastMessage" => Ok(json!(self.repo()?.last_message()?)),
            "diff" => {
                let a: DiffArg = parse(args)?;
                to_json(self.repo()?.diff(&a.target)?)
            }
            "reveal" => {
                let a: PathArg = parse(args)?;
                reveal(&self.repo()?, &a.path).map(|_| Value::Null)
            }
            "lastFetch" => Ok(json!(self.repo()?.last_fetch().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()))),
            "refs" => to_json(self.repo()?.refs()?),
            "conflict" => to_json(self.repo()?.conflict(Args(&args).s("path")?)?),
            "continueBlocker" => Ok(json!(self.repo()?.continue_blocker()?)),
            "resolve" | "saveResolution" | "continueOperation" | "skipOperation" | "abortOperation" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                let a = Args(&args);
                match cmd {
                    "resolve" => {
                        let side: Side = serde_json::from_value(args.get("side").cloned().unwrap_or_default())
                            .map_err(|_| GitError::new("고를 쪽이 잘못되었습니다."))?;
                        repo.resolve(a.s("path")?, side).map(|_| Value::Null)
                    }
                    "saveResolution" => repo.save_resolution(a.s("path")?, a.s("text")?).map(|_| Value::Null),
                    "continueOperation" => repo.continue_operation().map(|t| json!(t.trim())),
                    "skipOperation" => repo.skip_operation().map(|t| json!(t.trim())),
                    _ => repo.abort_operation().map(|_| Value::Null),
                }
            }
            "openTerminal" => open_terminal(self.repo()?.root()).map(|_| Value::Null),
            "checkout" | "checkoutDetached" | "createBranch" | "renameBranch" | "deleteBranch" | "deleteRemoteBranch" | "merge" | "rebase"
            | "cherryPick" | "revert" | "reset" | "createTag" | "deleteTag" | "pushTag" | "stashPush" | "stashApply" | "stashDrop" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                let a = Args(&args);
                let done = |r: Result<()>| r.map(|_| Value::Null);
                let text = |r: Result<String>| r.map(|t| json!(t.trim()));
                match cmd {
                    "checkout" => done(repo.checkout(a.s("name")?, a.b("remote"))),
                    "checkoutDetached" => done(repo.checkout_detached(a.s("hash")?)),
                    "createBranch" => done(repo.create_branch(a.s("name")?, a.s("start")?, a.b("checkout"))),
                    "renameBranch" => done(repo.rename_branch(a.s("old")?, a.s("new")?)),
                    "deleteBranch" => done(repo.delete_branch(a.s("name")?, a.b("force"))),
                    "deleteRemoteBranch" => done(repo.delete_remote_branch(a.s("remote")?, a.s("branch")?)),
                    "merge" => text(repo.merge(a.s("revision")?)),
                    "rebase" => text(repo.rebase(a.s("revision")?)),
                    "cherryPick" => text(repo.cherry_pick(a.s("hash")?, a.b("merge"))),
                    "revert" => text(repo.revert(a.s("hash")?, a.b("merge"))),
                    "reset" => {
                        let mode: ResetMode = serde_json::from_value(args.get("mode").cloned().unwrap_or_default())
                            .map_err(|_| GitError::new("reset 방식이 잘못되었습니다."))?;
                        done(repo.reset(a.s("hash")?, mode))
                    }
                    "createTag" => done(repo.create_tag(a.s("name")?, a.s("hash")?, a.s("message").unwrap_or(""))),
                    "deleteTag" => done(repo.delete_tag(a.s("name")?)),
                    "pushTag" => done(repo.push_tag(a.s("remote")?, a.s("name")?)),
                    "stashPush" => done(repo.stash_push(a.s("message").unwrap_or(""))),
                    "stashApply" => text(repo.stash_apply(a.s("name")?, a.b("pop"))),
                    _ => done(repo.stash_drop(a.s("name")?)),
                }
            }
            "stage" | "unstage" | "stageAll" | "unstageAll" | "commit" | "push" | "applyLines" | "discard" | "fetch" | "pull" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                match cmd {
                    "stage" => repo.stage(&parse::<PathsArg>(args)?.paths).map(|_| Value::Null),
                    "unstage" => repo.unstage(&parse::<PathsArg>(args)?.paths).map(|_| Value::Null),
                    "stageAll" => repo.stage_all().map(|_| Value::Null),
                    "unstageAll" => repo.unstage_all().map(|_| Value::Null),
                    "discard" => repo.discard(&parse::<PathsArg>(args)?.paths).map(|_| Value::Null),
                    "applyLines" => {
                        let a: LinesArg = parse(args)?;
                        repo.apply_lines(a.action, &a.path, a.untracked, &a.fingerprint, &a.lines).map(|_| Value::Null)
                    }
                    "commit" => {
                        let a: CommitArg = parse(args)?;
                        repo.commit(&a.message, a.amend).map(|hash| json!(hash))
                    }
                    "fetch" => repo.fetch(false).map(|fetched| json!(fetched)),
                    "pull" => {
                        let mode = self.settings.lock().unwrap().pull_mode;
                        repo.pull(mode).map(|msg| json!(msg))
                    }
                    _ => repo.push().map(|msg| json!(msg)),
                }
            }
            _ => Err(GitError::new(format!("모르는 요청: {cmd}"))),
        }
    }

    fn settings_json(&self) -> Value {
        let s = self.settings.lock().unwrap();
        let ssh = self.ssh_login.lock().unwrap().as_ref().map(|(host, _)| host.clone());
        let tabs: Vec<Value> = s
            .open_tabs
            .iter()
            .filter(|p| Path::new(p).is_dir())
            .map(|p| json!({ "path": p, "name": Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone()) }))
            .collect();
        json!({
            "theme": s.theme,
            "recent": s.recent,
            "pullMode": s.pull_mode,
            "diffLayout": s.diff_layout,
            "autoFetchMinutes": s.auto_fetch_minutes,
            "ssl": s.ssl,
            "gitPath": s.git_path,
            "cloneDir": if s.clone_dir.is_empty() { dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default() } else { s.clone_dir.clone() },
            "openTabs": tabs,
            "sshLogin": ssh,
            "platform": std::env::consts::OS,
        })
    }
}

fn repo_info(repo: &Repository) -> Value {
    json!({
        "path": repo.root().display().to_string(),
        "name": repo.name(),
        "identity": repo.identity(),
        "remotes": repo.remotes().unwrap_or_default(),
    })
}

/// 설정으로 모든 git 호출에 붙일 것을 만든다.
pub fn globals_for(settings: &Settings) -> GitGlobals {
    GitGlobals {
        git_path: (!settings.git_path.trim().is_empty()).then(|| PathBuf::from(settings.git_path.trim())),
        config_args: ssl::build_arguments(&settings.ssl, cfg!(windows)),
        env: Default::default(),
    }
}

/// 파일 관리자(Finder·탐색기)에서 그 파일을 골라 보인다.
fn reveal(repo: &Repository, path: &str) -> Result<()> {
    let relative = Path::new(path);
    if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(GitError::new("저장소 밖의 경로입니다."));
    }
    let full = repo.root().join(relative);
    // 지운 파일이면 그 폴더를 연다.
    let target = if full.exists() { full } else { full.parent().map(Path::to_path_buf).unwrap_or_else(|| repo.root().to_path_buf()) };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").arg("-R").arg(&target).spawn();
    #[cfg(windows)]
    let spawned = std::process::Command::new("explorer").arg(format!("/select,{}", target.display())).spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("xdg-open").arg(target.parent().unwrap_or(&target)).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(format!("파일 관리자를 열지 못했습니다: {e}")))
}

/// 저장소 폴더에서 터미널을 연다.
fn open_terminal(root: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").args(["-a", "Terminal"]).arg(root).spawn();
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // Windows Terminal 이 있으면 그것, 없으면 cmd.
        std::process::Command::new("wt").arg("-d").arg(root).spawn().or_else(|_| {
            std::process::Command::new("cmd").args(["/C", "start", "cmd", "/K"]).arg(format!("cd /d \"{}\"", root.display())).creation_flags(0x0800_0000).spawn()
        })
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("x-terminal-emulator").current_dir(root).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(format!("터미널을 열지 못했습니다: {e}")))
}

/// 요청 인자 읽기.
struct Args<'a>(&'a Value);

impl Args<'_> {
    fn s(&self, key: &str) -> Result<&str> {
        self.0.get(key).and_then(Value::as_str).ok_or_else(|| GitError::new(format!("요청 인자 '{key}' 가 없습니다.")))
    }

    fn b(&self, key: &str) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(false)
    }
}

/// 임시 폴더 이름을 사용자마다 나누려고 쓴다.
fn whoami() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "user".into())
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn parse<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T> {
    serde_json::from_value(args).map_err(|e| GitError::new(format!("요청 인자가 잘못되었습니다: {e}")))
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| GitError::new(e.to_string()))
}

#[derive(Deserialize)]
struct PathArg {
    path: String,
}

#[derive(Deserialize)]
struct PathsArg {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct HashArg {
    hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsArg {
    theme: Option<String>,
    pull_mode: Option<PullMode>,
    diff_layout: Option<String>,
    auto_fetch_minutes: Option<u32>,
    ssl: Option<gitvcs_core::ssl::SslSettings>,
    git_path: Option<String>,
}

#[derive(Deserialize)]
struct DiffArg {
    target: DiffTarget,
}

#[derive(Deserialize)]
struct LinesArg {
    action: LineAction,
    path: String,
    #[serde(default)]
    untracked: bool,
    fingerprint: String,
    lines: Vec<usize>,
}

#[derive(Deserialize)]
struct CommitArg {
    message: String,
    #[serde(default)]
    amend: bool,
}
