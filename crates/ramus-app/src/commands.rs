//! 화면이 보낸 요청을 git 작업으로 바꾼다. 작업 스레드에서 불린다 — 화면 스레드를 막지 않는다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ramus_core::conflict::Side;
use ramus_core::refs::ResetMode;
use ramus_core::repo::{DiffTarget, LineAction, PullMode, Result};
use ramus_core::avatar::{self, Avatar, AvatarCache};
use ramus_core::sshkey;
use ramus_core::github;
use ramus_core::ops::MergeMode;
use ramus_core::rewrite::RewriteKind;
use ramus_core::undo::{self, Journal, UndoEntry, UndoKind};
use ramus_core::runner::trace;
use ramus_core::i18n::tr;
use ramus_core::{GitError, GitGlobals, GitRunner, Repository, Settings, gitbin, login, markdown, newrepo, remote, ssl, trf};
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
    /// 도는 원격 작업(job 이름 → 종류 clone·fetch·pull·push). 앱을 끌 때 묻고, 끄기 전에 멈춘다.
    jobs: Mutex<std::collections::HashMap<String, &'static str>>,
    emit: Emit,
}

/// 원격 작업 하나가 도는 동안 `AppState::jobs` 에 남는다. 끝나면(성공·실패·취소) 빠진다.
struct JobGuard<'a> {
    jobs: &'a Mutex<std::collections::HashMap<String, &'static str>>,
    job: String,
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        self.jobs.lock().unwrap().remove(&self.job);
    }
}

/// 화면에 알릴 일. 응답 말고도 창 제목 같은 것을 바꿔야 할 때.
pub enum SideEffect {
    Title(String),
}

impl AppState {
    pub fn load(emit: Emit) -> AppState {
        let settings_path = std::env::var_os("RAMUS_SETTINGS").map(PathBuf::from).or_else(Settings::default_path);
        let settings = settings_path.as_deref().map(Settings::load).unwrap_or_default();
        // 글의 언어: 화면과 같은 설정(ui.language). 오류·메뉴 글이 따른다.
        ramus_core::i18n::set_language(settings.ui.get("language").and_then(Value::as_str).unwrap_or("ko"));
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
            jobs: Mutex::new(Default::default()),
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

    fn track_job(&self, job: &str, kind: &'static str) -> JobGuard<'_> {
        self.jobs.lock().unwrap().insert(job.to_string(), kind);
        JobGuard { jobs: &self.jobs, job: job.to_string() }
    }

    /// 지금 도는 원격 작업의 종류들. 비었으면 앱을 바로 꺼도 된다.
    pub fn running_jobs(&self) -> Vec<&'static str> {
        self.jobs.lock().unwrap().values().copied().collect()
    }

    /// 앱을 끄기 전에: Clone·Fetch·Push 는 멈춘다. Pull·브랜치 전환은 파일을 고치는 중일 수 있어 끝날 때까지 둔다.
    pub fn cancel_for_quit(&self) {
        let jobs: Vec<String> = self.jobs.lock().unwrap().iter().filter(|(_, kind)| !touches_files(kind)).map(|(job, _)| job.clone()).collect();
        for job in jobs {
            ramus_core::cancel_job(&job);
        }
    }

    /// 설정·SSH 로그인이 바뀌면 모든 git 호출에 붙는 것을 다시 만든다.
    fn apply_globals(&self) {
        let mut globals = globals_for(&self.settings.lock().unwrap());
        if let Some((host, password)) = self.ssh_login.lock().unwrap().clone() {
            match login::write_askpass(&std::env::temp_dir().join(format!("Ramus-{}", whoami()))) {
                Ok(askpass) => globals.env.extend(login::ssh_environment(&askpass, &host, &password)),
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
        let source = v.get("source")?.as_str()?;
        // GitHub CLI(gh) 연결은 더 이상 쓰지 않는다 — 예전에 gh 계정을 골라 둔 레포지토리는 고른 것이 없는 것처럼 본다.
        if source == "gh" {
            return None;
        }
        Some((source.to_string(), v.get("login")?.as_str()?.to_string()))
    }

    /// git 이 github.com 에 쓸 토큰: 이 레포지토리에 앱 계정을 골랐을 때만(아니면 사용자의 자격 증명 도우미 그대로).
    fn github_git_token(&self) -> Option<String> {
        match self.github_choice()? {
            (source, _) if source == "app" => self.app_login().map(|(_, t)| t),
            _ => None,
        }
    }

    /// API 에 쓸 토큰: 고른 계정 → 앱 로그인 → 자격 증명 도우미.
    fn github_api_token(&self) -> Option<(String, String)> {
        let dir = self.repo().map(|r| r.root().to_path_buf()).unwrap_or_else(|_| std::env::temp_dir());
        match self.github_choice() {
            Some((source, _)) if source == "app" => return self.app_login(),
            Some((_, login)) => return github::credential_account(&self.runner, &dir, Some(&login)),
            None => {}
        }
        self.app_login().or_else(|| github::credential_account(&self.runner, &dir, None))
    }

    /// Clone 창이 고를 수 있는 GitHub 계정 (source, login): 앱 로그인 하나.
    fn clone_accounts(&self) -> Vec<(String, String)> {
        self.app_login().map(|(login, _)| ("app".to_string(), login)).into_iter().collect()
    }

    /// 계정 하나의 (source, login, token). 앱 로그인일 때만.
    fn clone_token(&self, source: &str, _login: &str) -> Option<(String, String, String)> {
        match source {
            "app" => self.app_login().map(|(l, t)| ("app".to_string(), l, t)),
            _ => None,
        }
    }

    /// 목록을 읽을 계정 (source, login): 고른 것(account), 없으면 앱 로그인.
    fn clone_default_account(&self, args: &Value) -> Option<(String, String)> {
        account_arg(args).or_else(|| self.app_login().map(|(login, _)| ("app".to_string(), login)))
    }

    /// Clone 창의 GitHub 목록 한 쪽: 계정(account {source, login}, 없으면 기본 계정)이 볼 수 있는 레포지토리 100개와
    /// 다음 쪽 커서(next, 없으면 끝). 그중 이 PC 에 이미 받아 둔 것은 위치(local)를 붙인다.
    fn github_clone_list(&self, args: &Value) -> Result<Value> {
        let Some((source, login)) = self.clone_default_account(args) else { return Ok(json!({ "signedIn": false })) };
        let (source, login, token) =
            self.clone_token(&source, &login).ok_or_else(|| GitError::new(trf!("{login} 계정의 GitHub 토큰을 읽지 못했습니다. 다시 로그인해 주세요.", "Couldn't read the GitHub token for {login}. Sign in again.")))?;
        let after = args.get("after").and_then(Value::as_str).filter(|a| !a.is_empty());
        let (mut repos, next) = github::viewer_repos_page(&token, after)?;
        self.mark_local_clones(&mut repos);
        Ok(json!({ "signedIn": true, "account": { "source": source, "login": login }, "repos": repos, "next": next }))
    }

    /// 지난번에 다 읽어 둔 목록(디스크). 창을 열자마자 보이고, 화면이 뒤에서 새로 읽어 바꾼다. 없으면 null.
    fn github_clone_cache(&self, args: &Value) -> Result<Value> {
        let Some((source, login)) = self.clone_default_account(args) else { return Ok(json!({ "signedIn": false })) };
        let saved = clone_cache_path(&source, &login)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let Some(mut saved) = saved else { return Ok(json!({ "signedIn": true, "account": { "source": source, "login": login }, "repos": null })) };
        let mut repos: Vec<Value> = saved.get_mut("repos").and_then(|r| r.as_array_mut()).map(std::mem::take).unwrap_or_default();
        // 받아 둔 것은 그사이 바뀌었을 수 있다 — 지금 것으로 다시 붙인다.
        for repo in &mut repos {
            if let Some(map) = repo.as_object_mut() {
                map.remove("local");
            }
        }
        self.mark_local_clones(&mut repos);
        Ok(json!({
            "signedIn": true, "account": { "source": source, "login": login }, "repos": repos,
            // 목록 질의가 바뀐 뒤의 옛 캐시는 읽은 때를 모르는 것으로 돌려 화면이 바로 새로 읽게 한다.
            "truncated": saved.get("truncated"),
            "savedAt": saved.get("savedAt").filter(|_| saved.get("v").and_then(Value::as_u64) == Some(CLONE_CACHE_VERSION)),
        }))
    }

    /// 목록에서 이 PC 에 이미 받아 둔 것에 위치(local)를 붙인다.
    fn mark_local_clones(&self, repos: &mut [Value]) {
        let local = self.local_github_clones();
        for repo in repos {
            let key = repo.get("fullName").and_then(Value::as_str).unwrap_or_default().to_lowercase();
            if let Some(path) = local.get(&key) {
                repo["local"] = json!(path);
            }
        }
    }

    /// 최근 연 레포지토리·열린 탭 가운데 GitHub 원격이 있는 것: "owner/repo"(소문자) → 폴더. 같은 레포지토리면 최근 것이 먼저.
    fn local_github_clones(&self) -> std::collections::HashMap<String, String> {
        let paths: Vec<String> = {
            let settings = self.settings.lock().unwrap();
            settings.recent.iter().map(|r| r.path.clone()).chain(settings.open_tabs.iter().cloned()).collect()
        };
        let mut found = std::collections::HashMap::new();
        for path in paths {
            let dir = Path::new(&path);
            // 보통은 .git/config 를 바로 읽는다(git 을 띄우지 않아 빠르다). .git 이 파일(worktree·서브모듈)이면 git 에 묻는다.
            let config = dir.join(".git").join("config");
            let urls: Vec<String> = if config.is_file() {
                std::fs::read_to_string(&config).map(|text| remote_urls(&text)).unwrap_or_default()
            } else if dir.join(".git").exists() {
                let out = self.runner.run(dir, &["config", "--get-regexp", r"^remote\..*\.url$"]);
                if !out.success() {
                    continue;
                }
                out.stdout.lines().filter_map(|line| line.split_whitespace().nth(1)).map(str::to_string).collect()
            } else {
                continue;
            };
            for url in urls {
                if let Some((owner, repo)) = avatar::parse_github_remote(&url) {
                    found.entry(format!("{owner}/{repo}").to_lowercase()).or_insert_with(|| path.clone());
                }
            }
        }
        found
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
        let (login, token) = self.app_login().ok_or_else(|| GitError::new(tr("GitHub 에 로그인해 주세요.", "Sign in to GitHub.")))?;
        let name = a.s("name")?.trim();
        if name.is_empty() {
            return Err(GitError::new(tr("레포지토리 이름을 적어 주세요.", "Enter a repository name.")));
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
                GitError::new(trf!("{}\n\n로그인 권한(repo · read:org)이 모자라거나 조직이 이 앱의 접근을 막았을 수 있습니다. 레포지토리 만들기 창에서 다시 로그인해 보세요.", "{}\n\nThe sign-in may be missing scopes (repo · read:org), or the organization may block this app. Try signing in again from the Create Repository window.", e.message))
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
                Err(e) => warnings.push(trf!("기본 브랜치 이름을 {branch} 로 바꾸지 못했습니다({default_branch} 로 남음): {}", "Couldn't rename the default branch to {branch} (it stays {default_branch}): {}", e.message)),
            }
        }
        if copyright {
            let text = newrepo::license_body(newrepo::COPYRIGHT_KEY, newrepo::current_year(), &self.user_name(), None)?;
            let put = json!({ "message": "Add LICENSE", "content": base64(text.as_bytes()), "branch": default_branch });
            if let Err(e) = github::api("PUT", &format!("/repos/{full_name}/contents/LICENSE"), Some(&put), Some(&token)) {
                warnings.push(trf!("LICENSE 를 올리지 못했습니다: {}", "Couldn't upload LICENSE: {}", e.message));
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
        self.repo.lock().unwrap().clone().ok_or_else(|| GitError::new(tr("열린 레포지토리가 없습니다.", "No repository is open.")))
    }

    /// `beside`: 새 탭을 둘 자리 — 그 탭 바로 오른쪽(워크트리를 탭으로 열 때). 없으면 맨 끝.
    fn open_repo(self: &std::sync::Arc<Self>, path: &Path, beside: Option<&str>, effects: &mut Vec<SideEffect>) -> Result<Value> {
        let started = Instant::now();
        let repo = Repository::open(self.runner.clone(), path)?;
        let root = repo.root().display().to_string();
        let t = Instant::now();
        {
            let mut settings = self.settings.lock().unwrap();
            settings.touch_recent(&root, &repo.name(), now());
            settings.open_tab(&root, beside);
            self.save_settings(&settings);
        }
        trace("openRepo settings", t);
        let info = repo_info(&repo);
        // 원격이 GitHub 인지는 첫 snapshot 이 참조를 읽으면서 정한다(여기서 status 를 따로 돌리지 않는다).
        *self.github_remote.lock().unwrap() = None;
        effects.push(SideEffect::Title(format!("{} — Ramus", repo.name())));
        let t = Instant::now();
        self.start_watching(&repo);
        trace("openRepo watch", t);
        *self.repo.lock().unwrap() = Some(repo);
        *self.last_auto_fetch.lock().unwrap() = None;
        let t = Instant::now();
        self.apply_globals();
        trace("openRepo globals", t);
        trace("openRepo total", started);
        Ok(info)
    }

    /// 열린 레포지토리의 기본 원격이 GitHub 면 (소유자, 레포지토리) 를 기억한다 — 작성자 사진·PR 목록이 쓴다.
    /// snapshot 이 읽은 참조·원격 목록으로 정하므로 git 을 더 부르지 않는다. 그새 다른 레포지토리로 바뀌었으면 건드리지 않는다.
    fn note_github_remote(&self, repo: &Repository, snap: &ramus_core::repo::Snapshot) {
        let upstream = snap.refs.local.iter().find(|b| b.current).and_then(|b| b.upstream.clone());
        let name = remote::pick_default_remote(upstream.as_deref(), &snap.refs.remotes);
        let url = name.and_then(|n| snap.remotes.iter().find(|r| r.name == n).map(|r| r.fetch_url.clone()));
        let current = self.repo.lock().unwrap();
        if current.as_ref().is_some_and(|r| r.root() == repo.root()) {
            *self.github_remote.lock().unwrap() = url.as_deref().and_then(avatar::parse_github_remote);
        }
    }

    /// 바깥 변경을 감시한다. 알림이 오면 화면이 다시 읽는다(`changed`).
    fn start_watching(self: &std::sync::Arc<Self>, repo: &Repository) {
        let weak = std::sync::Arc::downgrade(self);
        let root = repo.root().display().to_string();
        let watched = watcher::watch(repo.root().to_path_buf(), repo.git_dir().to_path_buf(), move || {
            if let Some(state) = weak.upgrade() {
                // 레포지토리를 바꾼 뒤 늦게 온 이전 감시의 알림은 버린다(감시를 끝내도 모아 둔 알림이 한 번 더 올 수 있다).
                let current = state.repo.lock().unwrap().as_ref().map(|r| r.root().display().to_string());
                if current.as_deref() == Some(root.as_str()) {
                    // 폴더째 사라졌으면(지움·이름 바꿈) 다시 읽으라 하지 않고 사라졌다고 알린다 — 화면이 탭을 거둔다.
                    if state.notice_gone() {
                        return;
                    }
                    (state.emit)("changed", json!({ "repo": root }));
                }
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

    /// 열린 레포지토리의 폴더가 사라졌으면 그 경로. 드라이브를 뺐거나 Finder 에서 지웠거나 이름을 바꾼 경우.
    fn gone_root(&self) -> Option<PathBuf> {
        let repo = self.repo.lock().unwrap();
        repo.as_ref().map(|r| r.root().to_path_buf()).filter(|root| !root.is_dir())
    }

    /// 열린 레포지토리의 폴더가 사라졌으면 화면에 `gone` 을 알리고 true. 감시와 자동 페치는 그 뒤로 조용히 한다.
    pub fn notice_gone(&self) -> bool {
        let Some(root) = self.gone_root() else { return false };
        (self.emit)("gone", json!({ "repo": root.display().to_string() }));
        true
    }

    /// 요청이 실패했는데 그새 레포지토리 폴더가 사라졌다면, 그 실패의 진짜 원인은 폴더다 — `gone` 오류로 바꾼다.
    /// (git 은 작업 폴더가 없으면 "No such file or directory" 로 실행조차 못 한다.)
    pub fn explain_gone(&self, result: Result<Value>) -> Result<Value> {
        match result {
            Err(e) if !e.stale && !e.gone => match self.gone_root() {
                Some(root) => Err(GitError::gone(&root)),
                None => Err(e),
            },
            other => other,
        }
    }

    /// 자동 페치 할 때가 됐으면 한다. 앱이 30초마다 부른다. 다른 작업 중이면 건너뛴다.
    pub fn auto_fetch_tick(&self) {
        let minutes = self.settings.lock().unwrap().auto_fetch_minutes;
        let Ok(repo) = self.repo() else { return };
        // 폴더가 사라진 레포지토리는 페치할 수 없다 — 페치 실패를 띄우는 대신 사라졌다고 알린다.
        if self.notice_gone() {
            return;
        }
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
        // 화면이 보고 있는 레포지토리(__repo)와 열린 레포지토리가 다르면 — 탭을 바꾸는 사이에 보낸 요청 — 실행하지 않는다.
        // 이전 레포지토리에 stage·diff 가 가거나, 늦게 온 결과가 새 탭 아래 그려지는 일을 막는다.
        if let Some(expected) = args.get("__repo").and_then(Value::as_str) {
            let matches = self.repo.lock().unwrap().as_ref().is_some_and(|r| ramus_core::settings::same_path(&r.root().display().to_string(), expected));
            if !matches {
                return Err(GitError::stale());
            }
        }
        match cmd {
            "init" => {
                let last = self.settings.lock().unwrap().last_repo.clone();
                // 마지막 레포지토리를 다시 연다. 지워졌으면 시작 화면.
                let repo = last.and_then(|p| self.open_repo(Path::new(&p), None, effects).ok());
                Ok(json!({ "settings": self.settings_json(), "repo": repo, "platform": std::env::consts::OS, "version": env!("CARGO_PKG_VERSION") }))
            }
            // 정보창(ui/about.js): 앱 버전·빌드 표식(build.rs)·설치된 git·웹뷰 엔진·운영체제.
            "about" => {
                let git = self.runner.run(&std::env::temp_dir(), &["--version"]);
                let git_version = if git.success() { git.stdout.trim().to_string() } else { String::new() };
                Ok(json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "build_hash": env!("RAMUS_GIT_HASH"),
                    "build_date": env!("RAMUS_BUILD_DATE"),
                    "git": git_version,
                    "webview": wry::webview_version().unwrap_or_default(),
                    "platform": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                }))
            }
            "openRepo" => {
                let beside = args.get("beside").and_then(Value::as_str).map(str::to_string);
                let a: PathArg = parse(args)?;
                let mut info = self.open_repo(Path::new(&a.path), beside.as_deref(), effects)?;
                // 탭 목록이 바뀌었다 — 화면이 따로 묻지 않게 함께 돌려준다.
                info["settings"] = self.settings_json();
                Ok(info)
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
                let mut info = self.open_repo(&path, None, effects)?;
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
                let (login, token) = self.app_login().ok_or_else(|| GitError::new(tr("GitHub 에 로그인해 주세요.", "Sign in to GitHub.")))?;
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
                self.open_repo(repo.root(), None, effects)
            }
            "getSettings" => Ok(self.settings_json()),
            "setUi" => {
                let a = Args(&args);
                let key = a.s("key")?.to_string();
                let value = args.get("value").cloned().unwrap_or(Value::Null);
                if key == "language" {
                    ramus_core::i18n::set_language(value.as_str().unwrap_or("ko"));
                }
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
                // account: Clone 창의 GitHub 목록에서 고른 계정 {source, login} — 비공개도 받게 그 계정의 토큰을 이번 clone 에만 붙이고,
                // 받은 레포지토리는 그 계정으로 푸시·풀 한다(githubCloneNew 와 같다).
                let account = match args.get("account").filter(|v| !v.is_null()) {
                    Some(v) => {
                        let source = v.get("source").and_then(Value::as_str).unwrap_or_default();
                        let login = v.get("login").and_then(Value::as_str).unwrap_or_default();
                        Some(self.clone_token(source, login).ok_or_else(|| GitError::new(trf!("{login} 계정의 GitHub 토큰을 읽지 못했습니다. 다시 로그인해 주세요.", "Couldn't read the GitHub token for {login}. Sign in again.")))?)
                    }
                    None => None,
                };
                let url = a.s("url")?;
                // job: 화면이 붙인 작업 이름. 진행 알림에 이 이름이 붙고 cancelJob 으로 멈출 수 있다.
                let job = a.s("job").ok().filter(|j| !j.is_empty()).map(str::to_string);
                let _tracked = job.as_deref().map(|j| self.track_job(j, "clone"));
                // 받기 전에 비어 있던(없던) 폴더만 취소 뒤에 치운다 — 파일이 있던 폴더는 clone 이 애초에 거절한다.
                let was_empty = !dest.exists() || std::fs::read_dir(&dest).map(|mut d| d.next().is_none()).unwrap_or(false);
                let run = || match &account {
                    Some((_, _, token)) => {
                        let mut globals = self.runner.globals();
                        globals.env.extend(github::token_environment(token));
                        remote::clone(&GitRunner::new(globals), url, &dest)
                    }
                    None => remote::clone(&self.runner, url, &dest),
                };
                let repo = match &job {
                    Some(job) => match ramus_core::with_job(job, run) {
                        (Err(_), true) => {
                            // git 이 TERM 을 받아 스스로 지웠으면 없다. 남았으면(Windows 강제 종료 등) 받다 만 것을 치운다.
                            if was_empty && dest.exists() {
                                let _ = std::fs::remove_dir_all(&dest);
                            }
                            return Err(GitError::cancelled(tr("Clone 을 취소했습니다.", "Clone was cancelled.")));
                        }
                        (result, _) => result?,
                    },
                    None => run()?,
                };
                {
                    let mut settings = self.settings.lock().unwrap();
                    if let Some((source, login, _)) = &account {
                        settings.ui.insert(format!("github.account:{}", repo.root().display()), json!({ "source": source, "login": login }));
                    }
                    if let Some(parent) = dest.parent() {
                        settings.clone_dir = parent.display().to_string();
                    }
                    self.save_settings(&settings);
                }
                // upstream: fork 를 받았으면 원본을 upstream 원격으로 붙인다. 못 붙여도 받은 것은 그대로 연다.
                let warning = a.s("upstream").ok().filter(|u| !u.trim().is_empty()).and_then(|url| {
                    let out = self.runner.run(repo.root(), &["remote", "add", "upstream", url.trim()]);
                    (!out.success()).then(|| trf!("원본을 upstream 원격으로 붙이지 못했습니다: {}", "Couldn't add the original as the upstream remote: {}", out.message()))
                });
                // open: false 면 받기만 하고 열지 않는다(뒤에서 받은 것 — 사용자가 다른 레포지토리를 보고 있을 수 있다). 화면이 나중에 연다.
                let mut info = if args.get("open").and_then(Value::as_bool).unwrap_or(true) {
                    self.open_repo(repo.root(), None, effects)?
                } else {
                    let path = repo.root().display().to_string();
                    let name = repo.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
                    json!({ "path": path, "name": name })
                };
                if let Some(warning) = warning {
                    info["warning"] = json!(warning);
                }
                Ok(info)
            }
            "cancelJob" => {
                ramus_core::cancel_job(Args(&args).s("job")?);
                Ok(Value::Null)
            }
            "githubCloneList" => self.github_clone_list(&args),
            "githubCloneAccounts" => {
                let accounts: Vec<Value> = self.clone_accounts().iter().map(|(s, l)| json!({ "source": s, "login": l })).collect();
                Ok(json!({ "accounts": accounts }))
            }
            "githubCloneCache" => self.github_clone_cache(&args),
            "githubCloneCacheSave" => {
                let (source, login) = account_arg(&args).ok_or_else(|| GitError::new(tr("계정이 없습니다.", "There is no account.")))?;
                let repos = args.get("repos").cloned().unwrap_or(json!([]));
                if let Some(path) = clone_cache_path(&source, &login) {
                    if let Some(dir) = path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    // savedAt(유닉스 ms): 화면이 얼마나 지난 목록인지 보고, 금방 읽은 것이면 다시 읽지 않는다.
                    let saved_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                    let _ = std::fs::write(path, json!({ "v": CLONE_CACHE_VERSION, "repos": repos, "truncated": args.get("truncated"), "savedAt": saved_at }).to_string());
                }
                Ok(Value::Null)
            }
            "cloneName" => Ok(json!(remote::default_clone_name(Args(&args).s("url")?))),
            "testConnection" => {
                let url = match Args(&args).s("url").ok().filter(|u| !u.trim().is_empty()) {
                    Some(url) => url.to_string(),
                    None => self.repo()?.default_remote_url().ok_or_else(|| GitError::new(tr("열린 레포지토리에 원격이 없습니다. 시험할 주소를 적어 주세요.", "The open repository has no remote. Enter a URL to test.")))?,
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
                    return Err(GitError::new(tr("서버와 비밀번호를 적어 주세요.", "Enter the server and password.")));
                }
                if a.s("kind")? == "ssh" {
                    *self.ssh_login.lock().unwrap() = Some((host, password));
                    self.apply_globals();
                    Ok(Value::Null)
                } else {
                    let user = a.s("user")?.trim();
                    if user.is_empty() {
                        return Err(GitError::new(tr("사용자 이름을 적어 주세요.", "Enter a user name.")));
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
            "gitInfo" => Ok(git_info(&self.settings.lock().unwrap())),
            "checkGit" => {
                let a = Args(&args);
                let path = a.s("path")?;
                gitbin::version(Path::new(path.trim()), &Default::default()).map(|v| json!(v)).map_err(GitError::new)
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
                effects.push(SideEffect::Title("Ramus".into()));
                Ok(Value::Null)
            }
            // 최근 목록의 레포지토리 폴더를 휴지통으로 옮긴다(시작 화면 ⋮ 메뉴를 Option/Shift 로 연 "휴지통으로 이동").
            // 최근 목록에 있는 git 레포지토리 폴더만 받는다 — 화면이 아무 경로나 넘겨 지우는 일이 없게. 옮긴 뒤 목록과 탭에서도 뺀다.
            "trashRepo" => {
                let a: PathArg = parse(args)?;
                let path = PathBuf::from(&a.path);
                let listed = self.settings.lock().unwrap().recent.iter().any(|r| ramus_core::settings::same_path(&r.path, &a.path));
                if !listed {
                    return Err(GitError::new(trf!("최근 목록에 없는 폴더는 지우지 않습니다: {}", "Folders that aren't in the recent list aren't deleted: {}", a.path)));
                }
                if !path.is_dir() {
                    return Err(GitError::gone(&path));
                }
                if !path.join(".git").exists() {
                    return Err(GitError::new(trf!("git 레포지토리 폴더가 아니라 지우지 않았습니다: {}", "Not deleted because it isn't a git repository folder: {}", a.path)));
                }
                // 열려 있으면 먼저 닫는다(감시가 사라진 폴더를 붙들지 않게).
                let open_here = self.repo.lock().unwrap().as_ref().is_some_and(|r| ramus_core::settings::same_path(&r.root().display().to_string(), &a.path));
                if open_here {
                    *self.repo.lock().unwrap() = None;
                    *self.watcher.lock().unwrap() = None;
                    effects.push(SideEffect::Title("Ramus".into()));
                }
                move_to_trash(&path)?;
                let mut settings = self.settings.lock().unwrap();
                settings.remove_recent(&a.path);
                settings.close_tab(&a.path);
                self.save_settings(&settings);
                drop(settings);
                Ok(self.settings_json())
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
                if let Some(mode) = a.git_mode {
                    settings.git_mode = match mode.as_str() {
                        "system" | "custom" => mode,
                        _ => "bundled".into(),
                    };
                }
                if let Some(key) = a.ssh_key {
                    let key = key.trim().to_string();
                    if !key.is_empty() && !Path::new(&key).is_file() {
                        return Err(GitError::new(tr("고른 SSH 키 파일이 없습니다.", "The selected SSH key file doesn't exist.")));
                    }
                    settings.ssh_key = key;
                }
                // 직접 지정은 실제로 git 이 도는지 보고 나서 저장한다(잘못 고른 파일로 앱이 못 쓰게 되지 않게).
                if settings.git_mode == "custom"
                    && let Err(e) = gitbin::version(Path::new(&settings.git_path), &Default::default())
                {
                    return Err(GitError::new(trf!("지정한 git 을 쓸 수 없습니다: {e}", "Can't use the specified git: {e}")));
                }
                self.save_settings(&settings);
                drop(settings);
                self.apply_globals();
                Ok(self.settings_json())
            }
            "status" => to_json(self.repo()?.status()?),
            "snapshot" => {
                let started = Instant::now();
                let max = args.get("maxCount").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(HISTORY_PAGE).clamp(1, 1_000_000);
                let repo = self.repo()?;
                let snap = repo.snapshot(max)?;
                trace("snapshot git+graph", started);
                self.note_github_remote(&repo, &snap);
                let json_started = Instant::now();
                let mut value = to_json(snap)?;
                value["undo"] = self.undo_titles(&repo);
                value["mergeMessage"] = json!(repo.merge_message());
                value["mergeConflicts"] = json!(repo.merge_conflicts());
                trace("snapshot to_json+extras", json_started);
                trace("snapshot total", started);
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
                value["lfsPointer"] = json!(doc.lines.iter().any(|l| ramus_core::files::is_lfs_pointer(&l.text)));
                Ok(value)
            }
            "fileBytes" => {
                let a = Args(&args);
                let bytes = self.repo()?.file_bytes(a.s("revision").unwrap_or(""), a.s("path")?)?;
                if bytes.len() > 64 * 1024 * 1024 {
                    return Err(GitError::new(tr("파일이 너무 커서 열지 않습니다(64MB 넘음).", "The file is too large to open (over 64 MB).")));
                }
                let size = bytes.len();
                // TIFF 는 WebView 가 못 그린다(Windows WebView2 는 아예 모른다) — PNG 로 바꿔 넘긴다.
                let bytes = tiff_to_png(&bytes).unwrap_or(bytes);
                Ok(json!({ "base64": base64(&bytes), "mime": image_mime(&bytes), "size": size }))
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
                    .map(|(login, source, token, current)| {
                        let profile = token.as_deref().and_then(github::profile);
                        github::Account {
                            in_use: current || (choice.is_none() && source == "credential"),
                            current,
                            can_access: match (&repo_ids, token) {
                                (Some((o, r)), Some(t)) => Some(github::can_access(o, r, &t)),
                                _ => None,
                            },
                            name: profile.as_ref().and_then(|p| p.name.clone()),
                            avatar_url: profile.and_then(|p| p.avatar_url),
                            login,
                            source,
                        }
                    })
                    .collect();
                to_json(accounts)
            }
            "sshKeys" => self.ssh_keys(),
            "sshKeyRead" => {
                let a = Args(&args);
                let public = a.s("public").ok().filter(|p| !p.is_empty()).map(PathBuf::from);
                to_json(sshkey::read(Path::new(a.s("path")?), public.as_deref())?)
            }
            "sshKeyGenerate" => {
                let a = Args(&args);
                let title = a.s("title").unwrap_or("").trim().to_string();
                let comment = if title.is_empty() { format!("Ramus ({})", whoami()) } else { title };
                let home = dirs::home_dir().ok_or_else(|| GitError::new(tr("홈 폴더를 찾지 못했습니다.", "Couldn't find the home folder.")))?;
                let key = sshkey::generate(&home, &comment)?;
                let mut value = to_json(&key)?;
                if a.b("upload") {
                    value["uploadError"] = json!(self.upload_ssh_key(&key, &comment).err().map(|e| e.to_string()));
                }
                Ok(value)
            }
            "sshKeyUpload" => {
                let a = Args(&args);
                let public = a.s("public").ok().filter(|p| !p.is_empty()).map(PathBuf::from);
                let key = sshkey::read(Path::new(a.s("path")?), public.as_deref())?;
                let title = if key.comment.is_empty() { format!("Ramus ({})", whoami()) } else { key.comment.clone() };
                self.upload_ssh_key(&key, &title)?;
                Ok(Value::Null)
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
            // 화면에 넣을 HTML 로 바꾼 GitHub 마크다운. 여러 글(설명·코멘트들)을 한 번에 받아 같은 차례로 돌려준다.
            "renderMarkdown" => {
                let texts = args.get("texts").and_then(Value::as_array).ok_or_else(|| GitError::new(tr("요청 인자 'texts' 가 없습니다.", "The request argument 'texts' is missing.")))?;
                Ok(Value::Array(texts.iter().map(|t| json!(markdown::to_html(t.as_str().unwrap_or("")))).collect()))
            }
            "githubGraphql" => {
                let token = self.github_api_token().map(|(_, t)| t).ok_or_else(|| GitError::new(tr("GitHub 에 로그인해 주세요.", "Sign in to GitHub.")))?;
                github::graphql(Args(&args).s("query")?, args.get("variables").cloned().unwrap_or(json!({})), &token)
            }
            "openUrl" => {
                let a = Args(&args);
                let url = a.s("url")?;
                if !url.starts_with("https://") {
                    return Err(GitError::new(tr("https 주소만 엽니다.", "Only https addresses can be opened.")));
                }
                open_url(url).map(|_| Value::Null)
            }
            "explorerHistory" => {
                let q: ramus_core::history::ExplorerQuery = parse(args)?;
                to_json(self.repo()?.explorer_history(&q)?)
            }
            "workspace" => to_json(self.repo()?.workspace(Args(&args).b("ignored"))?),
            "treeFiles" => to_json(self.repo()?.tree_files(Args(&args).s("revision")?)?),
            "readText" => to_json(self.repo()?.read_text(Args(&args).s("path")?)?),
            "writeText" => {
                let a = Args(&args);
                let original: ramus_core::history::TextFile = serde_json::from_value(args.get("original").cloned().unwrap_or_default())
                    .map_err(|_| GitError::new(tr("파일 정보가 잘못되었습니다.", "The file information is invalid.")))?;
                // 방금 쓴 판(줄 끝 목록·수정 시각)을 돌려준다. 다음 저장은 이 판과 견준다.
                to_json(self.repo()?.write_text_file(a.s("path")?, a.s("text")?, &original, a.b("force"))?)
            }
            "createFile" => {
                let repo = self.repo()?;
                let a = Args(&args);
                let path = a.s("path")?;
                let full = repo.root().join(path);
                if full.exists() {
                    return Err(GitError::new(trf!("이미 있는 파일입니다: {path}", "The file already exists: {path}")));
                }
                if let Some(dir) = full.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| GitError::new(e.to_string()))?;
                }
                std::fs::write(&full, "").map(|_| Value::Null).map_err(|e| GitError::new(trf!("파일을 만들지 못했습니다: {e}", "Couldn't create the file: {e}")))
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
                std::fs::write(a.s("dest")?, patch).map(|_| Value::Null).map_err(|e| GitError::new(trf!("패치를 쓰지 못했습니다: {e}", "Couldn't write the patch: {e}")))
            }
            "saveFileVersion" => {
                let a = Args(&args);
                let bytes = self.repo()?.file_bytes(a.s("revision")?, a.s("path")?)?;
                std::fs::write(a.s("dest")?, bytes).map(|_| Value::Null).map_err(|e| GitError::new(trf!("파일을 쓰지 못했습니다: {e}", "Couldn't write the file: {e}")))
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
                            .map_err(|_| GitError::new(tr("고를 쪽이 잘못되었습니다.", "The side to pick is invalid.")))?;
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
                    .map_err(|_| GitError::new(tr("고치기 방식이 잘못되었습니다.", "The edit type is invalid.")))?;
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
                        // 화면이 이름(job)을 붙이면 작업 목록에 보이는 작업이다 — LFS 파일을 서버에서 받느라 오래 걸릴 수 있다.
                        // 파일을 고치는 일이라 취소는 받지 않고, 앱을 끌 때도 끝날 때까지 기다린다(Pull 처럼).
                        let job = args.get("job").and_then(Value::as_str).filter(|j| !j.is_empty()).map(str::to_string);
                        let switch = || if cmd == "checkout" { repo.checkout(a.s("name")?, a.b("remote")) } else { repo.checkout_detached(a.s("hash")?) };
                        let r = match &job {
                            Some(job) => {
                                let _tracked = self.track_job(job, "checkout");
                                ramus_core::with_job(job, switch).0
                            }
                            None => switch(),
                        };
                        self.recorded(&repo, done(r), &before, |b, after| {
                            let mut e = UndoEntry::new(UndoKind::Switch, trf!("{} → {} 전환", "Switch {} → {}", name_or_hash(b), name_or_hash(after)));
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
                            let mut e = UndoEntry::new(UndoKind::CreateBranch, trf!("브랜치 '{name}' 만들기", "Create Branch '{name}'"));
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
                            let mut e = UndoEntry::new(UndoKind::DeleteBranch, trf!("브랜치 '{name}' 삭제", "Delete Branch '{name}'"));
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
                                (text(r), trf!("병합 '{revision}'", "Merge '{revision}'"), String::new())
                            }
                            "rebase" => {
                                let stop = args.get("stopOnConflict").and_then(Value::as_bool).unwrap_or(true);
                                (text(repo.rebase_with(a.s("revision")?, stop)), format!("Rebase → '{}'", a.s("revision")?), String::new())
                            }
                            "cherryPick" => (text(repo.cherry_pick(a.s("hash")?, a.b("merge"))), format!("Cherry-pick {}", short(a.s("hash")?)), String::new()),
                            "revert" => (text(repo.revert(a.s("hash")?, a.b("merge"))), format!("Revert {}", short(a.s("hash")?)), String::new()),
                            _ => {
                                let mode: ResetMode = serde_json::from_value(args.get("mode").cloned().unwrap_or_default())
                                    .map_err(|_| GitError::new(tr("reset 방식이 잘못되었습니다.", "The reset mode is invalid.")))?;
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
                // Fetch·Pull·Push 는 화면이 이름(job)을 붙인다: 진행 알림이 그 작업 것으로 나뉘고 cancelJob 으로 멈출 수 있다.
                // 다른 작업이 쓰기 잠금을 쥐고 있는 동안 온 취소도 지키려고, 잠금을 기다리는 것부터 작업 안에서 한다.
                let kind: Option<&'static str> = match cmd {
                    "fetch" => Some("fetch"),
                    "pull" => Some("pull"),
                    "push" => Some("push"),
                    _ => None,
                };
                let job = kind.and(args.get("job").and_then(Value::as_str).filter(|j| !j.is_empty()).map(str::to_string));
                let exec = move || -> Result<Value> {
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
                            let kind: ramus_core::files::PatternKind = serde_json::from_value(args.get("kind").cloned().unwrap_or_default())
                                .map_err(|_| GitError::new(tr("무시 방식이 잘못되었습니다.", "The ignore pattern type is invalid.")))?;
                            let r = if cmd == "ignore" { repo.ignore(a.s("path")?, kind) } else { repo.lfs_track(a.s("path")?, kind) };
                            r.map(|p| json!(p))
                        }
                        "lfsPull" => repo.lfs_pull(Args(&args).s("path")?).map(|_| Value::Null),
                        "stashPaths" => {
                            let message = Args(&args).s("message").unwrap_or("").to_string();
                            let paths = parse::<PathsArg>(args)?.paths;
                            let r = repo.stash_paths(&paths, &message).map(|_| Value::Null);
                            self.recorded_any(&repo, r, &before, |b, after| {
                                let mut e = UndoEntry::new(UndoKind::Stash, if message.is_empty() { tr("Stash (고른 파일)", "Stash (Selected Files)").to_string() } else { message.clone() });
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
                                let title = if a.amend { trf!("커밋 고쳐 쓰기 '{subject}'", "Amend Commit '{subject}'") } else { trf!("커밋 '{subject}'", "Commit '{subject}'") };
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
                };
                match (job, kind) {
                    (Some(job), Some(kind)) => {
                        let _tracked = self.track_job(&job, kind);
                        match ramus_core::with_job(&job, exec) {
                            (Err(_), true) => Err(GitError::cancelled(match kind {
                                "fetch" => tr("Fetch 를 취소했습니다.", "Fetch was cancelled."),
                                "pull" => tr("Pull 을 취소했습니다.", "Pull was cancelled."),
                                _ => tr("Push 를 취소했습니다.", "Push was cancelled."),
                            })),
                            (result, _) => result,
                        }
                    }
                    _ => exec(),
                }
            }
            _ => Err(GitError::new(trf!("모르는 요청: {cmd}", "Unknown request: {cmd}"))),
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

    /// 설정 > 로그인 의 SSH 키 목록. 앱 로그인이 있고 권한이 되면 GitHub 에 올라간 키와 견준다.
    fn ssh_keys(&self) -> Result<Value> {
        let home = dirs::home_dir().ok_or_else(|| GitError::new(tr("홈 폴더를 찾지 못했습니다.", "Couldn't find the home folder.")))?;
        let mut keys = sshkey::list(&home);
        let current = self.settings.lock().unwrap().ssh_key.clone();
        // ~/.ssh 밖에서 고른 키도 목록에 보인다.
        if !current.is_empty()
            && !keys.iter().any(|k| Path::new(&k.path) == Path::new(&current))
            && let Ok(key) = sshkey::read(Path::new(&current), None)
        {
            keys.push(key);
        }
        let login = self.app_login();
        let mut missing: Vec<String> = Vec::new();
        let mut uploaded: Option<Vec<String>> = None;
        if let Some((_, token)) = &login {
            if let Some(granted) = github::profile(token).and_then(|p| p.scopes) {
                missing = github::missing_scopes(&granted, &github::KEY_SCOPES);
            }
            if missing.is_empty() {
                uploaded = github::api("GET", "/user/keys?per_page=100", None, Some(token)).ok().and_then(|v| {
                    v.as_array().map(|list| list.iter().filter_map(|k| k.get("key").and_then(Value::as_str)).map(sshkey::key_body).collect())
                });
            }
        }
        let keys: Vec<Value> = keys
            .iter()
            .map(|k| {
                let mut v = json!(k);
                v["inUse"] = json!(!current.is_empty() && Path::new(&k.path) == Path::new(&current));
                v["onGithub"] = json!(uploaded.as_ref().map(|list| list.contains(&k.body())));
                v
            })
            .collect();
        Ok(json!({
            "keys": keys,
            "current": current,
            "signedIn": login.is_some(),
            "login": login.map(|(l, _)| l),
            "missingScopes": missing,
            "keygen": sshkey::ssh_keygen().is_some(),
        }))
    }

    /// 공개 키를 앱 로그인 계정에 올린다. 이미 올라가 있으면 그냥 넘어간다.
    fn upload_ssh_key(&self, key: &sshkey::SshKey, title: &str) -> Result<()> {
        let (_, token) = self.app_login().ok_or_else(|| GitError::new(tr("GitHub 에 로그인해 주세요.", "Sign in to GitHub.")))?;
        match github::api("POST", "/user/keys", Some(&json!({ "title": title, "key": key.body() })), Some(&token)) {
            Ok(_) => Ok(()),
            Err(e) if e.to_string().contains("already in use") => Ok(()),
            Err(e) if e.to_string().contains("404") || e.to_string().contains("403") => {
                Err(GitError::new(tr("키를 올릴 권한이 없습니다. 설정 > 로그인 에서 \"권한 추가\" 로 다시 로그인해 주세요.", "Not allowed to upload keys. Sign in again with \"Add Scope\" in Settings > Sign In.")))
            }
            Err(e) => Err(e),
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
        // 최근 목록: 폴더가 지금 없는 것(옮김·이름 바꿈·지움·드라이브 분리)은 missing 으로 표시해 시작 화면이 뱃지를 단다.
        let recent: Vec<Value> = s
            .recent
            .iter()
            .map(|r| {
                let mut v = json!(r);
                v["missing"] = json!(!Path::new(&r.path).is_dir());
                v
            })
            .collect();
        json!({
            "theme": s.theme,
            "recent": recent,
            "pullMode": s.pull_mode,
            "diffLayout": s.diff_layout,
            "autoFetchMinutes": s.auto_fetch_minutes,
            "ssl": s.ssl,
            "gitMode": gitbin::GitMode::from_settings(&s.git_mode, &s.git_path),
            "gitPath": s.git_path,
            "cloneDir": if s.clone_dir.is_empty() { dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default() } else { s.clone_dir.clone() },
            "openTabs": tabs,
            "sshLogin": ssh,
            "sshKey": s.ssh_key,
            "ui": s.ui,
            "platform": std::env::consts::OS,
        })
    }
}

fn repo_info(repo: &Repository) -> Value {
    // 원격 목록은 snapshot 의 참조에 들어 있어 여기서 읽지 않는다. 두 git 호출은 나란히.
    let (identity, superproject) = std::thread::scope(|scope| {
        let superproject = scope.spawn(|| repo.superproject());
        (repo.identity(), superproject.join().unwrap_or(None))
    });
    json!({
        "path": repo.root().display().to_string(),
        "name": repo.name(),
        "identity": identity,
        "superproject": superproject,
    })
}

/// 설정으로 모든 git 호출에 붙일 것을 만든다.
/// 작업 트리 파일을 고치는 원격 작업(Pull·브랜치 전환): 끊으면 트리가 찢어지므로 앱을 끌 때도 멈추지 않고 끝까지 기다린다.
pub fn touches_files(kind: &str) -> bool {
    matches!(kind, "pull" | "checkout")
}

pub fn globals_for(settings: &Settings) -> GitGlobals {
    let git = gitbin::resolve(gitbin::GitMode::from_settings(&settings.git_mode, &settings.git_path), &settings.git_path);
    let mut env = git.env;
    if !settings.ssh_key.is_empty() && Path::new(&settings.ssh_key).is_file() {
        env.extend(sshkey::environment(&settings.ssh_key));
    }
    GitGlobals { git_path: Some(git.path), config_args: ssl::build_arguments(&settings.ssl, cfg!(windows)), env }
}

/// 설정의 git 칸: 고른 모드, 실제로 쓰는 git(돌아갔으면 그 사유), 내장·시스템 git 의 자리와 버전.
fn git_info(settings: &Settings) -> Value {
    let mode = gitbin::GitMode::from_settings(&settings.git_mode, &settings.git_path);
    let active = gitbin::resolve(mode, &settings.git_path);
    let describe = |path: &Path, env: &std::collections::HashMap<String, String>| match gitbin::version(path, env) {
        Ok(v) => json!({ "path": path.display().to_string(), "version": v }),
        Err(e) => json!({ "path": path.display().to_string(), "error": e }),
    };
    let bundled = gitbin::bundled_dir().map(|dir| describe(&gitbin::bundled_binary(&dir), &gitbin::bundled_env(&dir)));
    let system = gitbin::find_system().map(|p| describe(&p, &Default::default()));
    let custom = (!settings.git_path.trim().is_empty()).then(|| describe(Path::new(settings.git_path.trim()), &Default::default()));
    let mut current = describe(&active.path, &active.env);
    current["source"] = json!(active.source);
    current["fallback"] = json!(active.fallback);
    json!({ "mode": mode, "active": current, "bundled": bundled, "system": system, "custom": custom })
}

/// 파일 관리자(Finder·탐색기)에서 그 파일을 골라 보인다.
fn reveal(repo: &Repository, path: &str) -> Result<()> {
    let relative = Path::new(path);
    if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(GitError::new(tr("레포지토리 밖의 경로입니다.", "The path is outside the repository.")));
    }
    let full = repo.root().join(relative);
    // 지운 파일이면 그 폴더를 연다.
    let target = if full.exists() { full } else { full.parent().map(Path::to_path_buf).unwrap_or_else(|| repo.root().to_path_buf()) };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").arg("-R").arg(&target).spawn();
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // `arg` 로 넘기면 `"/select,C:\a b\c"` 처럼 통째로 따옴표가 붙어 탐색기가 못 알아듣는다 — 경로만 감싼다.
        std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", native_path(&target).display())).spawn()
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("xdg-open").arg(target.parent().unwrap_or(&target)).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(trf!("파일 관리자를 열지 못했습니다: {e}", "Couldn't open the file manager: {e}")))
}

/// Windows 의 탐색기·cmd 는 `/` 구분자를 제대로 못 읽는다(엉뚱한 폴더가 열린다).
/// git 이 주는 루트(`C:/Users/...`)와 UI 가 이어 붙인 경로(`.../src/a.rs`)를 `\` 로 바꾼다.
#[cfg(windows)]
fn native_path(path: &Path) -> std::path::PathBuf {
    path.components().collect()
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
    spawned.map(|_| ()).map_err(|e| GitError::new(trf!("브라우저를 열지 못했습니다: {e}", "Couldn't open the browser: {e}")))
}

/// 파일을 OS 기본 프로그램으로 연다.
fn open_path(path: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").arg(path).spawn();
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").args(["/C", "start", ""]).arg(native_path(path)).creation_flags(0x0800_0000).spawn()
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("xdg-open").arg(path).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(trf!("파일을 열지 못했습니다: {e}", "Couldn't open the file: {e}")))
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
/// 폴더를 휴지통으로 옮긴다(영구 삭제가 아니다 — 휴지통에서 되살릴 수 있다).
fn move_to_trash(path: &Path) -> Result<()> {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // macOS 기본(Finder 에 AppleScript 로 시키기)은 자동화 권한을 묻는다 — 권한 없이 되는 NSFileManager 로.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(path).map_err(|e| GitError::new(trf!("휴지통으로 옮기지 못했습니다: {e}", "Couldn't move it to the Trash: {e}")))
}

fn open_folder(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Err(GitError::new(trf!("폴더가 없습니다: {}", "The folder doesn't exist: {}", path.display())));
    }
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").arg(path).spawn();
    #[cfg(windows)]
    let spawned = std::process::Command::new("explorer").arg(native_path(path)).spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("xdg-open").arg(path).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(trf!("파일 관리자를 열지 못했습니다: {e}", "Couldn't open the file manager: {e}")))
}

/// 레포지토리 폴더에서 터미널을 연다.
fn open_terminal(root: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/open").args(["-a", "Terminal"]).arg(root).spawn();
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // Windows Terminal 이 있으면 그것, 없으면 cmd.
        let root = native_path(root);
        std::process::Command::new("wt").arg("-d").arg(&root).spawn().or_else(|_| {
            std::process::Command::new("cmd").args(["/C", "start", "cmd", "/K"]).arg(format!("cd /d \"{}\"", root.display())).creation_flags(0x0800_0000).spawn()
        })
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let spawned = std::process::Command::new("x-terminal-emulator").current_dir(root).spawn();
    spawned.map(|_| ()).map_err(|e| GitError::new(trf!("터미널을 열지 못했습니다: {e}", "Couldn't open the terminal: {e}")))
}

/// 요청 인자 읽기.
struct Args<'a>(&'a Value);

impl Args<'_> {
    fn s(&self, key: &str) -> Result<&str> {
        self.0.get(key).and_then(Value::as_str).ok_or_else(|| GitError::new(trf!("요청 인자 '{key}' 가 없습니다.", "The request argument '{key}' is missing.")))
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

/// TIFF 바이트면 PNG 로 다시 담는다. TIFF 가 아니거나 읽지 못하면 None.
fn tiff_to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    if !(bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*")) {
        return None;
    }
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Tiff).ok()?;
    // 16비트·부동소수 채널은 PNG 로 그대로 못 담는 것도 있다 — 화면에 보일 8비트 RGBA 로 맞춘다.
    let img = image::DynamicImage::ImageRgba8(img.to_rgba8());
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
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
    serde_json::from_value(args).map_err(|e| GitError::new(trf!("요청 인자가 잘못되었습니다: {e}", "The request arguments are invalid: {e}")))
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
    ssl: Option<ramus_core::ssl::SslSettings>,
    git_path: Option<String>,
    git_mode: Option<String>,
    ssh_key: Option<String>,
}

#[derive(Deserialize)]
struct DiffArg {
    target: DiffTarget,
    #[serde(default)]
    options: ramus_core::repo::DiffOptions,
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

/// 요청의 account {source, login}.
fn account_arg(args: &Value) -> Option<(String, String)> {
    let v = args.get("account").filter(|v| !v.is_null())?;
    Some((v.get("source")?.as_str()?.to_string(), v.get("login")?.as_str()?.to_string()))
}

/// Clone 창 목록 캐시의 판. 목록 질의(받는 레포지토리 범위·필드)를 바꾸면 올린다.
const CLONE_CACHE_VERSION: u64 = 2;

/// Clone 창 목록을 계정마다 넣어 두는 파일(캐시 폴더/Ramus/GitHubRepos/<source>-<login>.json).
fn clone_cache_path(source: &str, login: &str) -> Option<PathBuf> {
    let safe = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect::<String>().to_lowercase();
    let name = format!("{}-{}.json", safe(source), safe(login));
    dirs::cache_dir().map(|d| d.join("Ramus").join("GitHubRepos").join(name))
}

/// git 설정 파일 글에서 [remote "…"] 칸의 url 들.
fn remote_urls(config: &str) -> Vec<String> {
    let mut in_remote = false;
    let mut urls = Vec::new();
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_remote = line.starts_with("[remote ");
        } else if in_remote
            && let Some((key, value)) = line.split_once('=')
            && key.trim().eq_ignore_ascii_case("url")
        {
            urls.push(value.trim().trim_matches('"').to_string());
        }
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_remote_urls_from_git_config() {
        let config = "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:NK-Studio/ramus.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n[remote \"upstream\"]\n\turl = https://github.com/o/r.git\n";
        assert_eq!(remote_urls(config), ["git@github.com:NK-Studio/ramus.git", "https://github.com/o/r.git"]);
    }

    #[test]
    fn converts_tiff_to_png() {
        let mut tiff = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(3, 2, image::Rgb([200, 10, 30]))).write_to(&mut tiff, image::ImageFormat::Tiff).unwrap();
        let png = tiff_to_png(tiff.get_ref()).expect("TIFF 를 PNG 로");
        assert_eq!(image_mime(&png), "image/png");
        let back = image::load_from_memory(&png).unwrap();
        assert_eq!((back.width(), back.height()), (3, 2));
        assert!(tiff_to_png(&png).is_none());
    }

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
