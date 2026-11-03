//! ui/ 폴더의 화면 파일을 모두 실행 파일에 묻는다. 파일을 더하거나 빼도 목록을 손으로 고치지 않게 빌드할 때 목록을 만든다.

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

fn main() {
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
}
