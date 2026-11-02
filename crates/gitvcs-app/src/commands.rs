//! 화면이 보낸 요청을 git 작업으로 바꾼다. 작업 스레드에서 불린다 — 화면 스레드를 막지 않는다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use gitvcs_core::repo::Result;
use gitvcs_core::{GitError, GitGlobals, GitRunner, Repository, Settings, ssl};
use serde::Deserialize;
use serde_json::{Value, json};

/// 한 번에 읽는 커밋 수.
const HISTORY_PAGE: usize = 2000;

pub struct AppState {
    pub runner: GitRunner,
    pub settings: Mutex<Settings>,
    settings_path: Option<PathBuf>,
    repo: Mutex<Option<Repository>>,
    /// 저장소를 바꾸는 작업(Stage·커밋·푸시)은 한 번에 하나만. 읽기는 함께 돌아도 된다.
    write_lock: Mutex<()>,
}

/// 화면에 알릴 일. 응답 말고도 창 제목 같은 것을 바꿔야 할 때.
pub enum SideEffect {
    Title(String),
}

impl AppState {
    pub fn load() -> AppState {
        let settings_path = std::env::var_os("GITVCS_SETTINGS").map(PathBuf::from).or_else(Settings::default_path);
        let settings = settings_path.as_deref().map(Settings::load).unwrap_or_default();
        let runner = GitRunner::new(globals_for(&settings));
        AppState { runner, settings: Mutex::new(settings), settings_path, repo: Mutex::new(None), write_lock: Mutex::new(()) }
    }

    fn save_settings(&self, settings: &Settings) {
        if let Some(path) = &self.settings_path
            && let Err(e) = settings.save(path)
        {
            eprintln!("설정을 저장하지 못했습니다: {e}");
        }
    }

    fn repo(&self) -> Result<Repository> {
        self.repo.lock().unwrap().clone().ok_or_else(|| GitError::new("열린 저장소가 없습니다."))
    }

    fn open_repo(&self, path: &Path, effects: &mut Vec<SideEffect>) -> Result<Value> {
        let repo = Repository::open(self.runner.clone(), path)?;
        let root = repo.root().display().to_string();
        {
            let mut settings = self.settings.lock().unwrap();
            settings.touch_recent(&root, &repo.name(), now());
            self.save_settings(&settings);
        }
        let info = repo_info(&repo);
        effects.push(SideEffect::Title(format!("{} — GitVcs", repo.name())));
        *self.repo.lock().unwrap() = Some(repo);
        Ok(info)
    }

    /// 요청 하나를 처리한다. 결과는 화면에 JSON 으로 돌아간다.
    pub fn handle(&self, cmd: &str, args: Value, effects: &mut Vec<SideEffect>) -> Result<Value> {
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
            "closeRepo" => {
                *self.repo.lock().unwrap() = None;
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
            "setTheme" => {
                let a: ThemeArg = parse(args)?;
                let mut settings = self.settings.lock().unwrap();
                settings.theme = if a.theme == "light" { "light".into() } else { "dark".into() };
                self.save_settings(&settings);
                Ok(Value::Null)
            }
            "status" => to_json(self.repo()?.status()?),
            "history" => to_json(self.repo()?.history(HISTORY_PAGE)?),
            "commitDetail" => {
                let a: HashArg = parse(args)?;
                to_json(self.repo()?.commit_detail(&a.hash)?)
            }
            "lastMessage" => Ok(json!(self.repo()?.last_message()?)),
            "stage" | "unstage" | "stageAll" | "unstageAll" | "commit" | "push" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                match cmd {
                    "stage" => repo.stage(&parse::<PathsArg>(args)?.paths).map(|_| Value::Null),
                    "unstage" => repo.unstage(&parse::<PathsArg>(args)?.paths).map(|_| Value::Null),
                    "stageAll" => repo.stage_all().map(|_| Value::Null),
                    "unstageAll" => repo.unstage_all().map(|_| Value::Null),
                    "commit" => {
                        let a: CommitArg = parse(args)?;
                        repo.commit(&a.message, a.amend).map(|hash| json!(hash))
                    }
                    _ => repo.push().map(|msg| json!(msg)),
                }
            }
            _ => Err(GitError::new(format!("모르는 요청: {cmd}"))),
        }
    }

    fn settings_json(&self) -> Value {
        let s = self.settings.lock().unwrap();
        json!({ "theme": s.theme, "recent": s.recent })
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
struct ThemeArg {
    theme: String,
}

#[derive(Deserialize)]
struct CommitArg {
    message: String,
    #[serde(default)]
    amend: bool,
}
