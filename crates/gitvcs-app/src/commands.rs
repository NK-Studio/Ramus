//! 화면이 보낸 요청을 git 작업으로 바꾼다. 작업 스레드에서 불린다 — 화면 스레드를 막지 않는다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gitvcs_core::conflict::Side;
use gitvcs_core::refs::ResetMode;
use gitvcs_core::repo::{DiffTarget, LineAction, PullMode, Result};
use gitvcs_core::avatar::{self, Avatar, AvatarCache};
use gitvcs_core::github;
use gitvcs_core::ops::MergeMode;
use gitvcs_core::rewrite::RewriteKind;
use gitvcs_core::undo::{self, Journal, UndoEntry, UndoKind};
use gitvcs_core::{GitError, GitGlobals, GitRunner, Repository, Settings, login, newrepo, remote, ssl};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::watcher;

/// 처음 읽는 커밋 수. 그래프 끝에 닿으면 화면이 더 달라고 한다.
const HISTORY_PAGE: usize = 5000;

/// 화면에 요청 없이 알리는 함수(이벤트 이름, 내용).
pub type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;

pub struct AppState {
    pub runner: GitRunner,
    pub settings: Mutex<Settings>,
    settings_path: Option<PathBuf>,
    repo: Mutex<Option<Repository>>,
    /// 레포지토리를 바꾸는 작업(Stage·커밋·네트워크)은 한 번에 하나만. 읽기는 함께 돌아도 된다.
    write_lock: Mutex<()>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// 마지막 자동 페치 시도(실패해도). 실패한 페치를 30초마다 되풀이하지 않게.
    last_auto_fetch: Mutex<Option<Instant>>,
    /// 앱에서 로그인한 SSH 서버와 비밀번호. 앱을 끌 때까지만 기억한다(파일에 쓰지 않는다).
    ssh_login: Mutex<Option<(String, String)>>,
    avatars: AvatarCache,
    /// 열린 레포지토리의 원격이 GitHub 면 (소유자, 레포지토리). 작성자 사진을 GitHub 에 묻는다.
    github_remote: Mutex<Option<(String, String)>>,
    /// 레포지토리마다 실행 취소 기록(앱을 끌 때까지).
    journals: Mutex<std::collections::HashMap<String, Journal>>,
    /// 앱으로 로그인한 GitHub 계정 (login, token). None 이면 아직 레포지토리에서 읽지 않았다, Some(None) 이면 없다.
    github_login: Mutex<Option<Option<(String, String)>>>,
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
            avatars: AvatarCache::new(AvatarCache::default_dir()),
            github_remote: Mutex::new(None),
            journals: Mutex::new(Default::default()),
            github_login: Mutex::new(None),
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
        if let Some(token) = self.github_git_token() {
            globals.env.extend(github::token_environment(&token));
        }
        self.runner.set_globals(globals);
    }

    /// 앱 로그인 계정 (login, token). 처음 한 번 자격 증명 저장소에서 읽는다.
    fn app_login(&self) -> Option<(String, String)> {
        let mut cached = self.github_login.lock().unwrap();
        if cached.is_none() {
            let dir = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
            *cached = Some(github::load_app_token(&GitRunner::new(globals_for(&self.settings.lock().unwrap())), &dir));
        }
        cached.clone().flatten()
    }

    /// 이 레포지토리에 고른 GitHub 계정 {source, login}.
    fn github_choice(&self) -> Option<(String, String)> {
        let root = self.repo.lock().unwrap().as_ref().map(|r| r.root().display().to_string())?;
        let settings = self.settings.lock().unwrap();
        let v = settings.ui.get(&format!("github.account:{root}"))?;
        Some((v.get("source")?.as_str()?.to_string(), v.get("login")?.as_str()?.to_string()))
    }

    /// git 이 github.com 에 쓸 토큰: 이 레포지토리에 앱·gh 계정을 골랐을 때만(아니면 사용자의 자격 증명 도우미 그대로).
    fn github_git_token(&self) -> Option<String> {
        match self.github_choice()? {
            (source, _) if source == "app" => self.app_login().map(|(_, t)| t),
            (source, login) if source == "gh" => github::gh_token(&login),
            _ => None,
        }
    }

    /// API 에 쓸 토큰: 고른 계정 → 앱 로그인 → gh → 자격 증명 도우미.
    fn github_api_token(&self) -> Option<(String, String)> {
        let dir = self.repo().map(|r| r.root().to_path_buf()).unwrap_or_else(|_| std::env::temp_dir());
        match self.github_choice() {
            Some((source, _)) if source == "app" => return self.app_login(),
            Some((source, login)) if source == "gh" => return github::gh_token(&login).map(|t| (login, t)),
            Some((_, login)) => return github::credential_account(&self.runner, &dir, Some(&login)),
            None => {}
        }
        self.app_login()
            .or_else(|| github::gh_accounts().into_iter().find_map(|l| github::gh_token(&l).map(|t| (l, t))))
            .or_else(|| github::credential_account(&self.runner, &dir, None))
    }

    /// git 사용자 이름(라이선스의 저작권자). 모르면 빈 글.
    fn user_name(&self) -> String {
        let dir = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        self.runner.run(&dir, &["config", "--get", "user.name"]).stdout.trim().to_string()
    }

    /// GitHub 에 레포지토리를 만든다(POST /user/repos 또는 /orgs/{org}/repos).
    /// .gitignore·라이선스를 고르면 GitHub 이 첫 커밋(README·.gitignore·LICENSE)을 만든다(auto_init) — 그 기본 브랜치가 고른 이름과
    /// 다르면 이름을 바꾼다(POST /repos/{o}/{r}/branches/{b}/rename). 고른 것이 없으면 빈 레포지토리로 두고, clone 한 쪽이 HEAD 를 고른 브랜치로 둔다.
    /// "Copyright (C) [year] [name]" 은 GitHub 틀이 아니라 만든 뒤 LICENSE 파일을 올린다(PUT contents).
    fn github_create_repo(&self, args: &Value) -> Result<Value> {
        let a = Args(args);
        let (login, token) = self.app_login().ok_or_else(|| GitError::new("GitHub 에 로그인해 주세요."))?;
        let name = a.s("name")?.trim();
        if name.is_empty() {
            return Err(GitError::new("레포지토리 이름을 적어 주세요."));
        }
        let branch = newrepo::branch_name(&self.runner, a.s("branch").unwrap_or(""))?;
        if a.b("lfs") && !newrepo::lfs_available(&self.runner) {
            return Err(newrepo::lfs_missing());
        }
        let gitignore = a.s("gitignore").unwrap_or("");
        let license = a.s("license").unwrap_or("");
        let copyright = license == newrepo::COPYRIGHT_KEY;
        let auto_init = !gitignore.is_empty() || !license.is_empty();
        let mut body = json!({
            "name": name,
            "description": a.s("description").unwrap_or("").trim(),
            "private": a.b("private"),
            "auto_init": auto_init,
        });
        if !gitignore.is_empty() {
            body["gitignore_template"] = json!(gitignore);
        }
        if !license.is_empty() && !copyright {
            body["license_template"] = json!(license);
        }
        let owner = a.s("owner").unwrap_or("").trim();
        let path = if owner.is_empty() || owner.eq_ignore_ascii_case(&login) { "/user/repos".to_string() } else { format!("/orgs/{owner}/repos") };
        let created = github::api("POST", &path, Some(&body), Some(&token)).map_err(|e| {
            let scope_hint = e.message.starts_with("GitHub 403") || e.message.starts_with("GitHub 404") || e.message.contains("scope");
            if scope_hint {
                GitError::new(format!("{}\n\n로그인 권한(repo · read:org)이 모자라거나 조직이 이 앱의 접근을 막았을 수 있습니다. 레포지토리 만들기 창에서 다시 로그인해 보세요.", e.message))
            } else {
                e
            }
        })?;
        let full_name = created.get("full_name").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut default_branch = created.get("default_branch").and_then(Value::as_str).unwrap_or(newrepo::DEFAULT_BRANCH).to_string();
        let mut warnings = Vec::new();
        if auto_init && default_branch != branch {
            // 첫 커밋이 막 만들어지는 중이면 브랜치가 아직 없을 수 있다 — 잠깐씩 기다리며 몇 번 더.
            let rename = format!("/repos/{full_name}/branches/{default_branch}/rename");
            let mut result = Err(GitError::new(""));
            for attempt in 0..5 {
                if attempt > 0 {
                    std::thread::sleep(Duration::from_millis(800));
                }
                result = github::api("POST", &rename, Some(&json!({ "new_name": branch })), Some(&token));
                if result.is_ok() {
                    break;
                }
            }
            match result {
                Ok(_) => default_branch = branch.clone(),
                Err(e) => warnings.push(format!("기본 브랜치 이름을 {branch} 로 바꾸지 못했습니다({default_branch} 로 남음): {}", e.message)),
            }
        }
        if copyright {
            let text = newrepo::license_body(newrepo::COPYRIGHT_KEY, newrepo::current_year(), &self.user_name(), None)?;
            let put = json!({ "message": "Add LICENSE", "content": base64(text.as_bytes()), "branch": default_branch });
            if let Err(e) = github::api("PUT", &format!("/repos/{full_name}/contents/LICENSE"), Some(&put), Some(&token)) {
                warnings.push(format!("LICENSE 를 올리지 못했습니다: {}", e.message));
            }
        }
        Ok(json!({
            "fullName": full_name,
            "name": created.get("name"),
            "cloneUrl": created.get("clone_url"),
            "htmlUrl": created.get("html_url"),
            "defaultBranch": default_branch,
            "empty": !auto_init,
            "warning": (!warnings.is_empty()).then(|| warnings.join("\n")),
        }))
    }

    fn repo(&self) -> Result<Repository> {
        self.repo.lock().unwrap().clone().ok_or_else(|| GitError::new("열린 레포지토리가 없습니다."))
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
        *self.github_remote.lock().unwrap() = repo.default_remote_url().as_deref().and_then(avatar::parse_github_remote);
        effects.push(SideEffect::Title(format!("{} — GitVcs", repo.name())));
        self.start_watching(&repo);
        *self.repo.lock().unwrap() = Some(repo);
        *self.last_auto_fetch.lock().unwrap() = None;
        self.apply_globals();
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
                // 마지막 레포지토리를 다시 연다. 지워졌으면 시작 화면.
                let repo = last.and_then(|p| self.open_repo(Path::new(&p), effects).ok());
                Ok(json!({ "settings": self.settings_json(), "repo": repo, "platform": std::env::consts::OS, "version": env!("CARGO_PKG_VERSION") }))
            }
            "openRepo" => {
                let a: PathArg = parse(args)?;
                self.open_repo(Path::new(&a.path), effects)
            }
            // ── 레포지토리 만들기 창(원본에 없음 · 확장) ──
            "newRepoTemplates" => {
                let token = self.app_login().map(|(_, t)| t);
                to_json(newrepo::templates(token.as_deref()))
            }
            "newRepoPath" => to_json(newrepo::path_state(Path::new(Args(&args).s("path")?))),
            "createLocalRepo" => {
                let a = Args(&args);
                let path = PathBuf::from(a.s("path")?.trim());
                let token = self.app_login().map(|(_, t)| t);
                let request = newrepo::LocalRepo {
                    branch: a.s("branch").unwrap_or("").to_string(),
                    gitignore: match a.s("gitignore").unwrap_or("") {
                        "" => None,
                        name => Some(newrepo::gitignore_body(name, token.as_deref())?),
                    },
                    license: match a.s("license").unwrap_or("") {
                        "" => None,
                        key => Some(newrepo::license_body(key, newrepo::current_year(), &self.user_name(), token.as_deref())?),
                    },
                    lfs: a.b("lfs"),
                    allow_existing: a.b("allowExisting"),
                };
                let outcome = newrepo::create_local(&self.runner, &path, &request)?;
                let mut info = self.open_repo(&path, effects)?;
                info["warning"] = json!(outcome.warning);
                Ok(info)
            }
            "githubCreateInfo" => {
                let Some((login, token)) = self.app_login() else { return Ok(json!({ "signedIn": false })) };
                let user = github::api("GET", "/user", None, Some(&token))?;
                let orgs = github::api("GET", "/user/orgs?per_page=100", None, Some(&token)).unwrap_or(json!([]));
                let orgs: Vec<Value> = orgs
                    .as_array()
                    .map(|list| list.iter().map(|o| json!({ "login": o.get("login"), "avatarUrl": o.get("avatar_url") })).collect())
                    .unwrap_or_default();
                let missing = github::token_scopes(&token).map(|granted| github::missing_scopes(&granted, &github::CREATE_SCOPES)).unwrap_or_default();
                Ok(json!({ "signedIn": true, "login": login, "avatarUrl": user.get("avatar_url"), "orgs": orgs, "missingScopes": missing }))
            }
            "githubCreateRepo" => self.github_create_repo(&args),
            "githubCloneNew" => {
                let a = Args(&args);
                let (login, token) = self.app_login().ok_or_else(|| GitError::new("GitHub 에 로그인해 주세요."))?;
                let dest = PathBuf::from(a.s("dest")?.trim());
                if a.b("lfs") && !newrepo::lfs_available(&self.runner) {
                    return Err(newrepo::lfs_missing());
                }
                // 비공개 레포지토리도 받게 앱 로그인 토큰을 이번 clone 에만 붙인다(설정 파일·주소에는 남기지 않는다).
                let mut globals = self.runner.globals();
                globals.env.extend(github::token_environment(&token));
                let repo = remote::clone(&GitRunner::new(globals), a.s("url")?, &dest)?;
                if a.b("empty") {
                    // 빈 레포지토리: 첫 푸시가 고른 기본 브랜치를 만들게 HEAD 를 돌려 둔다(GitHub 은 처음 받은 브랜치를 기본으로 삼는다).
                    let branch = newrepo::branch_name(&self.runner, a.s("branch").unwrap_or(""))?;
                    let out = self.runner.run(repo.root(), &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")]);
                    if !out.success() {
                        return Err(GitError::new(out.message()));
                    }
                }
                if a.b("lfs") {
                    newrepo::lfs_install(&self.runner, repo.root())?;
                }
                let root = repo.root().display().to_string();
                {
                    let mut settings = self.settings.lock().unwrap();
                    // 이 레포지토리는 만든 계정(앱 로그인)으로 푸시·풀 한다.
                    settings.ui.insert(format!("github.account:{root}"), json!({ "source": "app", "login": login }));
                    if let Some(parent) = dest.parent() {
                        settings.clone_dir = parent.display().to_string();
                    }
                    self.save_settings(&settings);
                }
                self.open_repo(repo.root(), effects)
            }
            "getSettings" => Ok(self.settings_json()),
            "setUi" => {
                let a = Args(&args);
                let key = a.s("key")?.to_string();
                let value = args.get("value").cloned().unwrap_or(Value::Null);
                let mut settings = self.settings.lock().unwrap();
                if value.is_null() {
                    settings.ui.remove(&key);
                } else {
                    settings.ui.insert(key, value);
                }
                self.save_settings(&settings);
                Ok(Value::Null)
            }
            "avatar" => {
                let a = Args(&args);
                let github = self.github_remote.lock().unwrap().clone();
                let token = github.as_ref().and_then(|_| self.app_login()).map(|(_, t)| t);
                Ok(match self.avatars.get(a.s("email")?, a.s("hash").unwrap_or(""), github.as_ref(), token.as_deref()) {
                    Avatar::Image(bytes) => json!({ "url": format!("data:{};base64,{}", image_mime(&bytes), base64(&bytes)) }),
                    Avatar::Ai(ai) => json!({ "ai": ai.key() }),
                    Avatar::None => Value::Null,
                })
            }
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
                    None => self.repo()?.default_remote_url().ok_or_else(|| GitError::new("열린 레포지토리에 원격이 없습니다. 시험할 주소를 적어 주세요."))?,
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
            "setWatch" => {
                let on = Args(&args).b("on");
                match (on, self.repo()) {
                    (true, Ok(repo)) => self.start_watching(&repo),
                    _ => *self.watcher.lock().unwrap() = None,
                }
                Ok(Value::Null)
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
                    settings.theme = match theme.as_str() {
                        "light" | "system" => theme,
                        _ => "dark".into(),
                    };
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
            "snapshot" => {
                let max = args.get("maxCount").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(HISTORY_PAGE).clamp(1, 1_000_000);
                let repo = self.repo()?;
                let mut value = to_json(repo.snapshot(max)?)?;
                value["undo"] = self.undo_titles(&repo);
                value["template"] = json!(repo.commit_template());
                value["mergeMessage"] = json!(repo.merge_message());
                value["mergeConflicts"] = json!(repo.merge_conflicts());
                Ok(value)
            }
            "commitDetail" => {
                let a: HashArg = parse(args)?;
                to_json(self.repo()?.commit_detail(&a.hash)?)
            }
            "lastMessage" => Ok(json!(self.repo()?.last_message()?)),
            "diff" => {
                let a: DiffArg = parse(args)?;
                let repo = self.repo()?;
                let doc = repo.diff_with(&a.target, a.options.clone())?;
                let mut value = to_json(&doc)?;
                if doc.binary {
                    value["sizes"] = to_json(repo.blob_sizes(&a.target))?;
                }
                // 받지 않은 LFS 파일: 포인터 글만 바뀌었다.
                value["lfsPointer"] = json!(doc.lines.iter().any(|l| gitvcs_core::files::is_lfs_pointer(&l.text)));
                Ok(value)
            }
            "fileBytes" => {
                let a = Args(&args);
                let bytes = self.repo()?.file_bytes(a.s("revision").unwrap_or(""), a.s("path")?)?;
                if bytes.len() > 64 * 1024 * 1024 {
                    return Err(GitError::new("파일이 너무 커서 열지 않습니다(64MB 넘음)."));
                }
                Ok(json!({ "base64": base64(&bytes), "mime": image_mime(&bytes), "size": bytes.len() }))
            }
            "externalDiff" => {
                let a = Args(&args);
                self.repo()?.external_diff(a.s("from")?, a.s("to").ok(), a.s("path")?, a.s("tool").ok()).map(|_| Value::Null)
            }
            "fileLog" => {
                let a = Args(&args);
                let max = args.get("maxCount").and_then(Value::as_u64).unwrap_or(300) as usize;
                to_json(self.repo()?.file_log(a.s("path")?, max)?)
            }
            "blame" => {
                let a = Args(&args);
                to_json(self.repo()?.blame(a.s("path")?, a.s("revision").ok())?)
            }
            "compareFiles" => {
                let a = Args(&args);
                to_json(self.repo()?.compare_files(a.s("from")?, a.s("to").ok(), a.b("range"))?)
            }
            "githubDeviceStart" => github::device_start(),
            "githubDevicePoll" => match github::device_poll(Args(&args).s("deviceCode")?)? {
                github::Poll::Pending => Ok(json!({ "status": "pending" })),
                github::Poll::SlowDown => Ok(json!({ "status": "slowDown" })),
                github::Poll::Token(token) => {
                    let user = github::api("GET", "/user", None, Some(&token))?;
                    let login = user.get("login").and_then(Value::as_str).unwrap_or_default().to_string();
                    let dir = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
                    github::store_app_token(&self.runner, &dir, &login, &token);
                    *self.github_login.lock().unwrap() = Some(Some((login.clone(), token)));
                    self.apply_globals();
                    Ok(json!({ "status": "done", "login": login, "avatarUrl": user.get("avatar_url") }))
                }
            },
            "githubStatus" => Ok(json!({ "signedIn": self.app_login().is_some(), "login": self.app_login().map(|(l, _)| l) })),
            "githubLogout" => {
                if let Some((login, _)) = self.app_login() {
                    github::forget_app_token(&self.runner, &dirs::home_dir().unwrap_or_else(std::env::temp_dir), &login);
                }
                *self.github_login.lock().unwrap() = Some(None);
                self.apply_globals();
                Ok(Value::Null)
            }
            "githubAccounts" => {
                let repo_ids = self.github_remote.lock().unwrap().clone();
                let dir = self.repo().map(|r| r.root().to_path_buf()).unwrap_or_else(|_| std::env::temp_dir());
                let choice = self.github_choice();
                let mut list: Vec<(String, String, Option<String>)> = Vec::new();
                if let Some((login, token)) = self.app_login() {
                    list.push((login, "app".into(), Some(token)));
                }
                for login in github::gh_accounts() {
                    let token = github::gh_token(&login);
                    list.push((login, "gh".into(), token));
                }
                if let Some((login, token)) = github::credential_account(&self.runner, &dir, None)
                    && !list.iter().any(|(l, s, _)| l.eq_ignore_ascii_case(&login) && s != "app")
                    && login != "x-access-token"
                {
                    list.push((login, "credential".into(), Some(token)));
                }
                let accounts: Vec<github::Account> = list
                    .into_iter()
                    .map(|(login, source, token)| {
                        let current = choice.as_ref().is_some_and(|(s, l)| *s == source && (source == "app" || l.eq_ignore_ascii_case(&login)));
                        (login, source, token, current)
                    })
                    .map(|(login, source, token, current)| github::Account {
                        in_use: current || (choice.is_none() && source == "credential"),
                        current,
                        can_access: match (&repo_ids, token) {
                            (Some((o, r)), Some(t)) => Some(github::can_access(o, r, &t)),
                            _ => None,
                        },
                        login,
                        source,
                    })
                    .collect();
                to_json(accounts)
            }
            "githubChoose" => {
                let a = Args(&args);
                let root = self.repo()?.root().display().to_string();
                let mut settings = self.settings.lock().unwrap();
                // 고른 계정이 없으면(source 가 비면) git 기본(자격 증명 도우미)으로 돌아간다.
                let key = format!("github.account:{root}");
                match a.s("source").unwrap_or("") {
                    "" => {
                        settings.ui.remove(&key);
                    }
                    source => {
                        settings.ui.insert(key, json!({ "source": source, "login": a.s("login").unwrap_or("") }));
                    }
                }
                self.save_settings(&settings);
                drop(settings);
                self.apply_globals();
                Ok(Value::Null)
            }
            "githubRepo" => {
                let ids = self.github_remote.lock().unwrap().clone();
                let me = self.github_api_token().map(|(login, _)| login);
                Ok(json!({ "owner": ids.as_ref().map(|i| i.0.clone()), "repo": ids.as_ref().map(|i| i.1.clone()), "me": me, "signedIn": self.app_login().is_some() }))
            }
            "githubApi" => {
                let a = Args(&args);
                let token = self.github_api_token().map(|(_, t)| t);
                github::api(a.s("method").unwrap_or("GET"), a.s("path")?, args.get("body").filter(|b| !b.is_null()), token.as_deref())
            }
            "githubGraphql" => {
                let token = self.github_api_token().map(|(_, t)| t).ok_or_else(|| GitError::new("GitHub 에 로그인해 주세요."))?;
                github::graphql(Args(&args).s("query")?, args.get("variables").cloned().unwrap_or(json!({})), &token)
            }
            "openUrl" => {
                let a = Args(&args);
                let url = a.s("url")?;
                if !url.starts_with("https://") {
                    return Err(GitError::new("https 주소만 엽니다."));
                }
                open_url(url).map(|_| Value::Null)
            }
            "explorerHistory" => {
                let q: gitvcs_core::history::ExplorerQuery = parse(args)?;
                to_json(self.repo()?.explorer_history(&q)?)
            }
            "workspace" => to_json(self.repo()?.workspace(Args(&args).b("ignored"))?),
            "treeFiles" => to_json(self.repo()?.tree_files(Args(&args).s("revision")?)?),
            "readText" => to_json(self.repo()?.read_text(Args(&args).s("path")?)?),
            "writeText" => {
                let a = Args(&args);
                let original: gitvcs_core::history::TextFile = serde_json::from_value(args.get("original").cloned().unwrap_or_default())
                    .map_err(|_| GitError::new("파일 정보가 잘못되었습니다."))?;
                // 방금 쓴 판(줄 끝 목록·수정 시각)을 돌려준다. 다음 저장은 이 판과 견준다.
                to_json(self.repo()?.write_text_file(a.s("path")?, a.s("text")?, &original, a.b("force"))?)
            }
            "createFile" => {
                let repo = self.repo()?;
                let a = Args(&args);
                let path = a.s("path")?;
                let full = repo.root().join(path);
                if full.exists() {
                    return Err(GitError::new(format!("이미 있는 파일입니다: {path}")));
                }
                if let Some(dir) = full.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| GitError::new(e.to_string()))?;
                }
                std::fs::write(&full, "").map(|_| Value::Null).map_err(|e| GitError::new(format!("파일을 만들지 못했습니다: {e}")))
            }
            "stageWarnings" => to_json(self.repo()?.stage_warnings(&parse::<PathsArg>(args)?.paths)),
            "openInEditor" => {
                let a = Args(&args);
                let repo = self.repo()?;
                let full = repo.root().join(a.s("path")?);
                let line = args.get("line").and_then(Value::as_u64).unwrap_or(1).max(1);
                open_in_editor(a.s("editor").unwrap_or(""), &full, line).map(|_| Value::Null)
            }
            "openDefault" => {
                let repo = self.repo()?;
                open_path(&repo.root().join(Args(&args).s("path")?)).map(|_| Value::Null)
            }
            "createPatch" => {
                let a = Args(&args);
                let paths = parse::<PathsArg>(args.clone())?.paths;
                let patch = self.repo()?.create_patch(&paths, a.b("staged"))?;
                std::fs::write(a.s("dest")?, patch).map(|_| Value::Null).map_err(|e| GitError::new(format!("패치를 쓰지 못했습니다: {e}")))
            }
            "saveFileVersion" => {
                let a = Args(&args);
                let bytes = self.repo()?.file_bytes(a.s("revision")?, a.s("path")?)?;
                std::fs::write(a.s("dest")?, bytes).map(|_| Value::Null).map_err(|e| GitError::new(format!("파일을 쓰지 못했습니다: {e}")))
            }
            // 서브모듈 편집 드로어의 "현재 리비전": 그 커밋의 시각·메시지(받지 않았으면 null).
            "submoduleInfo" => {
                let info = self.repo()?.submodule_revision(Args(&args).s("path")?);
                Ok(info.map_or(Value::Null, |(date, message)| json!({ "date": date, "message": message })))
            }
            // 드로어가 고른 폴더가 비었는지 본다(워크트리·서브모듈 경로 검사). 상대 경로는 레포지토리 기준.
            "pathInfo" => {
                let a = Args(&args);
                let path = Path::new(a.s("path")?);
                let full = if path.is_absolute() { path.to_path_buf() } else { self.repo()?.root().join(path) };
                let dir = full.is_dir();
                let empty = !dir || std::fs::read_dir(&full).map(|mut d| d.next().is_none()).unwrap_or(true);
                Ok(json!({ "exists": full.exists(), "dir": dir, "empty": empty }))
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
                    "saveResolution" => repo.save_resolution_with(a.s("path")?, a.s("text")?, a.b("force")).map(|_| Value::Null),
                    "continueOperation" => repo.continue_with_message(a.s("message").ok()).map(|t| json!(t.trim())),
                    "skipOperation" => repo.skip_operation().map(|t| json!(t.trim())),
                    _ => repo.abort_operation().map(|_| Value::Null),
                }
            }
            "openTerminal" => match Args(&args).s("path") {
                Ok(path) => open_terminal(Path::new(path)).map(|_| Value::Null),
                Err(_) => open_terminal(self.repo()?.root()).map(|_| Value::Null),
            },
            "openFolder" => open_folder(Path::new(Args(&args).s("path")?)).map(|_| Value::Null),
            "savePatch" => {
                let a = Args(&args);
                self.repo()?.save_patch(a.s("hash")?, a.s("path")?).map(|_| Value::Null)
            }
            "rewrite" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                let a = Args(&args);
                let kind: RewriteKind = serde_json::from_value(args.get("kind").cloned().unwrap_or_default())
                    .map_err(|_| GitError::new("고치기 방식이 잘못되었습니다."))?;
                let hash = a.s("hash")?;
                let before = repo.undo_snapshot();
                let label = match kind {
                    RewriteKind::Reword => "Reword",
                    RewriteKind::Squash => "Squash",
                    RewriteKind::Fixup => "Fixup",
                    RewriteKind::Drop => "Drop",
                };
                let r = repo.rewrite(kind, hash, a.s("message").ok()).map(|h| json!(h));
                self.recorded(&repo, r, &before, |b, after| {
                    let mut e = UndoEntry::new(UndoKind::MoveHead, format!("{label} {}", &hash[..7.min(hash.len())]));
                    e.head_before = b.head.clone();
                    e.head_after = after.head.clone();
                    if kind != RewriteKind::Drop {
                        e.reset_mode = "--soft".into();
                    }
                    (b.head != after.head).then_some(e)
                })
            }
            "undo" | "redo" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                let mut journals = self.journals.lock().unwrap();
                let journal = journals.entry(repo.root().display().to_string()).or_default();
                let title = if cmd == "undo" { undo::undo(&repo, journal) } else { undo::redo(&repo, journal) };
                title.map(|t| json!(t))
            }
            "checkout" | "checkoutDetached" | "createBranch" | "renameBranch" | "deleteBranch" | "deleteRemoteBranch" | "merge" | "rebase"
            | "cherryPick" | "revert" | "reset" | "createTag" | "deleteTag" | "pushTag" | "deleteRemoteTag" | "stashPush" | "stashApply"
            | "stashDrop" | "stashBranch" | "addRemote" | "renameRemote" | "setRemoteUrl" | "removeRemote" | "pruneRemote" | "fetchRemote"
            | "pushBranch" | "setUpstream" | "fastForward" | "addWorktree" | "removeWorktree" | "addSubmodule" | "updateSubmodules"
            | "editSubmodule" | "removeSubmodule" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                let a = Args(&args);
                let done = |r: Result<()>| r.map(|_| Value::Null);
                let text = |r: Result<String>| r.map(|t| json!(t.trim()));
                let before = repo.undo_snapshot();
                let short = |h: &str| h.chars().take(7).collect::<String>();
                let name_or_hash = |s: &undo::Snapshot| if s.branch.is_empty() { short(&s.head) } else { s.branch.clone() };
                match cmd {
                    "checkout" | "checkoutDetached" => {
                        let r = if cmd == "checkout" { repo.checkout(a.s("name")?, a.b("remote")) } else { repo.checkout_detached(a.s("hash")?) };
                        self.recorded(&repo, done(r), &before, |b, after| {
                            let mut e = UndoEntry::new(UndoKind::Switch, format!("{} → {} 전환", name_or_hash(b), name_or_hash(after)));
                            e.head_before = b.head.clone();
                            e.head_after = after.head.clone();
                            e.branch_before = b.branch.clone();
                            e.branch_after = after.branch.clone();
                            Some(e)
                        })
                    }
                    "createBranch" => {
                        let (name, start, switch) = (a.s("name")?, a.s("start")?, a.b("checkout"));
                        let r = repo.create_branch(name, start, switch);
                        self.recorded(&repo, done(r), &before, |b, _| {
                            let mut e = UndoEntry::new(UndoKind::CreateBranch, format!("브랜치 '{name}' 만들기"));
                            e.head_before = b.head.clone();
                            e.branch_before = b.branch.clone();
                            e.name = name.to_string();
                            e.hash = repo.branch_tip(name);
                            e.switched = switch;
                            Some(e)
                        })
                    }
                    "renameBranch" => done(repo.rename_branch(a.s("old")?, a.s("new")?)),
                    "deleteBranch" => {
                        let name = a.s("name")?;
                        let tip = repo.branch_tip(name);
                        let r = repo.delete_branch(name, a.b("force"));
                        self.recorded(&repo, done(r), &before, |_, _| {
                            let mut e = UndoEntry::new(UndoKind::DeleteBranch, format!("브랜치 '{name}' 삭제"));
                            e.name = name.to_string();
                            e.hash = tip.clone();
                            (!tip.is_empty()).then_some(e)
                        })
                    }
                    "deleteRemoteBranch" => done(repo.delete_remote_branch(a.s("remote")?, a.s("branch")?)),
                    "merge" | "rebase" | "cherryPick" | "revert" | "reset" => {
                        let (r, title, mode) = match cmd {
                            "merge" => {
                                let revision = a.s("revision")?;
                                let mode: MergeMode = serde_json::from_value(args.get("mode").cloned().unwrap_or(json!("default"))).unwrap_or_default();
                                let r = if mode == MergeMode::Default { repo.merge(revision) } else { repo.merge_with(revision, mode) };
                                (text(r), format!("병합 '{revision}'"), String::new())
                            }
                            "rebase" => {
                                let stop = args.get("stopOnConflict").and_then(Value::as_bool).unwrap_or(true);
                                (text(repo.rebase_with(a.s("revision")?, stop)), format!("Rebase → '{}'", a.s("revision")?), String::new())
                            }
                            "cherryPick" => (text(repo.cherry_pick(a.s("hash")?, a.b("merge"))), format!("Cherry-pick {}", short(a.s("hash")?)), String::new()),
                            "revert" => (text(repo.revert(a.s("hash")?, a.b("merge"))), format!("Revert {}", short(a.s("hash")?)), String::new()),
                            _ => {
                                let mode: ResetMode = serde_json::from_value(args.get("mode").cloned().unwrap_or_default())
                                    .map_err(|_| GitError::new("reset 방식이 잘못되었습니다."))?;
                                let flag = match mode {
                                    ResetMode::Soft => "--soft",
                                    ResetMode::Mixed => "--mixed",
                                    ResetMode::Hard => "--hard",
                                };
                                (done(repo.reset(a.s("hash")?, mode)), format!("Reset {} → {}", &flag[2..], short(a.s("hash")?)), flag.to_string())
                            }
                        };
                        self.recorded(&repo, r, &before, |b, after| {
                            if after.head == b.head {
                                return None;
                            }
                            let mut e = UndoEntry::new(UndoKind::MoveHead, title.clone());
                            e.head_before = b.head.clone();
                            e.head_after = after.head.clone();
                            e.reset_mode = mode.clone();
                            Some(e)
                        })
                    }
                    "createTag" => done(repo.create_tag(a.s("name")?, a.s("hash")?, a.s("message").unwrap_or(""))),
                    "deleteTag" => done(repo.delete_tag(a.s("name")?)),
                    "pushTag" => done(repo.push_tag(a.s("remote")?, a.s("name")?)),
                    "deleteRemoteTag" => done(repo.delete_remote_tag(a.s("remote")?, a.s("name")?)),
                    "stashPush" => {
                        let r = repo.stash_push(a.s("message").unwrap_or(""));
                        self.recorded_any(&repo, done(r), &before, |b, after| {
                            let mut e = UndoEntry::new(UndoKind::Stash, "Stash");
                            e.hash = after.stash.clone();
                            (!after.stash.is_empty() && after.stash != b.stash).then_some(e)
                        })
                    }
                    "stashApply" => text(repo.stash_apply(a.s("name")?, a.b("pop"))),
                    "stashBranch" => done(repo.stash_branch(a.s("branch")?, a.s("name")?)),
                    "addRemote" => done(repo.add_remote(a.s("name")?, a.s("url")?, a.s("pushUrl").unwrap_or(""))),
                    "renameRemote" => done(repo.rename_remote(a.s("old")?, a.s("new")?)),
                    "setRemoteUrl" => done(repo.set_remote_url(a.s("name")?, a.s("url")?, a.s("pushUrl").unwrap_or(""))),
                    "removeRemote" => done(repo.remove_remote(a.s("name")?)),
                    "pruneRemote" => text(repo.prune_remote(a.s("name")?)),
                    "fetchRemote" => done(repo.fetch_remote(a.s("name")?)),
                    "pushBranch" => text(repo.push_branch(a.s("branch")?, a.s("remote")?, a.b("setUpstream"), a.b("force"))),
                    "setUpstream" => done(repo.set_upstream(a.s("branch")?, a.s("upstream").ok())),
                    "fastForward" => done(repo.fast_forward(a.s("branch")?, a.b("current"))),
                    "addWorktree" => done(repo.add_worktree(a.s("path")?, a.s("reference")?, a.s("newBranch").ok())),
                    "removeWorktree" => done(repo.remove_worktree(a.s("path")?, a.b("force"))),
                    "addSubmodule" => done(repo.add_submodule(a.s("url")?, a.s("path")?, a.s("branch").ok())),
                    "updateSubmodules" => done(repo.update_submodules(a.s("path").ok())),
                    "editSubmodule" => done(repo.edit_submodule(a.s("path")?, a.s("url")?, a.s("branch").ok())),
                    "removeSubmodule" => done(repo.remove_submodule(a.s("path")?)),
                    _ => done(repo.stash_drop(a.s("name")?)),
                }
            }
            "stage" | "unstage" | "stageAll" | "unstageAll" | "commit" | "push" | "applyLines" | "discard" | "fetch" | "pull" | "ignore" | "lfsTrack"
            | "lfsPull" | "stashPaths" | "deletePath" | "restoreFile" => {
                let repo = self.repo()?;
                let _guard = self.write_lock.lock().unwrap();
                let before = repo.undo_snapshot();
                match cmd {
                    "stage" => repo.stage(&parse::<PathsArg>(args)?.paths).map(|_| Value::Null),
                    "unstage" => repo.unstage(&parse::<PathsArg>(args)?.paths).map(|_| Value::Null),
                    "stageAll" => repo.stage_all().map(|_| Value::Null),
                    "unstageAll" => repo.unstage_all().map(|_| Value::Null),
                    // worktreeOnly: Unstaged 목록의 버리기 — Stage 한 내용은 남긴다. 아니면 HEAD 상태로(Stage 한 것까지).
                    "discard" => {
                        let worktree_only = Args(&args).b("worktreeOnly");
                        let paths = parse::<PathsArg>(args)?.paths;
                        if worktree_only { repo.discard_worktree(&paths) } else { repo.discard(&paths) }.map(|_| Value::Null)
                    }
                    "applyLines" => {
                        let a: LinesArg = parse(args)?;
                        repo.apply_lines_with(a.action, &a.path, a.untracked, &a.fingerprint, &a.lines, a.context.unwrap_or(3)).map(|_| Value::Null)
                    }
                    "ignore" | "lfsTrack" => {
                        let a = Args(&args);
                        let kind: gitvcs_core::files::PatternKind = serde_json::from_value(args.get("kind").cloned().unwrap_or_default())
                            .map_err(|_| GitError::new("무시 방식이 잘못되었습니다."))?;
                        let r = if cmd == "ignore" { repo.ignore(a.s("path")?, kind) } else { repo.lfs_track(a.s("path")?, kind) };
                        r.map(|p| json!(p))
                    }
                    "lfsPull" => repo.lfs_pull(Args(&args).s("path")?).map(|_| Value::Null),
                    "stashPaths" => {
                        let message = Args(&args).s("message").unwrap_or("").to_string();
                        let paths = parse::<PathsArg>(args)?.paths;
                        let r = repo.stash_paths(&paths, &message).map(|_| Value::Null);
                        self.recorded_any(&repo, r, &before, |b, after| {
                            let mut e = UndoEntry::new(UndoKind::Stash, if message.is_empty() { "Stash (고른 파일)".to_string() } else { message.clone() });
                            e.hash = after.stash.clone();
                            e.paths = paths.clone();
                            (!after.stash.is_empty() && after.stash != b.stash).then_some(e)
                        })
                    }
                    "deletePath" => repo.delete_path(Args(&args).s("path")?).map(|_| Value::Null),
                    "restoreFile" => repo.restore_file(Args(&args).s("revision")?, Args(&args).s("path")?).map(|_| Value::Null),
                    "commit" => {
                        let a: CommitArg = parse(args)?;
                        let subject = a.message.lines().next().unwrap_or_default().to_string();
                        let r = repo.commit(&a.message, a.amend).map(|hash| json!(hash));
                        self.recorded(&repo, r, &before, |b, after| {
                            let title = if a.amend { format!("커밋 고쳐 쓰기 '{subject}'") } else { format!("커밋 '{subject}'") };
                            let mut e = UndoEntry::new(UndoKind::Commit, title);
                            e.head_before = b.head.clone();
                            e.head_after = after.head.clone();
                            Some(e)
                        })
                    }
                    "fetch" => repo.fetch(false).map(|fetched| json!(fetched)),
                    "pull" => {
                        let mode = args
                            .get("mode")
                            .and_then(|m| serde_json::from_value::<PullMode>(m.clone()).ok())
                            .unwrap_or_else(|| self.settings.lock().unwrap().pull_mode);
                        let r = repo.pull(mode).map(|msg| json!(msg));
                        self.recorded(&repo, r, &before, |b, after| {
                            if after.head == b.head {
                                return None;
                            }
                            let mut e = UndoEntry::new(UndoKind::Pull, format!("Pull {} → {}", &b.head[..7.min(b.head.len())], &after.head[..7.min(after.head.len())]));
                            e.head_before = b.head.clone();
                            e.head_after = after.head.clone();
                            Some(e)
                        })
                    }
                    _ => repo.push_to(Args(&args).s("remote").ok()).map(|msg| json!(msg)),
                }
            }
            _ => Err(GitError::new(format!("모르는 요청: {cmd}"))),
        }
    }

    /// 작업이 성공했고 그 전에 커밋이 있었으면 실행 취소 기록을 남긴다.
    fn recorded(
        &self,
        repo: &Repository,
        result: Result<Value>,
        before: &undo::Snapshot,
        make: impl FnOnce(&undo::Snapshot, &undo::Snapshot) -> Option<UndoEntry>,
    ) -> Result<Value> {
        if result.is_ok() && !before.head.is_empty() {
            self.recorded_any(repo, Ok(Value::Null), before, make)?;
        }
        result
    }

    /// 성공했으면 기록한다(커밋이 없어도 — stash 등).
    fn recorded_any(
        &self,
        repo: &Repository,
        result: Result<Value>,
        before: &undo::Snapshot,
        make: impl FnOnce(&undo::Snapshot, &undo::Snapshot) -> Option<UndoEntry>,
    ) -> Result<Value> {
        if result.is_ok() {
            let after = repo.undo_snapshot();
            if let Some(entry) = make(before, &after) {
                self.journals.lock().unwrap().entry(repo.root().display().to_string()).or_default().record(entry);
            }
        }
        result
    }

    /// 실행 취소·다시 실행 버튼에 보일 이름.
    fn undo_titles(&self, repo: &Repository) -> Value {
        let journals = self.journals.lock().unwrap();
        let (undo, redo) = journals.get(&repo.root().display().to_string()).map(|j| j.titles()).unwrap_or((None, None));
        json!({ "undo": undo, "redo": redo })
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
            "ui": s.ui,
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
        "superproject": repo.superproject(),
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
        return Err(GitError::new("레포지토리 밖의 경로입니다."));
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

/// 주소를 기본 브라우저로 연다.
fn open_url(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").arg(url).spawn();
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).creation_flags(0x0800_0000).spawn()
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(format!("브라우저를 열지 못했습니다: {e}")))
}

/// 파일을 OS 기본 프로그램으로 연다.
fn open_path(path: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").arg(path).spawn();
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").args(["/C", "start", ""]).arg(path).creation_flags(0x0800_0000).spawn()
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("xdg-open").arg(path).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(format!("파일을 열지 못했습니다: {e}")))
}

/// 외부 편집기로 그 줄을 연다. `template` 은 "code -g {file}:{line}" 꼴. 비우면 VS Code 가 있으면 그것, 없으면 기본 프로그램.
fn open_in_editor(template: &str, file: &Path, line: u64) -> Result<()> {
    // 앱으로 실행하면 PATH 가 짧아 Homebrew·VS Code 명령을 못 찾는다 — 흔한 자리를 더한다.
    let mut path = std::env::var("PATH").unwrap_or_default();
    for extra in ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin"] {
        if !path.split(':').any(|p| p == extra) {
            path.push(':');
            path.push_str(extra);
        }
    }
    let template = if template.trim().is_empty() { "code -g {file}:{line}" } else { template.trim() };
    let file_text = file.display().to_string();
    let words: Vec<String> = template.split_whitespace().map(|w| w.replace("{file}", &file_text).replace("{line}", &line.to_string())).collect();
    let mut cmd = std::process::Command::new(&words[0]);
    cmd.args(&words[1..]).env("PATH", path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.spawn() {
        Ok(_) => Ok(()),
        // 편집기를 못 찾으면 기본 프로그램으로 연다.
        Err(_) => open_path(file),
    }
}

/// 폴더를 파일 관리자(Finder·탐색기)로 연다.
fn open_folder(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Err(GitError::new(format!("폴더가 없습니다: {}", path.display())));
    }
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").arg(path).spawn();
    #[cfg(windows)]
    let spawned = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("xdg-open").arg(path).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(format!("파일 관리자를 열지 못했습니다: {e}")))
}

/// 레포지토리 폴더에서 터미널을 연다.
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

/// 그림 바이트의 형식(앞 몇 바이트로).
fn image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

/// 표준 base64(작은 그림을 data: 주소로 넘길 때만 쓴다).
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
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
    #[serde(default)]
    options: gitvcs_core::repo::DiffOptions,
}

#[derive(Deserialize)]
struct LinesArg {
    action: LineAction,
    path: String,
    #[serde(default)]
    untracked: bool,
    fingerprint: String,
    lines: Vec<usize>,
    #[serde(default)]
    context: Option<u32>,
}

#[derive(Deserialize)]
struct CommitArg {
    message: String,
    #[serde(default)]
    amend: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
    }
}
