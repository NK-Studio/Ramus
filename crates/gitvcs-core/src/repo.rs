//! 저장소 하나에 하는 git 작업. 화면과 상관없는 순수 git 호출이라 테스트에서 임시 저장소로 돌린다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::graph::{self, GraphLayout};
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
        let message = message.into();
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
    git: GitRunner,
}

impl Repository {
    /// `path` 가 든 저장소를 연다(하위 폴더를 골라도 저장소 루트를 찾는다).
    pub fn open(git: GitRunner, path: &Path) -> Result<Repository> {
        if !path.is_dir() {
            return Err(GitError::new(format!("폴더가 없습니다: {}", path.display())));
        }
        let out = git.run(path, &["rev-parse", "--show-toplevel"]);
        if !out.success() {
            let msg = out.message();
            if msg.contains("not a git repository") {
                return Err(GitError::new(format!("Git 저장소가 아닙니다: {}", path.display())));
            }
            return Err(GitError::new(msg));
        }
        let root = PathBuf::from(out.stdout.trim());
        Ok(Repository { root, git })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.root.display().to_string())
    }

    fn run<S: AsRef<str>>(&self, args: &[S]) -> Result<GitOutput> {
        check(self.git.run(&self.root, args))
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
