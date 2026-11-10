/**
 * Widget styles. Everything is scoped under `.copa-share`. Hosts theme it with
 * these public CSS custom properties (set on the element or any ancestor; they
 * cross the shadow boundary). Internally they are read as `--c-*` with the
 * built-in default as fallback, so the widget's own theme never overrides them:
 *   --copa-accent, --copa-bg, --copa-fg, --copa-muted, --copa-border,
 *   --copa-error, --copa-radius, --copa-font
 */
export const CSS = `
.copa-share{
  --c-accent:var(--copa-accent,#2563eb);--c-bg:var(--copa-bg,#ffffff);--c-fg:var(--copa-fg,#1f2328);--c-muted:var(--copa-muted,#656d76);
  --c-border:var(--copa-border,#d0d7de);--c-error:var(--copa-error,#cf222e);--c-ok:var(--copa-ok,#1a7f37);--c-radius:var(--copa-radius,8px);
  --c-font:var(--copa-font,system-ui,-apple-system,"Segoe UI",sans-serif);
  all:initial;display:block;box-sizing:border-box;font:14px/1.45 var(--c-font);
  color:var(--c-fg);background:var(--c-bg);border:1px solid var(--c-border);
  border-radius:var(--c-radius);padding:12px;
}
.copa-share[data-theme="dark"]{--c-bg:var(--copa-bg,#0d1117);--c-fg:var(--copa-fg,#e6edf3);--c-muted:var(--copa-muted,#8d96a0);--c-border:var(--copa-border,#30363d);--c-error:var(--copa-error,#ff7b72);--c-ok:var(--copa-ok,#3fb950)}
@media (prefers-color-scheme:dark){.copa-share[data-theme="auto"]{--c-bg:var(--copa-bg,#0d1117);--c-fg:var(--copa-fg,#e6edf3);--c-muted:var(--copa-muted,#8d96a0);--c-border:var(--copa-border,#30363d);--c-error:var(--copa-error,#ff7b72);--c-ok:var(--copa-ok,#3fb950)}}
.copa-share *{box-sizing:border-box;font-family:inherit}
.copa-share button{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 12px;border-radius:calc(var(--c-radius) - 2px);
  border:1px solid var(--c-border);background:var(--c-bg);color:var(--c-fg);font:inherit;line-height:1.3}
.copa-share button.primary{background:var(--c-accent);border-color:var(--c-accent);color:#fff}
.copa-share button:disabled{opacity:.5;cursor:not-allowed}
.copa-share button:focus-visible,.copa-share textarea:focus-visible,.copa-share select:focus-visible{outline:2px solid var(--c-accent);outline-offset:1px}
.copa-share textarea,.copa-share select{all:unset;box-sizing:border-box;display:block;width:100%;border:1px solid var(--c-border);
  border-radius:calc(var(--c-radius) - 2px);padding:6px 8px;background:var(--c-bg);color:var(--c-fg);font:inherit}
.copa-share select{width:auto;cursor:pointer}
.copa-share textarea{min-height:5.5em;resize:vertical;white-space:pre-wrap}
.copa-share .copa-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
.copa-share .copa-spacer{flex:1}
.copa-share .copa-muted{color:var(--c-muted);font-size:12px}
.copa-share .copa-error{color:var(--c-error)}
.copa-share .copa-ok{color:var(--c-ok)}
.copa-share .copa-drop{border:2px dashed var(--c-border);border-radius:var(--c-radius);padding:14px;text-align:center;color:var(--c-muted)}
.copa-share .copa-drop[data-over="true"]{border-color:var(--c-accent);color:var(--c-fg)}
.copa-share progress{width:100%;height:6px}
.copa-share ul{list-style:none;margin:0;padding:0}
.copa-share li.copa-item{border-top:1px solid var(--c-border);padding:8px 0}
.copa-share .copa-preview{margin:4px 0;max-height:9em;overflow:auto;white-space:pre-wrap;word-break:break-word;
  background:color-mix(in srgb,var(--c-fg) 5%,transparent);border-radius:4px;padding:4px 6px;font:12px/1.4 ui-monospace,monospace}
.copa-share img.copa-thumb{display:block;max-width:100%;max-height:140px;border-radius:4px;margin:4px 0}
.copa-share a{color:var(--c-accent)}
.copa-share .copa-config-error{color:var(--c-error)}
.copa-share .copa-qr{width:140px;max-width:100%;background:#fff;border-radius:4px;margin:6px 0}
.copa-share .copa-qr svg{display:block;width:100%;height:auto}
.copa-share input.copa-input{all:unset;box-sizing:border-box;flex:1;min-width:8em;border:1px solid var(--c-border);border-radius:calc(var(--c-radius) - 2px);padding:6px 8px;background:var(--c-bg);color:var(--c-fg);font:inherit;letter-spacing:.04em}
`;
