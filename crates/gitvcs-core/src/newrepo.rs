//! 레포지토리 만들기(원본에 없음 · 확장, GitKraken 의 "Initialize a Repository" 를 본떴다).
//!
//! 로컬: 폴더 만들기 → git init(기본 브랜치) → .gitignore·LICENSE → (LFS) → 파일이 생겼으면 "Initial commit".
//! .gitignore 틀·라이선스의 목록과 본문은 GitHub API(토큰 없이 부를 수 있다)에서 받아 앱이 켜져 있는 동안 기억한다.
//! 인터넷이 안 되면 `.gitignore` 는 내장 틀(`remote::gitignore_template`)만 보이고 라이선스는 끈다.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::github;
use crate::remote::gitignore_template;
use crate::repo::{GitError, Result};
use crate::runner::GitRunner;

/// 라이선스 목록 맨 위 "Copyright (C) [year] [name]" 의 키(GitHub 라이선스가 아니다).
pub const COPYRIGHT_KEY: &str = "copyright";
pub const DEFAULT_BRANCH: &str = "main";
pub const INITIAL_COMMIT: &str = "Initial commit";

/// 인터넷이 안 될 때 보이는 내장 .gitignore 틀 이름(GitHub 이름과 같게 써서 온라인일 때 같은 틀을 받는다).
const BUILTIN_GITIGNORE: [&str; 4] = ["Basic", "Node", "Rust", "Unity"];

/// GET /licenses 는 "자주 쓰는" 것만 준다. GitKraken·GitHub 화면처럼 몇 가지를 더 붙인다(키는 /licenses/{key} 로 받을 수 있다).
const EXTRA_LICENSES: [(&str, &str); 2] = [("artistic-2.0", "Artistic License 2.0"), ("lgpl-3.0", "GNU Lesser General Public License v3.0")];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LicenseInfo {
    pub key: String,
    pub name: String,
}

/// 만들기 창이 쓰는 목록. `online` 이 false 면 .gitignore 는 내장 틀뿐이고 라이선스는 비어 있다.
#[derive(Debug, Clone, Serialize)]
pub struct Templates {
    pub gitignore: Vec<String>,
    pub licenses: Vec<LicenseInfo>,
    pub online: bool,
}

fn cache() -> &'static Mutex<HashMap<String, Value>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// GitHub GET 을 앱이 켜져 있는 동안 기억한다(성공한 것만).
fn cached_get(path: &str, token: Option<&str>) -> Result<Value> {
    if let Some(v) = cache().lock().unwrap().get(path) {
        return Ok(v.clone());
    }
    let value = github::api("GET", path, None, token)?;
    cache().lock().unwrap().insert(path.to_string(), value.clone());
    Ok(value)
}

/// 주소 한 토막으로 쓸 수 있게 영문·숫자·`-_.` 밖의 글자를 %XX 로 바꾼다("C++" → "C%2B%2B").
fn encode_segment(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// .gitignore 틀·라이선스 목록.
pub fn templates(token: Option<&str>) -> Templates {
    let gitignore: Option<Vec<String>> = cached_get("/gitignore/templates", token)
        .ok()
        .and_then(|v| v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()))
        .filter(|list: &Vec<String>| !list.is_empty());
    let licenses: Option<Vec<LicenseInfo>> = cached_get("/licenses", token).ok().and_then(|v| {
        let list: Vec<LicenseInfo> = v
            .as_array()?
            .iter()
            .filter_map(|l| Some(LicenseInfo { key: l.get("key")?.as_str()?.to_string(), name: l.get("name")?.as_str()?.to_string() }))
            .collect();
        (!list.is_empty()).then_some(list)
    });
    match (gitignore, licenses) {
        (Some(gitignore), licenses) => {
            let mut licenses = licenses.unwrap_or_default();
            for (key, name) in EXTRA_LICENSES {
                if !licenses.iter().any(|l| l.key == key) {
                    licenses.push(LicenseInfo { key: key.into(), name: name.into() });
                }
            }
            licenses.sort_by_key(|l| l.name.to_lowercase());
            Templates { gitignore, licenses, online: true }
        }
        _ => Templates { gitignore: BUILTIN_GITIGNORE.iter().map(|s| s.to_string()).collect(), licenses: Vec::new(), online: false },
    }
}

/// .gitignore 틀 본문: GitHub 에서 받고, 안 되면 내장 틀.
pub fn gitignore_body(name: &str, token: Option<&str>) -> Result<String> {
    let online = cached_get(&format!("/gitignore/templates/{}", encode_segment(name)), token)
        .ok()
        .and_then(|v| v.get("source").and_then(Value::as_str).map(str::to_string));
    if let Some(source) = online {
        return Ok(source);
    }
    let builtin = gitignore_template(&name.to_lowercase());
    if builtin.is_empty() {
        return Err(GitError::new(format!(".gitignore 틀 '{name}' 을 받지 못했습니다. 인터넷 연결을 확인해 주세요.")));
    }
    Ok(builtin.to_string())
}

/// 라이선스 본문. `copyright` 면 한 줄, 아니면 GitHub 의 본문에 올해·이름을 채운다.
pub fn license_body(key: &str, year: i32, holder: &str, token: Option<&str>) -> Result<String> {
    if key == COPYRIGHT_KEY {
        return Ok(fill_license("Copyright (C) [year] [fullname]\n", year, holder));
    }
    let value = cached_get(&format!("/licenses/{}", encode_segment(key)), token)
        .map_err(|e| GitError::new(format!("라이선스 본문을 받지 못했습니다: {}", e.message)))?;
    let body = value.get("body").and_then(Value::as_str).ok_or_else(|| GitError::new("라이선스 본문을 읽지 못했습니다."))?;
    Ok(fill_license(body, year, holder))
}

/// 라이선스 본문의 자리표시([year]·[yyyy]·[fullname]·[name of copyright owner]·[name])를 올해·이름으로 바꾼다.
/// 이름이 비면 이름 자리표시는 그대로 둔다(사용자가 나중에 채우게).
pub fn fill_license(body: &str, year: i32, holder: &str) -> String {
    let mut text = body.replace("[year]", &year.to_string()).replace("[yyyy]", &year.to_string());
    let holder = holder.trim();
    if !holder.is_empty() {
        for mark in ["[fullname]", "[name of copyright owner]", "[name]"] {
            text = text.replace(mark, holder);
        }
    }
    text
}

/// 올해(UTC). 날짜 라이브러리 없이 1970-01-01 부터 지난 날 수로 센다.
pub fn current_year() -> i32 {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    year_from_days(days)
}

/// 1970-01-01 부터 `days` 날 지난 날의 해(그레고리력, H. Hinnant 의 civil_from_days).
fn year_from_days(days: i64) -> i32 {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2)) as i32
}

/// 만들 곳이 지금 어떤가(만들기 창이 버튼을 끄고 이유를 보일 때).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathState {
    pub exists: bool,
    pub is_dir: bool,
    /// 폴더가 비어 있다(없으면 true).
    pub empty: bool,
    /// 이미 `.git` 이 있다.
    pub has_git: bool,
}

pub fn path_state(path: &Path) -> PathState {
    let exists = path.exists();
    let is_dir = path.is_dir();
    let empty = !exists || (is_dir && std::fs::read_dir(path).map(|mut d| d.next().is_none()).unwrap_or(false));
    PathState { exists, is_dir, empty, has_git: path.join(".git").exists() }
}

/// git-lfs 가 깔려 있는가.
pub fn lfs_available(git: &GitRunner) -> bool {
    git.run(&std::env::temp_dir(), &["lfs", "version"]).success()
}

pub fn lfs_missing() -> GitError {
    GitError::new("Git LFS 가 설치되어 있지 않습니다. https://git-lfs.com 에서 설치한 뒤 다시 시도해 주세요(macOS: brew install git-lfs).")
}

/// 기본 브랜치 이름: 비면 main, 아니면 git 이 받아 주는 이름인지 본다.
pub fn branch_name(git: &GitRunner, name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(DEFAULT_BRANCH.into());
    }
    let out = git.run(&std::env::temp_dir(), &["check-ref-format", "--branch", name]);
    if !out.success() {
        return Err(GitError::new(format!("브랜치 이름으로 쓸 수 없습니다: {name}")));
    }
    Ok(name.to_string())
}

/// 레포지토리를 만든 뒤 `git lfs install --local`.
pub fn lfs_install(git: &GitRunner, dir: &Path) -> Result<()> {
    let out = git.run(dir, &["lfs", "install", "--local"]);
    if out.success() { Ok(()) } else { Err(GitError::new(format!("Git LFS 를 켜지 못했습니다: {}", out.message()))) }
}

/// 로컬 레포지토리 만들기 요청. `gitignore`·`license` 는 이미 받아 둔 본문.
#[derive(Debug, Clone, Default)]
pub struct LocalRepo {
    pub branch: String,
    pub gitignore: Option<String>,
    pub license: Option<String>,
    pub lfs: bool,
    /// 시작 화면의 "git init…" 처럼 이미 있는 폴더를 레포지토리로 만든다(비어 있지 않아도, `.git` 만 없으면).
    pub allow_existing: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocalOutcome {
    /// 첫 커밋을 만들었다.
    pub committed: bool,
    /// 레포지토리는 만들었지만 첫 커밋을 못 만든 까닭(사용자 이름이 없음 등).
    pub warning: Option<String>,
}

/// `path` 에 레포지토리를 만든다. 문제(비어 있지 않은 폴더·잘못된 브랜치·LFS 없음)는 아무것도 만들기 전에 알린다.
/// 이미 있던 폴더면 앱이 쓴 .gitignore·LICENSE 만 첫 커밋에 넣는다(다른 파일은 그대로 둔다).
pub fn create_local(git: &GitRunner, path: &Path, request: &LocalRepo) -> Result<LocalOutcome> {
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(GitError::new("레포지토리를 만들 곳을 정해 주세요."));
    }
    let state = path_state(path);
    if state.exists && !state.is_dir {
        return Err(GitError::new(format!("같은 이름의 파일이 있습니다: {}", path.display())));
    }
    if state.has_git {
        return Err(GitError::new(format!("이미 git 레포지토리입니다: {}", path.display())));
    }
    if !state.empty && !request.allow_existing {
        return Err(GitError::new(format!("비어 있지 않은 폴더입니다: {}", path.display())));
    }
    let branch = branch_name(git, &request.branch)?;
    if request.lfs && !lfs_available(git) {
        return Err(lfs_missing());
    }
    std::fs::create_dir_all(path).map_err(|e| GitError::new(format!("폴더를 만들지 못했습니다: {e}")))?;
    let fail = |message: String| {
        // 이번에 만든 폴더면 반쯤 만든 것을 치운다(이미 있던 폴더는 .git 만).
        if state.exists {
            let _ = std::fs::remove_dir_all(path.join(".git"));
        } else {
            let _ = std::fs::remove_dir_all(path);
        }
        GitError::new(message)
    };
    let init = git.run(path, &["init", "-q"]);
    if !init.success() {
        return Err(fail(init.message()));
    }
    // `init -b` 는 git 2.28 부터라 커밋 전의 HEAD 를 직접 돌린다(어느 버전에서나 같다).
    let head = git.run(path, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")]);
    if !head.success() {
        return Err(fail(head.message()));
    }
    let mut added = Vec::new();
    for (file, content) in [(".gitignore", &request.gitignore), ("LICENSE", &request.license)] {
        let Some(content) = content.as_deref().filter(|c| !c.is_empty()) else { continue };
        let target = path.join(file);
        if target.exists() {
            continue;
        }
        std::fs::write(&target, content).map_err(|e| GitError::new(format!("{file} 을 쓰지 못했습니다: {e}")))?;
        added.push(file);
    }
    if request.lfs {
        lfs_install(git, path)?;
    }
    if added.is_empty() {
        return Ok(LocalOutcome::default());
    }
    let mut add = vec!["add", "--"];
    add.extend(added.iter().copied());
    let staged = git.run(path, &add);
    if !staged.success() {
        return Ok(LocalOutcome { committed: false, warning: Some(format!("파일을 Stage 하지 못했습니다: {}", staged.message())) });
    }
    let commit = git.run(path, &["commit", "-q", "-m", INITIAL_COMMIT]);
    if !commit.success() {
        return Ok(LocalOutcome { committed: false, warning: Some(format!("첫 커밋을 만들지 못했습니다: {}", commit.message())) });
    }
    Ok(LocalOutcome { committed: true, warning: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::GitGlobals;

    fn runner() -> GitRunner {
        let env = [("GIT_AUTHOR_NAME", "테스터"), ("GIT_AUTHOR_EMAIL", "t@example.com"), ("GIT_COMMITTER_NAME", "테스터"), ("GIT_COMMITTER_EMAIL", "t@example.com")];
        GitRunner::new(GitGlobals {
            config_args: vec!["-c".into(), "commit.gpgsign=false".into()],
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        })
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = runner().run(dir, args);
        assert!(out.success(), "git {args:?}: {}", out.message());
        out.stdout.trim().to_string()
    }

    #[test]
    fn fills_license_placeholders() {
        let mit = "MIT License\n\nCopyright (c) [year] [fullname]\n";
        assert_eq!(fill_license(mit, 2026, "김한용"), "MIT License\n\nCopyright (c) 2026 김한용\n");
        let apache = "Copyright [yyyy] [name of copyright owner]";
        assert_eq!(fill_license(apache, 2026, "NK Studio"), "Copyright 2026 NK Studio");
        // 이름을 모르면 이름 자리는 남긴다.
        assert_eq!(fill_license(mit, 2026, "  "), "MIT License\n\nCopyright (c) 2026 [fullname]\n");
        assert_eq!(license_body(COPYRIGHT_KEY, 2026, "테스터", None).unwrap(), "Copyright (C) 2026 테스터\n");
    }

    #[test]
    fn years_from_days() {
        assert_eq!(year_from_days(0), 1970);
        assert_eq!(year_from_days(365), 1971);
        assert_eq!(year_from_days(20_454), 2026); // 2026-01-01
        assert_eq!(year_from_days(20_453), 2025); // 2025-12-31
        assert!(current_year() >= 2025);
    }

    #[test]
    fn encodes_template_names() {
        assert_eq!(encode_segment("C++"), "C%2B%2B");
        assert_eq!(encode_segment("Unity"), "Unity");
    }

    #[test]
    fn creates_local_repository_with_first_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("parent").join("game");
        let request = LocalRepo {
            branch: "develop".into(),
            gitignore: Some(gitignore_template("unity").into()),
            license: Some(fill_license("Copyright (c) [year] [fullname]\n", 2026, "테스터")),
            ..Default::default()
        };
        let outcome = create_local(&runner(), &path, &request).unwrap();
        assert_eq!(outcome, LocalOutcome { committed: true, warning: None });
        assert_eq!(git(&path, &["symbolic-ref", "--short", "HEAD"]), "develop");
        assert_eq!(git(&path, &["log", "--format=%s"]), INITIAL_COMMIT);
        let mut files: Vec<String> = git(&path, &["ls-files"]).lines().map(str::to_string).collect();
        files.sort();
        assert_eq!(files, [".gitignore", "LICENSE"]);
        assert!(std::fs::read_to_string(path.join(".gitignore")).unwrap().contains("[Ll]ibrary"));
        assert_eq!(std::fs::read_to_string(path.join("LICENSE")).unwrap(), "Copyright (c) 2026 테스터\n");
        // 같은 곳에 다시 만들면 거절한다.
        assert!(create_local(&runner(), &path, &request).unwrap_err().message.contains("이미 git 레포지토리"));
    }

    #[test]
    fn empty_request_makes_repository_without_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("empty");
        let outcome = create_local(&runner(), &path, &LocalRepo::default()).unwrap();
        assert!(!outcome.committed);
        assert_eq!(git(&path, &["symbolic-ref", "--short", "HEAD"]), DEFAULT_BRANCH);
        assert!(!runner().run(&path, &["rev-parse", "--verify", "HEAD"]).success());
    }

    #[test]
    fn refuses_non_empty_folder_unless_existing_allowed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("work");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("notes.txt"), "keep").unwrap();
        let request = LocalRepo { gitignore: Some("*.log\n".into()), ..Default::default() };
        let err = create_local(&runner(), &path, &request).unwrap_err();
        assert!(err.message.contains("비어 있지 않은 폴더"), "{}", err.message);
        assert!(!path.join(".git").exists());

        let outcome = create_local(&runner(), &path, &LocalRepo { allow_existing: true, ..request }).unwrap();
        assert!(outcome.committed);
        // 앱이 쓴 .gitignore 만 커밋하고, 원래 있던 파일은 손대지 않는다.
        assert_eq!(git(&path, &["ls-files"]), ".gitignore");
        assert_eq!(std::fs::read_to_string(path.join("notes.txt")).unwrap(), "keep");
    }

    #[test]
    fn rejects_bad_branch_before_creating_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad");
        let err = create_local(&runner(), &path, &LocalRepo { branch: "a..b".into(), ..Default::default() }).unwrap_err();
        assert!(err.message.contains("브랜치 이름"), "{}", err.message);
        assert!(!path.exists());
        assert_eq!(branch_name(&runner(), "  ").unwrap(), DEFAULT_BRANCH);
    }

    #[test]
    fn installs_lfs_when_available() {
        if !lfs_available(&runner()) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("lfs");
        create_local(&runner(), &path, &LocalRepo { lfs: true, ..Default::default() }).unwrap();
        assert!(git(&path, &["config", "--local", "--get", "filter.lfs.process"]).contains("git-lfs"));
    }

    /// 실제 GitHub API 를 부른다(인터넷 필요): `cargo test -p gitvcs-core -- --ignored online`.
    #[test]
    #[ignore]
    fn online_templates_and_bodies() {
        let list = templates(None);
        assert!(list.online);
        assert!(list.gitignore.iter().any(|n| n == "Unity"));
        assert!(list.licenses.iter().any(|l| l.key == "mit") && list.licenses.iter().any(|l| l.key == "artistic-2.0"));
        assert!(gitignore_body("Unity", None).unwrap().contains("[Ll]ibrary"));
        let mit = license_body("mit", 2026, "테스터", None).unwrap();
        assert!(mit.contains("Copyright (c) 2026 테스터"), "{mit}");
    }

    #[test]
    fn path_states() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(path_state(&tmp.path().join("none")), PathState { exists: false, is_dir: false, empty: true, has_git: false });
        assert_eq!(path_state(tmp.path()), PathState { exists: true, is_dir: true, empty: true, has_git: false });
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        assert_eq!(path_state(tmp.path()), PathState { exists: true, is_dir: true, empty: false, has_git: true });
    }
}
