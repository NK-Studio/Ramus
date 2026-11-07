//! 레포지토리 하나에 하는 git 작업. 화면과 상관없는 순수 git 호출이라 테스트에서 임시 레포지토리로 돌린다.

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
    /// 앱에서 로그인하면 풀리는 실패(GitHub 가 아닌 서버). 화면이 로그인 창을 띄우고 그 작업을 다시 한다.
    pub login: Option<crate::login::LoginTarget>,
    /// 원인·해결 한 줄씩(오류 대화상자의 "설명").
    pub advice: crate::advice::Advice,
    /// 화면이 보던 레포지토리와 열린 레포지토리가 달라 실행하지 않았다(탭을 바꾸는 사이에 보낸 요청). 화면은 조용히 버린다.
    pub stale: bool,
    /// 레포지토리 폴더가 앱 밖에서 사라졌다(지움·이름 바꿈·드라이브 분리). 화면은 오류 창 대신 그 탭을 거두고 한 줄만 알린다.
    pub gone: bool,
}

impl GitError {
    pub fn new(message: impl Into<String>) -> Self {
        // git 의 "hint:" 줄은 터미널 사용자용 설명이라 길기만 하다 — 뺀다.
        let message: String = message.into().lines().filter(|l| !l.starts_with("hint:")).collect::<Vec<_>>().join("\n").trim().to_string();
        GitError {
            ssl: ssl::is_ssl_failure(&message),
            auth: is_auth_failure(&message),
            login: crate::login::parse_failure(&message),
            advice: crate::advice::explain(&message, None),
            message,
            stale: false,
            gone: false,
        }
    }

    /// 레포지토리 폴더가 사라져 아무것도 할 수 없다는 오류.
    pub fn gone(path: &Path) -> Self {
        GitError { gone: true, ..GitError::new(format!("레포지토리 폴더를 찾을 수 없습니다: {}", path.display())) }
    }

    /// 탭을 바꾸는 사이에 온 요청을 건너뛰었다는 오류.
    pub fn stale() -> Self {
        GitError { stale: true, ..GitError::new("다른 레포지토리로 바뀌어 이 요청을 건너뛰었습니다.") }
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Result<T> = std::result::Result<T, GitError>;

fn is_auth_failure(message: &str) -> bool {
    crate::advice::is_auth_failure(message)
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
    /// 충돌 등으로 멈춘 채 진행 중인 작업(터미널에서 시작한 것도).
    pub operation: Option<crate::conflict::Operation>,
    /// 멈춘 병합에서 합쳐 오는 커밋(MERGE_HEAD). 그래프가 작업 중 줄에서 그 커밋까지 점선을 긋는다.
    pub merge_head: Option<String>,
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
pub struct Snapshot {
    pub status: RepoStatus,
    pub refs: crate::refs::Refs,
    pub history: History,
    pub remotes: Vec<crate::ops::Remote>,
    pub worktrees: Vec<crate::ops::Worktree>,
    pub submodules: Vec<crate::ops::Submodule>,
    /// `commit.template` 파일 내용(없으면 None).
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub time: i64,
    /// 커미터(원본 CommitHistoryView 의 COMMITTER 칸). 작성자와 같은 사람·같은 시각이면 화면에서 따로 보이지 않는다.
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
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
    /// 두 판 사이(비교 창). `to` 가 없으면 작업 트리, `range` 면 공통 조상부터.
    #[serde(rename_all = "camelCase")]
    Range { from: String, #[serde(default)] to: Option<String>, #[serde(default)] range: bool, path: String, #[serde(default)] original_path: Option<String> },
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
            PullMode::FfOnly => &["pull", "--progress", "--ff-only"],
            PullMode::Merge => &["pull", "--progress", "--no-rebase"],
            PullMode::Rebase => &["pull", "--progress", "--rebase", "--autostash"],
        }
    }
}

/// diff 를 어떻게 볼 것인가.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DiffOptions {
    /// 앞뒤 문맥 줄 수. `FULL_CONTEXT` 면 파일 전체(Inline·Split·파일 보기).
    pub context: u32,
    /// 공백 바뀜을 무시한다(이때는 줄 단위 Stage 를 하지 않는다 — 패치가 맞지 않는다).
    pub ignore_whitespace: bool,
    /// diff 알고리즘(myers·minimal·patience·histogram). 비우면 git 기본값.
    pub algorithm: Option<String>,
}

impl Default for DiffOptions {
    fn default() -> Self {
        DiffOptions { context: 3, ignore_whitespace: false, algorithm: None }
    }
}

/// 파일 전체를 문맥으로 보인다.
pub const FULL_CONTEXT: u32 = 1_000_000;

fn diff_options(args: &mut Vec<String>, options: DiffOptions) {
    // 사용자의 외부 diff 설정(diff.external, textconv)은 끄고, 색을 빼서 읽을 수 있는 출력을 받는다.
    args.extend(["--no-color", "--no-ext-diff", "--no-textconv"].map(String::from));
    args.push(format!("-U{}", options.context.min(FULL_CONTEXT)));
    if options.ignore_whitespace {
        args.push("-w".into());
    }
    if let Some(algorithm) = options.algorithm.as_deref().filter(|a| ["myers", "minimal", "patience", "histogram"].contains(a)) {
        args.push(format!("--diff-algorithm={algorithm}"));
    }
}

/// diff 를 보여 줄 git 인자. 순수 함수라 테스트로 확인한다.
pub fn diff_args(target: &DiffTarget) -> Vec<String> {
    diff_args_with(target, DiffOptions::default())
}

pub fn diff_args_with(target: &DiffTarget, options: DiffOptions) -> Vec<String> {
    let mut args: Vec<String>;
    let (path, original) = match target {
        DiffTarget::Unstaged { path, untracked: true } => {
            args = vec!["diff".into(), "--no-index".into()];
            diff_options(&mut args, options);
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
        DiffTarget::Range { from, to, range, path, original_path } => {
            args = vec!["diff".into(), "-M".into()];
            diff_options(&mut args, options);
            match (to, range) {
                (Some(to), true) => args.push(format!("{from}...{to}")),
                (Some(to), false) => args.extend([from.clone(), to.clone()]),
                (None, _) => args.push(from.clone()),
            }
            args.push("--".into());
            args.extend(original_path.iter().cloned());
            args.push(path.clone());
            return args;
        }
        DiffTarget::Commit { hash, path, original_path } => {
            args = vec!["diff-tree".into(), "-p".into(), "-M".into(), "--root".into(), "--diff-merges=first-parent".into()];
            diff_options(&mut args, options);
            args.push(hash.clone());
            args.push("--".into());
            args.extend(original_path.iter().cloned());
            args.push(path.clone());
            return args;
        }
    };
    diff_options(&mut args, options);
    args.push("--".into());
    args.extend(original.cloned());
    args.push(path.clone());
    args
}

impl Repository {
    /// `path` 가 든 레포지토리를 연다(하위 폴더를 골라도 레포지토리 루트를 찾는다).
    pub fn open(git: GitRunner, path: &Path) -> Result<Repository> {
        if !path.is_dir() {
            return Err(GitError::gone(path));
        }
        let out = git.run(path, &["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
        if !out.success() {
            let msg = out.message();
            if msg.contains("not a git repository") {
                return Err(GitError::new(format!("Git 레포지토리가 아닙니다: {}", path.display())));
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

    /// 서브모듈이면 상위 레포지토리 폴더.
    pub fn superproject(&self) -> Option<String> {
        self.git_run(&["rev-parse", "--show-superproject-working-tree"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
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

    /// 표준 입력과 환경 변수를 함께 넘긴다. 성공하면 stdout.
    pub(crate) fn git_run_full<S: AsRef<str>>(&self, args: &[S], input: Option<&str>, env: &[(&str, &str)]) -> Result<String> {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        check(self.git.run_with(&self.root, args, input, &env)).map(|o| o.stdout)
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
        let merge_head = std::fs::read_to_string(self.git_dir.join("MERGE_HEAD")).ok().and_then(|t| t.split_whitespace().next().map(str::to_string));
        Ok(RepoStatus { branch, staged, unstaged, conflicted, operation: crate::conflict::detect(&self.git_dir), merge_head })
    }

    pub fn remotes(&self) -> Result<Vec<String>> {
        let out = self.run(&["remote"])?;
        Ok(out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
    }

    pub fn identity(&self) -> Identity {
        // 두 키를 한 번에(프로세스 하나). 같은 키가 여러 번 나오면 `--get` 처럼 마지막 값.
        let out = self.git.run(&self.root, &["config", "--get-regexp", r"^user\.(name|email)$"]);
        let mut identity = Identity { name: String::new(), email: String::new() };
        for line in out.stdout.lines() {
            match line.split_once(' ') {
                Some(("user.name", value)) => identity.name = value.trim().to_string(),
                Some(("user.email", value)) => identity.email = value.trim().to_string(),
                _ => {}
            }
        }
        identity
    }

    pub fn head(&self) -> Option<String> {
        let out = self.git.run(&self.root, &["rev-parse", "--verify", "-q", "HEAD"]);
        out.success().then(|| out.stdout.trim().to_string())
    }

    /// 모든 참조의 커밋과 그 그래프. 커밋이 하나도 없으면 빈 히스토리.
    /// stash 는 `refs/stash` 를 빼고 읽은 뒤(그대로 두면 index·새 파일 커밋까지 따라 들어온다) `stash list` 의 모든 stash 를
    /// 만든 자리 위에 따로 끼운다 — 그래프는 점선 상자로 그린다.
    /// `head_first` 면 지금 브랜치가 맨 왼쪽 열을 갖는다 — 그래프 맨 위 작업 중 줄(WIP)이 지금 브랜치에 이어질 때.
    pub fn history(&self, max_count: usize, refs: &crate::refs::Refs, head_first: bool) -> Result<History> {
        self.history_from(self.head(), max_count, refs, head_first)
    }

    /// [`history`] 에서 HEAD 를 이미 읽어 둔 경우(snapshot 이 다른 읽기와 나란히 읽는다).
    pub fn history_from(&self, head: Option<String>, max_count: usize, refs: &crate::refs::Refs, head_first: bool) -> Result<History> {
        match self.load_commits(head.as_deref(), max_count, refs)? {
            Some(loaded) => Ok(Self::build_history(loaded, refs, head, head_first)),
            None => Ok(Self::empty_history()),
        }
    }

    fn empty_history() -> History {
        History { commits: Vec::new(), graph: GraphLayout { lane_count: 1, ..Default::default() }, head: None, truncated: false }
    }

    /// 커밋 목록만 읽는다(그래프 배치 전): (커밋들, 잘렸는지). HEAD 가 없으면(커밋 없음) None.
    fn load_commits(&self, head: Option<&str>, max_count: usize, refs: &crate::refs::Refs) -> Result<Option<(Vec<log::Commit>, bool)>> {
        if head.is_none() {
            return Ok(None);
        }
        let max = format!("--max-count={max_count}");
        let out = self.run(&["log", log::LOG_FORMAT, "--date-order", "--exclude=refs/stash", "--all", "HEAD", &max])?;
        let mut commits = log::parse_commits(&out.stdout, &refs.remotes);
        let truncated = commits.len() >= max_count;
        log::insert_stashes(&mut commits, self.stash_commits(&refs.stashes), truncated);
        Ok(Some((commits, truncated)))
    }

    /// 읽은 커밋 목록으로 그래프를 배치한다(git 을 부르지 않는다).
    fn build_history((commits, truncated): (Vec<log::Commit>, bool), refs: &crate::refs::Refs, head: Option<String>, head_first: bool) -> History {
        let tips: Vec<graph::BranchTip> = refs
            .local
            .iter()
            .chain(refs.remote.iter())
            .map(|b| graph::BranchTip { name: b.name.clone(), hash: b.hash.clone(), remote: b.remote.is_some(), current: b.current, time: b.time })
            .collect();
        let graph = graph::build(&commits, &tips, graph::ANONYMOUS_LANE, graph::Options { top_down: true, head_first });
        History { commits, graph, head, truncated }
    }

    /// stash 마다 (이름, 커밋). 새 stash 가 앞. 읽지 못하면 비운다(그래프에 stash 만 빠진다).
    fn stash_commits(&self, stashes: &[crate::refs::Stash]) -> Vec<(String, log::Commit)> {
        if stashes.is_empty() {
            return Vec::new();
        }
        let mut args = vec!["log", "--no-walk=unsorted", log::LOG_FORMAT];
        args.extend(stashes.iter().map(|s| s.hash.as_str()));
        let Ok(out) = self.run(&args) else { return Vec::new() };
        let mut by_hash: HashMap<String, log::Commit> = log::parse_commits(&out.stdout, &[]).into_iter().map(|c| (c.hash.clone(), c)).collect();
        stashes.iter().filter_map(|s| by_hash.remove(&s.hash).map(|c| (s.name.clone(), c))).collect()
    }

    /// 화면을 새로 그릴 때 필요한 것을 한 번에 읽는다: 상태·참조·히스토리. 상태와 참조는 함께 읽고, 그래프는 작업 중 변경이 있는지에 따라 배치한다.
    pub fn snapshot(&self, max_count: usize) -> Result<Snapshot> {
        // 큰 레포지토리에서는 status 가 가장 오래 걸린다(작업 트리 전체). 참조 → 커밋 목록까지 모두 그 옆에서 읽고,
        // status 가 끝나야 아는 것(작업 중 변경이 있는지)은 그래프 배치에만 쓴다.
        let (status, loaded, extra) = std::thread::scope(|scope| {
            let status = scope.spawn(|| self.status());
            let extra = scope.spawn(|| (self.remote_list().unwrap_or_default(), self.worktrees().unwrap_or_default(), self.submodules().unwrap_or_default(), self.commit_template()));
            let head = scope.spawn(|| self.head());
            let loaded = (|| {
                let refs = self.refs()?;
                let head = head.join().unwrap_or(None);
                let commits = self.load_commits(head.as_deref(), max_count, &refs)?;
                Ok::<_, GitError>((refs, head, commits))
            })();
            (status.join().unwrap_or_else(|_| Err(GitError::new("상태를 읽지 못했습니다."))), loaded, extra.join().unwrap_or_default())
        });
        let status = status?;
        let (refs, head, commits) = loaded?;
        let wip = !status.staged.is_empty() || !status.unstaged.is_empty();
        let history = match commits {
            Some(loaded) => Self::build_history(loaded, &refs, head, wip),
            None => Self::empty_history(),
        };
        let (remotes, worktrees, submodules, template) = extra;
        Ok(Snapshot { status, refs, history, remotes, worktrees, submodules, template })
    }

    pub fn commit_detail(&self, hash: &str) -> Result<CommitDetail> {
        let out = self.run(&["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%P%x1f%B", hash])?;
        let f: Vec<&str> = out.stdout.splitn(9, '\x1f').collect();
        if f.len() < 9 {
            return Err(GitError::new(format!("커밋을 읽지 못했습니다: {hash}")));
        }
        let files = self.run(&["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "-M", "--root", "--diff-merges=first-parent", hash])?;
        Ok(CommitDetail {
            hash: f[0].to_string(),
            author_name: f[1].to_string(),
            author_email: f[2].to_string(),
            time: f[3].parse().unwrap_or(0),
            committer_name: f[4].to_string(),
            committer_email: f[5].to_string(),
            committer_time: f[6].parse().unwrap_or(0),
            parents: f[7].split_whitespace().map(str::to_string).collect(),
            message: f[8].trim_end().to_string(),
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
        self.push_to(None)
    }

    /// `remote` 를 주면 upstream 이 없을 때 그 원격에 올린다(원격이 여럿일 때 화면이 고르게 한다).
    pub fn push_to(&self, remote: Option<&str>) -> Result<String> {
        let st = self.status()?;
        if st.branch.detached {
            return Err(GitError::new("브랜치가 아닌 커밋을 보고 있어 푸시할 수 없습니다. 브랜치를 체크아웃해 주세요."));
        }
        let out = if st.branch.upstream.is_some() {
            self.run(&["push", "--progress"])?
        } else {
            let remotes = self.remotes()?;
            let remote = remote.map(str::to_string).filter(|r| remotes.contains(r)).or_else(|| remotes.iter().find(|r| *r == "origin").or(remotes.first()).cloned());
            let Some(remote) = remote else {
                return Err(GitError::new("원격 레포지토리가 없습니다. 먼저 원격을 추가해 주세요."));
            };
            self.run(&["push", "--progress", "-u", &remote, &st.branch.name])?
        };
        Ok(out.message())
    }
}

/// diff·줄 단위 작업·버리기·동기화.
impl Repository {
    pub fn diff(&self, target: &DiffTarget) -> Result<DiffDocument> {
        self.diff_with(target, DiffOptions::default())
    }

    pub fn diff_with(&self, target: &DiffTarget, options: DiffOptions) -> Result<DiffDocument> {
        let out = self.git.run(&self.root, &diff_args_with(target, options));
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
        self.apply_lines_with(action, path, untracked, fingerprint, selected, 3)
    }

    /// `context` 는 화면이 본 diff 의 문맥 줄 수(같은 diff 를 다시 만들어 지문을 맞춘다).
    pub fn apply_lines_with(&self, action: LineAction, path: &str, untracked: bool, fingerprint: &str, selected: &[usize], context: u32) -> Result<()> {
        let options = DiffOptions { context, ..DiffOptions::default() };
        let target = match action {
            LineAction::Unstage => DiffTarget::Staged { path: path.to_string(), original_path: None },
            _ => DiffTarget::Unstaged { path: path.to_string(), untracked },
        };
        let doc = self.diff_with(&target, options.clone())?;
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
            doc = self.diff_with(&DiffTarget::Unstaged { path: path.to_string(), untracked: false }, options)?;
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

    /// 작업 트리 쪽 변경만 버린다(인덱스에 올린 내용은 남는다). 새 파일(untracked)은 지운다.
    /// Unstaged 목록의 "변경 버리기" 다(원본 GitOperations.DiscardWorkTreeAsync = `git restore --worktree`).
    pub fn discard_worktree(&self, paths: &[String]) -> Result<()> {
        let st = self.status()?;
        let mut untracked = Vec::new();
        let mut tracked = Vec::new();
        for e in st.unstaged.iter().filter(|e| paths.contains(&e.path)) {
            if e.state == status::FileState::Untracked {
                untracked.push(e.path.clone());
            } else {
                tracked.push(e.path.clone());
            }
        }
        untracked.sort();
        untracked.dedup();
        for path in &untracked {
            let full = self.safe_join(path)?;
            std::fs::remove_file(&full).map_err(|e| GitError::new(format!("{path} 를 지우지 못했습니다: {e}")))?;
        }
        tracked.sort();
        tracked.dedup();
        if !tracked.is_empty() {
            let mut args = vec!["restore".to_string(), "--worktree".into(), "--".into()];
            args.extend(tracked);
            self.run(&args)?;
        }
        Ok(())
    }

    pub(crate) fn runner(&self) -> &GitRunner {
        &self.git
    }

    pub(crate) fn safe_path(&self, path: &str) -> Result<PathBuf> {
        self.safe_join(path)
    }

    /// 레포지토리 안의 경로만 받는다(`..` 로 밖을 가리키면 거절).
    fn safe_join(&self, path: &str) -> Result<PathBuf> {
        let relative = Path::new(path);
        if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(GitError::new(format!("레포지토리 밖의 경로입니다: {path}")));
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
        // 직접 누른 페치는 진행을 보이고(--progress), 자동 페치는 조용히 한다.
        let args: &[&str] = if background { &["fetch", "--all", "--prune", "--quiet"] } else { &["fetch", "--all", "--prune", "--progress"] };
        check(self.git.run_with(&self.root, args, None, &env))?;
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
        assert_eq!(PullMode::FfOnly.args(), ["pull", "--progress", "--ff-only"]);
        assert_eq!(PullMode::Rebase.args(), ["pull", "--progress", "--rebase", "--autostash"]);
    }

    #[test]
    fn diff_target_from_json() {
        let t: DiffTarget = serde_json::from_str(r#"{"kind":"unstaged","path":"a","untracked":true}"#).unwrap();
        assert_eq!(t, DiffTarget::Unstaged { path: "a".into(), untracked: true });
        let t: DiffTarget = serde_json::from_str(r#"{"kind":"commit","hash":"h","path":"p","originalPath":"o"}"#).unwrap();
        assert_eq!(t, DiffTarget::Commit { hash: "h".into(), path: "p".into(), original_path: Some("o".into()) });
    }
}
