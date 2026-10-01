/// Embedded fallback UI (used when `--static-dir` is not given)
use axum::{http::header, response::IntoResponse};

const HTML: &str = include_str!("../../web/ui.html");

const ICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="20" fill="#7c6af7"/>
<rect x="16" y="28" width="44" height="54" rx="8" fill="white" fill-opacity="0.28"/>
<rect x="28" y="20" width="44" height="58" rx="8" fill="white"/>
<rect x="40" y="15" width="20" height="11" rx="4" fill="white"/>
<rect x="37" y="36" width="28" height="5" rx="2.5" fill="#7c6af7"/>
<rect x="37" y="47" width="22" height="5" rx="2.5" fill="#7c6af7" opacity="0.55"/>
<rect x="37" y="58" width="25" height="5" rx="2.5" fill="#7c6af7" opacity="0.55"/>
</svg>"##;

const MANIFEST_JSON: &str = r##"{"name":"copa","short_name":"copa","description":"Clipboard over HTTP","start_url":"/","display":"standalone","background_color":"#0f1117","theme_color":"#7c6af7","permissions":["clipboard-read","clipboard-write"],"icons":[{"src":"/icon.svg","type":"image/svg+xml","sizes":"any","purpose":"any maskable"}]}"##;

pub async fn handler_ui() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], HTML)
}
pub async fn handler_icon() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/svg+xml"),
         (header::CACHE_CONTROL, "public, max-age=86400")],
        ICON_SVG,
    )
}
pub async fn handler_manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json"),
         (header::CACHE_CONTROL, "public, max-age=86400")],
        MANIFEST_JSON,
    )
}
