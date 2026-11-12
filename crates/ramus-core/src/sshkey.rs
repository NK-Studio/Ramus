//! SSH 키: `~/.ssh` 의 키 목록, 새 키 만들기, 고른 개인 키 읽기. 키 파일은 `ssh-keygen` 으로만 만들고, 이미 있는 파일은 덮어쓰지 않는다.
//! git 이 고른 키를 쓰게 하는 것은 환경 변수(`GIT_SSH_COMMAND`)로만 한다 — `~/.ssh/config`·`.gitconfig` 는 건드리지 않는다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::i18n::tr;
use crate::repo::{GitError, Result};

/// 새로 만드는 키의 기본 파일 이름.
const NEW_KEY_NAME: &str = "ramus_ed25519";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    /// 개인 키 파일.
    pub path: String,
    /// 파일 이름(id_ed25519 등).
    pub name: String,
    /// ed25519 · rsa · ecdsa …
    pub kind: String,
    pub comment: String,
    /// SHA256:… (ssh-keygen 이 없으면 빈 글).
    pub fingerprint: String,
    /// 공개 키 한 줄("ssh-ed25519 AAAA… 주석").
    pub public: String,
}

impl SshKey {
    /// GitHub 에 올린 키와 견줄 몸통("종류 base64"). 주석은 GitHub 가 지우므로 뺀다.
    pub fn body(&self) -> String {
        key_body(&self.public)
    }
}

/// 공개 키 줄에서 "종류 base64" 만.
pub fn key_body(line: &str) -> String {
    line.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

pub fn ssh_dir(home: &Path) -> PathBuf {
    home.join(".ssh")
}

/// `ssh-keygen` 실행 파일. PATH → 흔한 자리 → (Windows) 내장 git 의 것.
pub fn ssh_keygen() -> Option<PathBuf> {
    let name = if cfg!(windows) { "ssh-keygen.exe" } else { "ssh-keygen" };
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut dirs: Vec<PathBuf> = std::env::var("PATH").unwrap_or_default().split(sep).filter(|d| !d.is_empty()).map(PathBuf::from).collect();
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            dirs.push(PathBuf::from(root).join("System32").join("OpenSSH"));
        }
        if let Some(dir) = crate::gitbin::bundled_dir() {
            dirs.push(dir.join("usr").join("bin"));
        }
    } else {
        dirs.extend(["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn keygen(args: &[&str]) -> Result<String> {
    let program = ssh_keygen().ok_or_else(|| GitError::new(tr("ssh-keygen 을 찾지 못했습니다. OpenSSH 를 깔아 주세요.", "Couldn't find ssh-keygen. Install OpenSSH.")))?;
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::runner::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| GitError::new(crate::trf!("ssh-keygen 을 실행하지 못했습니다: {e}", "Couldn't run ssh-keygen: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(GitError::new(if err.is_empty() { tr("ssh-keygen 이 실패했습니다.", "ssh-keygen failed.").to_string() } else { format!("ssh-keygen: {err}") }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `ssh-keygen -lf` 한 줄("256 SHA256:abc 주석 (ED25519)")에서 (지문, 종류).
pub fn parse_fingerprint(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    let _bits = parts.next()?;
    let fingerprint = parts.next()?.to_string();
    let kind = line.trim_end().rsplit_once('(').and_then(|(_, k)| k.strip_suffix(')')).map(|k| k.to_ascii_lowercase()).unwrap_or_default();
    Some((fingerprint, kind))
}

/// 공개 키 줄의 종류 이름("ssh-ed25519" → "ed25519").
fn kind_of(line: &str) -> String {
    let t = line.split_whitespace().next().unwrap_or("");
    t.strip_prefix("ssh-").unwrap_or(t).split('-').next().unwrap_or(t).to_string()
}

/// 개인 키와 그 공개 키 줄로 SshKey 를 만든다.
fn describe(private: &Path, public_line: &str, public_file: Option<&Path>) -> SshKey {
    let line = public_line.trim().to_string();
    let comment = line.split_whitespace().skip(2).collect::<Vec<_>>().join(" ");
    let (fingerprint, kind) = public_file
        .and_then(|p| keygen(&["-lf", &p.display().to_string()]).ok())
        .and_then(|out| parse_fingerprint(out.lines().next().unwrap_or("")))
        .unwrap_or_else(|| (String::new(), String::new()));
    SshKey {
        path: private.display().to_string(),
        name: private.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        kind: if kind.is_empty() { kind_of(&line) } else { kind },
        comment,
        fingerprint,
        public: line,
    }
}

/// `~/.ssh` 의 키 쌍(X 와 X.pub 가 둘 다 있는 것), 이름 차례.
pub fn list(home: &Path) -> Vec<SshKey> {
    let Ok(entries) = std::fs::read_dir(ssh_dir(home)) else { return Vec::new() };
    let mut keys: Vec<SshKey> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pub"))
        .filter_map(|public| {
            let private = public.with_extension("");
            let line = std::fs::read_to_string(&public).ok()?;
            (private.is_file() && line.trim().starts_with(|c: char| c.is_ascii_alphabetic())).then(|| describe(&private, &line, Some(&public)))
        })
        .collect();
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    keys
}

/// 고른 개인 키. 공개 키는 `public`(없으면 옆의 `.pub`, 그것도 없으면 `ssh-keygen -y` 로 꺼낸다 — 암호가 걸렸으면 실패).
pub fn read(private: &Path, public: Option<&Path>) -> Result<SshKey> {
    if !private.is_file() {
        return Err(GitError::new(tr("개인 키 파일이 없습니다.", "The private key file doesn't exist.")));
    }
    let beside = PathBuf::from(format!("{}.pub", private.display()));
    let public = public.map(Path::to_path_buf).or_else(|| beside.is_file().then_some(beside));
    match public {
        Some(p) => {
            let line = std::fs::read_to_string(&p).map_err(|e| GitError::new(crate::trf!("공개 키를 읽지 못했습니다: {e}", "Couldn't read the public key: {e}")))?;
            Ok(describe(private, &line, Some(&p)))
        }
        None => {
            let line = keygen(&["-y", "-f", &private.display().to_string()]).map_err(|_| GitError::new(tr("공개 키(.pub)를 찾지 못했습니다. 공개 키 파일을 같이 골라 주세요.", "Couldn't find the public key (.pub). Choose the public key file as well.")))?;
            Ok(describe(private, &line, None))
        }
    }
}

/// 새 키에 쓸, 아직 없는 파일 이름(ramus_ed25519, ramus_ed25519_2, …).
pub fn free_name(dir: &Path) -> PathBuf {
    (1..)
        .map(|n| dir.join(if n == 1 { NEW_KEY_NAME.to_string() } else { format!("{NEW_KEY_NAME}_{n}") }))
        .find(|p| !p.exists() && !PathBuf::from(format!("{}.pub", p.display())).exists())
        .expect("끝없는 차례")
}

/// 암호 없는 ed25519 키를 새로 만든다. 이미 있는 파일은 건드리지 않는다.
pub fn generate(home: &Path, comment: &str) -> Result<SshKey> {
    let dir = ssh_dir(home);
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| GitError::new(crate::trf!(".ssh 폴더를 만들지 못했습니다: {e}", "Couldn't create the .ssh folder: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let path = free_name(&dir);
    keygen(&["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", &path.display().to_string()])?;
    read(&path, None)
}

/// git 이 이 개인 키만 쓰게 하는 환경 변수.
pub fn environment(private: &str) -> HashMap<String, String> {
    let path = private.replace('\\', "/").replace('"', "\\\"");
    HashMap::from([("GIT_SSH_COMMAND".to_string(), format!("ssh -i \"{path}\" -o IdentitiesOnly=yes"))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fingerprint_line() {
        let (fp, kind) = parse_fingerprint("256 SHA256:AbCdEf me@mac (ED25519)").unwrap();
        assert_eq!(fp, "SHA256:AbCdEf");
        assert_eq!(kind, "ed25519");
        let (_, kind) = parse_fingerprint("3072 SHA256:xyz no comment here (RSA)\n").unwrap();
        assert_eq!(kind, "rsa");
        assert!(parse_fingerprint("").is_none());
    }

    #[test]
    fn picks_free_name_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(free_name(dir.path()), dir.path().join("ramus_ed25519"));
        std::fs::write(dir.path().join("ramus_ed25519"), "x").unwrap();
        assert_eq!(free_name(dir.path()), dir.path().join("ramus_ed25519_2"));
        // 공개 키만 남아 있어도 그 이름은 피한다.
        std::fs::write(dir.path().join("ramus_ed25519_2.pub"), "x").unwrap();
        assert_eq!(free_name(dir.path()), dir.path().join("ramus_ed25519_3"));
    }

    #[test]
    fn lists_pairs_only() {
        let home = tempfile::tempdir().unwrap();
        let ssh = ssh_dir(home.path());
        std::fs::create_dir(&ssh).unwrap();
        std::fs::write(ssh.join("id_ed25519"), "private").unwrap();
        std::fs::write(ssh.join("id_ed25519.pub"), "ssh-ed25519 AAAAC3Nz me@mac\n").unwrap();
        std::fs::write(ssh.join("lonely.pub"), "ssh-rsa AAAAB3 x\n").unwrap();
        std::fs::write(ssh.join("known_hosts"), "github.com ssh-ed25519 AAAA\n").unwrap();
        let keys = list(home.path());
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].name, "id_ed25519");
        assert_eq!(keys[0].comment, "me@mac");
        assert_eq!(keys[0].body(), "ssh-ed25519 AAAAC3Nz");
    }

    #[test]
    fn kind_from_line() {
        assert_eq!(kind_of("ssh-ed25519 AAAA"), "ed25519");
        assert_eq!(kind_of("ecdsa-sha2-nistp256 AAAA"), "ecdsa");
    }

    #[test]
    fn ssh_command_quotes_path() {
        let env = environment(r"C:\Users\me\.ssh\id_ed25519");
        assert_eq!(env["GIT_SSH_COMMAND"], r#"ssh -i "C:/Users/me/.ssh/id_ed25519" -o IdentitiesOnly=yes"#);
    }
}
