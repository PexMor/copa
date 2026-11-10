"""HTML of the popup: sign-in form, result page, error page."""

from __future__ import annotations

import json
from html import escape

from .users import User

_BASE_STYLE = """
body{font:15px/1.5 system-ui,sans-serif;max-width:26rem;margin:2.5rem auto;padding:0 1rem}
label{display:block;margin:.8rem 0 .2rem;font-weight:600}
select,input{width:100%;padding:.45rem;box-sizing:border-box}
.row{display:flex;gap:.6rem;margin-top:1.2rem}
button{padding:.5rem 1rem;font:inherit;cursor:pointer}
button.primary{background:#2563eb;color:#fff;border:1px solid #2563eb;border-radius:6px}
.muted{color:#666;font-size:13px}
.err{color:#b00020}
"""


def _page(title: str, body: str, nonce: str | None = None, script: str = "") -> str:
    tag = f'<script nonce="{nonce}">{script}</script>' if script and nonce else ""
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{escape(title)}</title><style>{_BASE_STYLE}</style></head><body>{body}{tag}</body></html>"
    )


def login_page(login_id: str, audience: str, users: list[User], *, error: str | None = None, selected: str | None = None,
               nonce: str | None = None) -> str:
    options = "".join(
        f'<option value="{escape(u.id)}"{" selected" if u.id == selected else ""}>{escape(u.name)} ({escape(u.id)})</option>'
        for u in users
    )
    err = f'<p class="err" role="alert">{escape(error)}</p>' if error else ""
    body = f"""
<h1>Sign in</h1>
<p class="muted">to use <strong>{escape(audience)}</strong> — test token issuer</p>
{err}
<form method="post" action="/login/submit">
  <input type="hidden" name="login_id" value="{escape(login_id)}">
  <label for="user">User</label><select id="user" name="user">{options}</select>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="off">
  <div class="row"><button class="primary" type="submit" name="action" value="signin">Sign in</button>
  <button type="submit" name="action" value="cancel" formnovalidate>Cancel</button></div>
</form>
<p class="muted" id="detached" hidden>Keep this window open: the application continues automatically once you sign in.</p>"""
    # If the popup lost its opener (Cross-Origin-Opener-Policy), tell the service: the application
    # then knows that `popup.closed` is meaningless and relies on polling instead.
    script = f"""
if (!window.opener) {{
  document.getElementById('detached').hidden = false;
  fetch('/login/detached', {{method: 'POST', headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{login_id: {json.dumps(login_id)}}})}}).catch(function () {{}});
}}
"""
    return _page("Sign in", body, nonce, script)


def result_page(*, nonce: str, origin: str, message: dict, text: str) -> str:
    """Posts `message` to the opener (target origin = the one recorded at login start) and closes."""
    data = json.dumps(message).replace("<", "\\u003c")
    target = json.dumps(origin).replace("<", "\\u003c")
    script = f"""
const msg = {data};
try {{ if (window.opener) window.opener.postMessage(msg, {target}); }} catch (e) {{}}
setTimeout(function () {{ window.close(); }}, 50);
"""
    return _page("Signed in", f"<p>{escape(text)}</p><p class=\"muted\">You can close this window.</p>", nonce, script)


def error_page(title: str, text: str) -> str:
    return _page(title, f'<h1>{escape(title)}</h1><p class="err" role="alert">{escape(text)}</p>')
