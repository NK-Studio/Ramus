//! 화면 파일(ui/)을 웹뷰에 준다. 보통은 실행 파일에 묻어 둔 것을, `RAMUS_UI_DIR` 이 있으면 그 폴더의 파일을 바로 읽는다
//! (화면을 고치며 앱을 다시 빌드하지 않고 새로고침만 하려고).

use std::borrow::Cow;

use wry::http::{Request, Response, header::CONTENT_TYPE};

include!(concat!(env!("OUT_DIR"), "/assets_gen.rs"));

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn respond(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    // 폴더를 벗어나는 경로는 받지 않는다.
    let body: Option<Cow<'static, [u8]>> = if path.contains("..") {
        None
    } else if let Some(dir) = std::env::var_os("RAMUS_UI_DIR") {
        std::fs::read(std::path::Path::new(&dir).join(path)).ok().map(Cow::Owned)
    } else {
        EMBEDDED.iter().find(|(name, _)| *name == path).map(|(_, bytes)| Cow::Borrowed(*bytes))
    };
    match body {
        Some(body) => Response::builder()
            .header(CONTENT_TYPE, mime(path))
            .header("Cache-Control", "no-store")
            .body(body)
            .unwrap(),
        None => Response::builder().status(404).body(Cow::Borrowed(&b"not found"[..])).unwrap(),
    }
}
