//! 저장소 하나에 하는 git 작업. 화면과 상관없는 순수 git 호출이라 테스트에서 임시 저장소로 돌린다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::diff::{self, DiffDocument};
use crate::graph::{self, GraphLayout};
use crate::patch;
use crate::log::{self, Commit, FileChange};
use crate::runner::{GitOutput, GitRunner};
use crate::ssl;
use crate::status::{self, BranchInfo, StatusEntry};

/// 사용자에게 보일 git 실패. 원인을 알아보면 화면이 해결 방법을 함께 보인다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitError {
    pub message: String,
    /// SSL·인증서 문제(회사망 보안 프록시 등).
    pub ssl: bool,
    /// 로그인이 필요하거나 거절됨.
    pub auth: bool,
}

impl GitError {
    pub fn new(message: impl Into<String>) -> Self {
        // git 의 "hint:" 줄은 터미널 사용자용 설명이라 길기만 하다 — 뺀다.
        let message: String = message.into().lines().filter(|l| !l.starts_with("hint:")).collect::<Vec<_>>().join("\n").trim().to_string();
        GitError { ssl: ssl::is_ssl_failure(&message), auth: is_auth_failure(&message), message }
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Result<T> = std::result::Result<T, GitError>;

fn is_auth_failure(message: &str) -> bool {
    let lower = message.to_lowercase();
    ["permission denied (", "could not read username", "authentication failed", "could not read password", "invalid username or password"]
        .iter()
        .any(|p| lower.contains(p))
}

fn check(out: GitOutput) -> Result<GitOutput> {
    if out.success() { Ok(out) } else { Err(GitError::new(out.message())) }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: BranchInfo,
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub conflicted: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub commits: Vec<Commit>,
    pub graph: GraphLayout,
    /// HEAD 의 전체 해시. 커밋이 없으면 None.
    pub head: Option<String>,
    /// 더 읽을 커밋이 남았을 수 있다(`max_count` 만큼 꽉 찼다).
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    pub email: String,
}

#[derive(Clone)]
pub struct Repository {
    root: PathBuf,
    git_dir: PathBuf,
    git: GitRunner,
}

/// diff 를 볼 대상.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffTarget {
    /// 작업 트리 ↔ 인덱스(아직 Stage 하지 않은 변경). 새 파일은 빈 파일과 비교한다.
    #[serde(rename_all = "camelCase")]
    Unstaged { path: String, #[serde(default)] untracked: bool },
    /// 인덱스 ↔ HEAD(Stage 한 변경).
    #[serde(rename_all = "camelCase")]
    Staged { path: String, #[serde(default)] original_path: Option<String> },
    /// 커밋이 첫 부모 대비 바꾼 것. 최초 커밋은 빈 트리 대비.
    #[serde(rename_all = "camelCase")]
    Commit { hash: String, path: String, #[serde(default)] original_path: Option<String> },
}

/// 고른 줄로 무엇을 하는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineAction {
    /// Unstaged diff 의 줄을 인덱스에 올린다.
    Stage,
    /// Staged diff 의 줄을 인덱스에서 내린다.
    Unstage,
    /// Unstaged diff 의 줄을 작업 트리에서 버린다.
    Discard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// 앞으로 감기만(갈라졌으면 실패). 원본 패키지의 기본값.
    #[default]
    FfOnly,
    Merge,
    /// 작업 중 변경이 있으면 git 이 거절하므로 `--autostash` 로 잠시 치웠다가 되돌린다.
    Rebase,
}

impl PullMode {
    pub fn args(self) -> &'static [&'static str] {
        match self {
            PullMode::FfOnly => &["pull", "--ff-only"],
            PullMode::Merge => &["pull", "--no-rebase"],
            PullMode::Rebase => &["pull", "--rebase", "--autostash"],
        }
    }
}

fn diff_options(args: &mut Vec<String>) {
    // 사용자의 외부 diff 설정(diff.external, textconv)은 끄고, 색을 빼서 읽을 수 있는 출력을 받는다.
    args.extend(["--no-color", "--no-ext-diff", "--no-textconv", "-U3"].map(String::from));
}

/// diff 를 보여 줄 git 인자. 순수 함수라 테스트로 확인한다.
pub fn diff_args(target: &DiffTarget) -> Vec<String> {
    let mut args: Vec<String>;
    let (path, original) = match target {
        DiffTarget::Unstaged { path, untracked: true } => {
            args = vec!["diff".into(), "--no-index".into()];
            diff_options(&mut args);
            // --no-index 의 /dev/null 은 Windows git 도 특별히 읽는다.
            args.extend(["--".into(), "/dev/null".into(), path.clone()]);
            return args;
        }
        DiffTarget::Unstaged { path, .. } => {
            args = vec!["diff".into(), "-M".into()];
            (path, None)
        }
        DiffTarget::Staged { path, original_path } => {
            args = vec!["diff".into(), "--cached".into(), "-M".into()];
            (path, original_path.as_ref())
        }
        DiffTarget::Commit { hash, path, original_path } => {
            args = vec!["diff-tree".into(), "-p".into(), "-M".into(), "--root".into(), "--diff-merges=first-parent".into()];
            diff_options(&mut args);
            args.push(hash.clone());
            args.push("--".into());
            args.extend(original_path.iter().cloned());
            args.push(path.clone());
            return args;
        }
    };
    diff_options(&mut args);
    args.push("--".into());
    args.extend(original.cloned());
    args.push(path.clone());
    args
}

impl Repository {
    /// `path` 가 든 저장소를 연다(하위 폴더를 골라도 저장소 루트를 찾는다).
    pub fn open(git: GitRunner, path: &Path) -> Result<Repository> {
        if !path.is_dir() {
            return Err(GitError::new(format!("폴더가 없습니다: {}", path.display())));
        }
        let out = git.run(path, &["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
        if !out.success() {
            let msg = out.message();
            if msg.contains("not a git repository") {
                return Err(GitError::new(format!("Git 저장소가 아닙니다: {}", path.display())));
            }
            return Err(GitError::new(msg));
        }
        let mut lines = out.stdout.lines();
        let root = PathBuf::from(lines.next().unwrap_or_default().trim());
        let git_dir = PathBuf::from(lines.next().unwrap_or_default().trim());
        Ok(Repository { root, git_dir, git })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// .git 폴더(worktree 면 그 worktree 의 git 폴더).
    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    /// 마지막 fetch 시각. 터미널에서 한 fetch 도 FETCH_HEAD 를 갱신하므로 함께 잡힌다.
    pub fn last_fetch(&self) -> Option<std::time::SystemTime> {
        std::fs::metadata(self.git_dir.join("FETCH_HEAD")).and_then(|m| m.modified()).ok()
    }

    pub fn name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.root.display().to_string())
    }

    fn run<S: AsRef<str>>(&self, args: &[S]) -> Result<GitOutput> {
        check(self.git.run(&self.root, args))
    }

    /// 다른 모듈(refs 등)이 쓰는 git 실행. 성공하면 stdout.
    pub(crate) fn git_run<S: AsRef<str>>(&self, args: &[S]) -> Result<String> {
        self.run(args).map(|o| o.stdout)
    }

    /// 환경 변수를 더해 실행한다. 성공하면 stdout 과 stderr 를 이어 붙인 것.
    pub(crate) fn git_run_with_env<S: AsRef<str>>(&self, args: &[S], env: &[(&str, &str)]) -> Result<String> {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        check(self.git.run_with(&self.root, args, None, &env)).map(|o| format!("{}{}", o.stdout, o.stderr))
    }

    fn run_input<S: AsRef<str>>(&self, args: &[S], input: &str) -> Result<GitOutput> {
        check(self.git.run_with(&self.root, args, Some(input), &HashMap::new()))
    }

    pub fn status(&self) -> Result<RepoStatus> {
        let out = self.run(&["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"])?;
        let (branch, entries) = status::parse(&out.stdout);
        let conflicted = entries.iter().filter(|e| e.state == status::FileState::Conflicted).count();
        let staged = entries.iter().filter(|e| e.is_staged()).cloned().collect();
        let unstaged = entries.into_iter().filter(|e| e.is_unstaged()).collect();
        Ok(RepoStatus { branch, staged, unstaged, conflicted })
    }

    pub fn remotes(&self) -> Result<Vec<String>> {
        let out = self.run(&["remote"])?;
        Ok(out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
    }

    pub fn identity(&self) -> Identity {
        let get = |key: &str| self.git.run(&self.root, &["config", "--get", key]).stdout.trim().to_string();
        Identity { name: get("user.name"), email: get("user.email") }
    }

    pub fn head(&self) -> Option<String> {
        let out = self.git.run(&self.root, &["rev-parse", "--verify", "-q", "HEAD"]);
        out.success().then(|| out.stdout.trim().to_string())
    }

    /// 모든 브랜치의 커밋(stash 는 빼고). 커밋이 하나도 없으면 빈 히스토리.
    pub fn history(&self, max_count: usize) -> Result<History> {
        let head = self.head();
        if head.is_none() {
            return Ok(History { commits: Vec::new(), graph: GraphLayout { lane_count: 1, ..Default::default() }, head, truncated: false });
        }
        let remotes = self.remotes()?;
        let max = format!("--max-count={max_count}");
        let out = self.run(&["log", log::LOG_FORMAT, "--date-order", "--exclude=refs/stash", "--all", "HEAD", &max])?;
        let commits = log::parse_commits(&out.stdout, &remotes);
        let graph = graph::layout(&commits);
        let truncated = commits.len() >= max_count;
        Ok(History { commits, graph, head, truncated })
    }

    pub fn commit_detail(&self, hash: &str) -> Result<CommitDetail> {
        let out = self.run(&["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%B", hash])?;
        let f: Vec<&str> = out.stdout.splitn(6, '\x1f').collect();
        if f.len() < 6 {
            return Err(GitError::new(format!("커밋을 읽지 못했습니다: {hash}")));
        }
        let files = self.run(&["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "-M", "--root", "--diff-merges=first-parent", hash])?;
        Ok(CommitDetail {
            hash: f[0].to_string(),
            author_name: f[1].to_string(),
            author_email: f[2].to_string(),
            time: f[3].parse().unwrap_or(0),
            parents: f[4].split_whitespace().map(str::to_string).collect(),
            message: f[5].trim_end().to_string(),
            files: log::parse_name_status(&files.stdout),
        })
    }

    /// 마지막 커밋 메시지(Amend 할 때 채워 넣는다).
    pub fn last_message(&self) -> Result<String> {
        Ok(self.run(&["log", "-1", "--format=%B"])?.stdout.trim_end().to_string())
    }

    /// 파일을 Stage 한다. 지운 파일도 `-A` 로 함께 올린다.
    pub fn stage(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut args = vec!["add".to_string(), "-A".into(), "--".into()];
        args.extend(paths.iter().cloned());
        self.run(&args).map(|_| ())
    }

    pub fn stage_all(&self) -> Result<()> {
        self.run(&["add", "-A"]).map(|_| ())
    }

    /// Stage 를 푼다. 첫 커밋 전에는 HEAD 가 없어 `reset` 대신 인덱스에서 뺀다.
    pub fn unstage(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut args: Vec<String> = if self.head().is_some() {
            vec!["reset".into(), "-q".into(), "--".into()]
        } else {
            vec!["rm".into(), "--cached".into(), "-r".into(), "-q".into(), "--".into()]
        };
        args.extend(paths.iter().cloned());
        self.run(&args).map(|_| ())
    }

    pub fn unstage_all(&self) -> Result<()> {
        if self.head().is_some() {
            self.run(&["reset", "-q"]).map(|_| ())
        } else {
            self.run(&["rm", "--cached", "-r", "-q", "."]).map(|_| ())
        }
    }

    /// Stage 한 변경을 커밋한다. 메시지는 표준 입력으로 넘긴다(따옴표·줄바꿈이 명령줄에서 깨지지 않게).
    pub fn commit(&self, message: &str, amend: bool) -> Result<String> {
        if message.trim().is_empty() {
            return Err(GitError::new("커밋 메시지를 적어 주세요."));
        }
        let mut args = vec!["commit", "-F", "-"];
        if amend {
            args.push("--amend");
        }
        self.run_input(&args, message)?;
        Ok(self.head().unwrap_or_default())
    }

    /// 지금 브랜치를 푸시한다. upstream 이 없으면 원격(origin 이 있으면 origin)에 같은 이름으로 올리고 추적을 건다.
    pub fn push(&self) -> Result<String> {
        let st = self.status()?;
        if st.branch.detached {
            return Err(GitError::new("브랜치가 아닌 커밋을 보고 있어 푸시할 수 없습니다. 브랜치를 체크아웃해 주세요."));
        }
        let out = if st.branch.upstream.is_some() {
            self.run(&["push"])?
        } else {
            let remotes = self.remotes()?;
            let remote = remotes.iter().find(|r| *r == "origin").or(remotes.first()).cloned();
            let Some(remote) = remote else {
                return Err(GitError::new("원격 저장소가 없습니다. 먼저 원격을 추가해 주세요."));
            };
            self.run(&["push", "-u", &remote, &st.branch.name])?
        };
        Ok(out.message())
    }
}

/// diff·줄 단위 작업·버리기·동기화.
impl Repository {
    pub fn diff(&self, target: &DiffTarget) -> Result<DiffDocument> {
        let out = self.git.run(&self.root, &diff_args(target));
        // --no-index 는 차이가 있으면 종료 코드 1 이다.
        let no_index = matches!(target, DiffTarget::Unstaged { untracked: true, .. });
        if out.success() || (no_index && out.code == 1) {
            Ok(diff::parse(&out.stdout))
        } else {
            Err(GitError::new(out.message()))
        }
    }

    /// 고른 줄만 Stage·Unstage·버린다. `fingerprint` 는 화면이 본 diff 의 지문 — 그 사이 파일이 바뀌었으면 하지 않는다
    /// (다른 줄을 건드리게 되므로).
    pub fn apply_lines(&self, action: LineAction, path: &str, untracked: bool, fingerprint: &str, selected: &[usize]) -> Result<()> {
        let target = match action {
            LineAction::Unstage => DiffTarget::Staged { path: path.to_string(), original_path: None },
            _ => DiffTarget::Unstaged { path: path.to_string(), untracked },
        };
        let doc = self.diff(&target)?;
        if doc.fingerprint != fingerprint {
            return Err(GitError::new("그 사이 파일이 바뀌었습니다. diff 를 다시 읽었으니 다시 골라 주세요."));
        }
        let mut doc = doc;
        if untracked {
            if action == LineAction::Discard {
                return Err(GitError::new("새 파일은 줄 단위로 버릴 수 없습니다. 파일을 통째로 버려 주세요."));
            }
            // 새 파일은 인덱스에 없어 패치를 댈 곳이 없다. 빈 내용으로 먼저 올리면(intent-to-add) 보통 diff 와 같아진다.
            self.run(&["add", "-N", "--", path])?;
            doc = self.diff(&DiffTarget::Unstaged { path: path.to_string(), untracked: false })?;
            if doc.fingerprint != fingerprint {
                let _ = self.unstage(&[path.to_string()]);
                return Err(GitError::new("새 파일의 diff 가 예상과 달라 Stage 하지 않았습니다."));
            }
        }
        let Some(patch) = patch::build(&doc.lines, selected, path, action != LineAction::Stage) else {
            return Err(GitError::new("고른 줄에 바뀐 줄이 없습니다."));
        };
        let args: &[&str] = match action {
            LineAction::Stage => &["apply", "--cached", "--whitespace=nowarn", "-"],
            LineAction::Unstage => &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
            LineAction::Discard => &["apply", "--reverse", "--whitespace=nowarn", "-"],
        };
        self.run_input(args, &patch)?;
        Ok(())
    }

    /// 파일을 HEAD 상태로 되돌린다(Stage 한 것까지). 새 파일은 지운다.
    pub fn discard(&self, paths: &[String]) -> Result<()> {
        let st = self.status()?;
        let entries: Vec<&StatusEntry> = st.unstaged.iter().chain(st.staged.iter()).filter(|e| paths.contains(&e.path)).collect();
        let mut untracked = Vec::new();
        let mut added = Vec::new();
        let mut tracked = Vec::new();
        for e in entries {
            match e.state {
                status::FileState::Untracked => untracked.push(e.path.clone()),
                status::FileState::Added => added.push(e.path.clone()),
                _ => {
                    tracked.push(e.path.clone());
                    tracked.extend(e.original_path.clone());
                }
            }
        }
        untracked.sort();
        untracked.dedup();
        for path in &untracked {
            let full = self.safe_join(path)?;
            std::fs::remove_file(&full).map_err(|e| GitError::new(format!("{path} 를 지우지 못했습니다: {e}")))?;
        }
        added.sort();
        added.dedup();
        if !added.is_empty() {
            let mut args = vec!["rm".to_string(), "-f".into(), "-q".into(), "--".into()];
            args.extend(added);
            self.run(&args)?;
        }
        tracked.sort();
        tracked.dedup();
        if !tracked.is_empty() {
            // HEAD 에 없는 경로(이름 변경의 새 경로)는 restore 가 인덱스·작업 트리에서 지운다.
            let mut args = vec!["restore".to_string(), "--source=HEAD".into(), "--staged".into(), "--worktree".into(), "--".into()];
            args.extend(tracked);
            self.run(&args)?;
        }
        Ok(())
    }

    /// 저장소 안의 경로만 받는다(`..` 로 밖을 가리키면 거절).
    fn safe_join(&self, path: &str) -> Result<PathBuf> {
        let relative = Path::new(path);
        if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(GitError::new(format!("저장소 밖의 경로입니다: {path}")));
        }
        Ok(self.root.join(relative))
    }

    /// 모든 원격을 페치한다. 원격이 없으면 아무것도 하지 않는다(false).
    /// `background` 면 자격 증명 관리자 로그인 창을 띄우지 않는다 — 저장된 자격 증명이 없으면 조용히 실패한다.
    pub fn fetch(&self, background: bool) -> Result<bool> {
        if self.remotes()?.is_empty() {
            return Ok(false);
        }
        let mut env = HashMap::new();
        if background {
            env.insert("GCM_INTERACTIVE".to_string(), "never".to_string());
        }
        check(self.git.run_with(&self.root, &["fetch", "--all", "--prune", "--quiet"], None, &env))?;
        Ok(true)
    }

    pub fn pull(&self, mode: PullMode) -> Result<String> {
        let st = self.status()?;
        if st.branch.upstream.is_none() {
            return Err(GitError::new("이 브랜치에는 추적하는 원격 브랜치가 없어 풀할 수 없습니다. 먼저 푸시해 주세요."));
        }
        let out = self.git.run(&self.root, mode.args());
        if out.success() {
            return Ok(out.message());
        }
        let msg = out.message();
        if mode == PullMode::FfOnly && (msg.contains("Not possible to fast-forward") || msg.contains("Diverging branches")) {
            return Err(GitError::new(format!(
                "로컬과 원격이 갈라져 앞으로 감기만으로는 풀할 수 없습니다. 풀 방식을 '병합' 이나 'Rebase' 로 바꿔 다시 해 주세요.\n\n{msg}"
            )));
        }
        Err(GitError::new(msg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_args_by_target() {
        let a = diff_args(&DiffTarget::Unstaged { path: "a b.txt".into(), untracked: false });
        assert_eq!(a, ["diff", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--", "a b.txt"]);
        let a = diff_args(&DiffTarget::Unstaged { path: "n.txt".into(), untracked: true });
        assert_eq!(a[..2], ["diff", "--no-index"]);
        assert_eq!(a[a.len() - 3..], ["--", "/dev/null", "n.txt"]);
        let a = diff_args(&DiffTarget::Staged { path: "new".into(), original_path: Some("old".into()) });
        assert_eq!(a[..3], ["diff", "--cached", "-M"]);
        assert_eq!(a[a.len() - 3..], ["--", "old", "new"]);
        let a = diff_args(&DiffTarget::Commit { hash: "abc".into(), path: "p".into(), original_path: None });
        assert_eq!(a[0], "diff-tree");
        assert_eq!(a[a.len() - 3..], ["abc", "--", "p"]);
    }

    #[test]
    fn pull_args() {
        assert_eq!(PullMode::FfOnly.args(), ["pull", "--ff-only"]);
        assert_eq!(PullMode::Rebase.args(), ["pull", "--rebase", "--autostash"]);
    }

    #[test]
    fn diff_target_from_json() {
        let t: DiffTarget = serde_json::from_str(r#"{"kind":"unstaged","path":"a","untracked":true}"#).unwrap();
        assert_eq!(t, DiffTarget::Unstaged { path: "a".into(), untracked: true });
        let t: DiffTarget = serde_json::from_str(r#"{"kind":"commit","hash":"h","path":"p","originalPath":"o"}"#).unwrap();
        assert_eq!(t, DiffTarget::Commit { hash: "h".into(), path: "p".into(), original_path: Some("o".into()) });
    }
}
