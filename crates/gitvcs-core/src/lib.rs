//! gitvcs 의 git 로직. 화면(웹뷰)과 상관없이 PC 에 설치된 `git` CLI 를 실행하고 그 출력을 읽는다.

pub mod graph;
pub mod conflict;
pub mod diff;
pub mod log;
pub mod login;
pub mod patch;
pub mod refs;
pub mod remote;
pub mod repo;
pub mod runner;
pub mod settings;
pub mod ssl;
pub mod status;

pub use repo::{GitError, Repository};
pub use runner::{GitGlobals, GitRunner};
pub use settings::Settings;
