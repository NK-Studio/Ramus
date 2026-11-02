//! 회사망처럼 SSL 을 가로채는 환경(보안 프록시가 자기 인증서로 다시 서명)에서 git 이 원격에 붙게 하는 설정.
//!
//! git 은 운영체제 인증서 저장소가 아니라 자기 CA 묶음을 보는 일이 많아(Git for Windows 의 OpenSSL, Homebrew git),
//! 회사 루트 인증서를 PC 에 깔아도 push·pull·fetch 가 "SSL certificate problem" 으로 실패한다.
//! 그래서 설정을 git 호출마다 `-c` 로 앞에 붙인다. `-c` 는 git 이 부르는 git-lfs·credential helper 에도 `GIT_CONFIG_PARAMETERS` 로 넘어간다.

use serde::{Deserialize, Serialize};

/// SSL·인증서 문제로 연결이 끊겼을 때 git·curl·git-lfs(Go) 가 남기는 글. 소문자로 비교한다.
const FAILURE_PATTERNS: &[&str] = &[
    "ssl certificate problem",
    "server certificate verification failed",
    "unable to get local issuer certificate",
    "self signed certificate",
    "self-signed certificate",
    "certificate verify failed",
    "certificate has expired",
    "x509: certificate",
    "tls: failed to verify certificate",
    // CA 인증서 파일 경로가 틀렸거나 읽을 수 없을 때.
    "error setting certificate verify locations",
    "problem with the ssl ca cert",
    // Windows schannel: 회사 인증서에 해지 목록 주소가 없거나 닿지 않을 때.
    "revocation function was unable to check revocation",
    "0x80092012",
    "0x80092013",
    "sec_e_untrusted_root",
    "schannel: next initializesecuritycontext failed",
    "schannel: sec_e",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SslSettings {
    /// false 면 인증서를 확인하지 않는다(`http.sslVerify=false`).
    pub verify: bool,
    /// 회사 루트 인증서가 든 PEM 파일. 비우면 git 기본값.
    pub ca_file: String,
    /// Windows: 운영체제 인증서 저장소를 쓴다(`http.sslBackend=schannel`).
    pub use_system_store: bool,
    /// Windows schannel: 해지 확인을 끈다(`http.schannelCheckRevoke=false`).
    pub skip_revocation_check: bool,
}

impl Default for SslSettings {
    fn default() -> Self {
        SslSettings { verify: true, ca_file: String::new(), use_system_store: false, skip_revocation_check: false }
    }
}

/// git 오류 글이 SSL·인증서 문제인가.
pub fn is_ssl_failure(message: &str) -> bool {
    let lower = message.to_lowercase();
    FAILURE_PATTERNS.iter().any(|p| lower.contains(p))
}

/// 설정 값으로 git 앞에 붙일 `-c` 인자를 만든다. `windows` 일 때만 schannel 설정을 붙인다(다른 git 은 schannel 을 모른다).
pub fn build_arguments(settings: &SslSettings, windows: bool) -> Vec<String> {
    let mut args = Vec::new();
    if !settings.verify {
        args.push("-c".into());
        args.push("http.sslVerify=false".into());
        return args;
    }
    if windows && settings.use_system_store {
        args.push("-c".into());
        args.push("http.sslBackend=schannel".into());
        if settings.skip_revocation_check {
            args.push("-c".into());
            args.push("http.schannelCheckRevoke=false".into());
        }
    } else if !settings.ca_file.trim().is_empty() {
        // schannel 은 CA 파일을 보지 않으므로 둘 중 하나만 붙인다.
        // git 은 Windows 에서도 슬래시 경로를 읽는다. 백슬래시는 설정 값에서 이스케이프로 읽힐 수 있어 바꾼다.
        args.push("-c".into());
        args.push(format!("http.sslCAInfo={}", settings.ca_file.trim().replace('\\', "/")));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(verify: bool, ca: &str, system: bool, skip: bool) -> SslSettings {
        SslSettings { verify, ca_file: ca.into(), use_system_store: system, skip_revocation_check: skip }
    }

    #[test]
    fn default_adds_nothing() {
        assert!(build_arguments(&SslSettings::default(), true).is_empty());
        assert!(build_arguments(&SslSettings::default(), false).is_empty());
    }

    #[test]
    fn verify_off_wins_over_everything() {
        assert_eq!(build_arguments(&s(false, "C:\\ca.pem", true, true), true), vec!["-c", "http.sslVerify=false"]);
    }

    #[test]
    fn schannel_only_on_windows() {
        assert_eq!(
            build_arguments(&s(true, "", true, true), true),
            vec!["-c", "http.sslBackend=schannel", "-c", "http.schannelCheckRevoke=false"]
        );
        assert!(build_arguments(&s(true, "", true, true), false).is_empty());
    }

    #[test]
    fn schannel_ignores_ca_file() {
        assert_eq!(build_arguments(&s(true, "/ca.pem", true, false), true), vec!["-c", "http.sslBackend=schannel"]);
    }

    #[test]
    fn ca_file_uses_forward_slashes() {
        assert_eq!(
            build_arguments(&s(true, "  C:\\certs\\company.pem ", false, false), true),
            vec!["-c", "http.sslCAInfo=C:/certs/company.pem"]
        );
        // macOS 에서는 schannel 을 골라도 CA 파일을 쓴다.
        assert_eq!(build_arguments(&s(true, "/ca.pem", true, false), false), vec!["-c", "http.sslCAInfo=/ca.pem"]);
    }

    #[test]
    fn detects_ssl_failures() {
        assert!(is_ssl_failure("fatal: unable to access 'https://x/': SSL certificate problem: unable to get local issuer certificate"));
        assert!(is_ssl_failure("schannel: next InitializeSecurityContext failed: SEC_E_UNTRUSTED_ROOT (0x80090325)"));
        assert!(is_ssl_failure("x509: certificate signed by unknown authority"));
        assert!(!is_ssl_failure("fatal: Authentication failed for 'https://x/'"));
        assert!(!is_ssl_failure(""));
    }
}
