//! Ramus 의 git 로직. 화면(웹뷰)과 상관없이 `git` CLI(내장 git 또는 PC 의 git, gitbin 참고)를 실행하고 그 출력을 읽는다.

pub mod advice;
pub mod avatar;
pub mod conflict;
pub mod gitbin;
pub mod github;
pub mod graph;
pub mod history;
pub mod i18n;
pub mod diff;
pub mod files;
pub mod log;
pub mod newrepo;
pub mod login;
pub mod ops;
pub mod patch;
pub mod refs;
pub mod remote;
pub mod rewrite;
pub mod repo;
pub mod runner;
pub mod settings;
pub mod ssl;
pub mod sshkey;
pub mod status;
pub mod undo;

pub use repo::{GitError, Repository};
pub use runner::{GitGlobals, GitRunner, Progress, cancel_job, set_progress_sink, with_job};
pub use settings::Settings;
