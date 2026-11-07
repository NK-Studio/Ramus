//! ui/ 폴더의 화면 파일을 모두 실행 파일에 묻는다. 파일을 더하거나 빼도 목록을 손으로 고치지 않게 빌드할 때 목록을 만든다.
//! Windows 에서는 실행 파일 아이콘(assets/icon/ramus.ico)도 리소스로 묻는다(macOS 는 scripts/bundle-macos.sh 가 .icns 를 번들에 넣는다).
//! 정보창에 보일 빌드 날짜(RAMUS_BUILD_DATE, UTC)와 git 커밋(RAMUS_GIT_HASH)도 여기서 환경 변수로 넘긴다.

use std::fmt::Write;
use std::path::{Path, PathBuf};

fn collect(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, base, out);
        } else if !path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
            out.push(path.strip_prefix(base).unwrap().to_path_buf());
        }
    }
}

/// 유닉스 시각(초) → "YYYY-MM-DD"(UTC). 날짜 크레이트 없이(Howard Hinnant 의 days→civil).
fn civil_date(secs: u64) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 정보창용 빌드 표식: 날짜는 SOURCE_DATE_EPOCH 가 있으면 그것(재현 빌드), 없으면 지금. 해시는 `git rev-parse` — 레포지토리 밖이면 "unknown".
fn build_stamp() {
    let secs = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    println!("cargo:rustc-env=RAMUS_BUILD_DATE={}", civil_date(secs));
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let git_dir = root.join(".git");
    if git_dir.exists() {
        println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
        println!("cargo:rerun-if-changed={}", git_dir.join("refs").display());
        println!("cargo:rerun-if-changed={}", git_dir.join("packed-refs").display());
    }
    let hash = std::process::Command::new("git")
        .args(["rev-parse", "--short=10", "HEAD"])
        .current_dir(&root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=RAMUS_GIT_HASH={hash}");
}

fn main() {
    build_stamp();
    let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui").canonicalize().expect("ui 폴더가 없습니다");
    println!("cargo:rerun-if-changed={}", ui.display());
    let mut files = Vec::new();
    collect(&ui, &ui, &mut files);
    files.sort();
    let mut code = String::from("pub const EMBEDDED: &[(&str, &[u8])] = &[\n");
    for file in &files {
        let name = file.to_string_lossy().replace('\\', "/");
        println!("cargo:rerun-if-changed={}", ui.join(file).display());
        writeln!(code, "    ({name:?}, include_bytes!({:?})),", ui.join(file).display().to_string()).unwrap();
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("assets_gen.rs");
    std::fs::write(out, code).unwrap();

    #[cfg(windows)]
    {
        let ico = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/icon/ramus.ico");
        println!("cargo:rerun-if-changed={}", ico.display());
        winresource::WindowsResource::new()
            .set_icon(ico.to_str().expect("아이콘 경로"))
            .compile()
            .expect("Windows 리소스(아이콘)를 묻지 못했습니다");
    }
}
