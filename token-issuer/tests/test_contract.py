"""Contract tests: every behaviour the widget and copasrv rely on (specs/token-service-login)."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import urllib.parse

import jwt
import pytest
from jwt import PyJWKSet

from conftest import FakeClock, running
from token_issuer.app import Issuer
from token_issuer.store import s256

ORIGIN = "http://localhost:5180"
AUD = "https://copa.example.com"
VERIFIER = "v" * 43


def login_id_of(html: str) -> str:
    return re.search(r'name="login_id" value="([^"]+)"', html).group(1)


def start(client, *, origin=ORIGIN, audience=AUD, verifier=VERIFIER, challenge=None):
    q = urllib.parse.urlencode({"audience": audience, "origin": origin, "challenge": s256(verifier) if challenge is None else challenge})
    return client.get_text(f"/login?{q}")


def sign_in(client, user="alice", password="alice", **kw):
    status, _h, html = start(client, **kw)
    assert status == 200, html
    lid = login_id_of(html)
    status, headers, page = client.post_form("/login/submit", {"login_id": lid, "user": user, "password": password, "action": "signin"})
    return lid, status, headers, page


def message_of(page: str) -> dict:
    return json.loads(re.search(r"const msg = (\{.*?\});", page).group(1))


def full_login(client, **kw):
    lid, status, _h, page = sign_in(client, **kw)
    assert status == 200, page
    return lid, message_of(page)["login_code"]


def exchange(client, code, verifier=VERIFIER, **kw):
    return client.post_json("/token", {"login_code": code, "verifier": verifier}, **kw)


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def svc(clock):
    with running(lambda s: Issuer(s, clock=clock)) as (app, client):
        yield app, client


# ---------------------------------------------------------------- popup page


def test_login_page_lists_users_and_is_hardened(svc):
    _app, client = svc
    status, headers, html = start(client)
    assert status == 200
    for uid in ("alice", "bob", "carol"):
        assert f'value="{uid}"' in html
    assert headers["X-Frame-Options"] == "DENY" and headers["Referrer-Policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    assert "no-store" in headers["Cache-Control"]


def test_audience_is_escaped_in_the_page(svc):
    _app, client = svc
    _s, _h, html = start(client, audience="<script>alert(1)</script>")
    assert "<script>alert" not in html and "&lt;script&gt;" in html


@pytest.mark.parametrize("origin", ["https://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil.com:80", ""])
def test_origin_outside_the_allow_list_cannot_start_a_login(svc, origin):
    _app, client = svc
    status, _h, html = start(client, origin=origin)
    assert status == 400 and "not allowed" in html and "login_id" not in html


def test_configured_allow_list_replaces_the_loopback_default():
    with running(allowed_origins=("https://app.example.com",)) as (_app, client):
        assert start(client, origin="https://app.example.com")[0] == 200
        assert start(client, origin=ORIGIN)[0] == 400


def test_audience_allow_list():
    with running(allowed_audiences=(AUD,)) as (_app, client):
        assert start(client)[0] == 200
        assert start(client, audience="https://other.example")[0] == 400


@pytest.mark.parametrize("challenge", ["", "short", "!" * 43, "a" * 44])
def test_challenge_must_be_a_valid_s256_value(svc, challenge):
    _app, client = svc
    assert start(client, challenge=challenge)[0] == 400


def test_result_page_posts_only_to_the_recorded_origin(svc):
    _app, client = svc
    _lid, status, headers, page = sign_in(client, origin="http://127.0.0.1:5999")
    assert status == 200
    assert 'postMessage(msg, "http://127.0.0.1:5999")' in page
    assert "postMessage(msg, '*')" not in page and '"*"' not in page
    msg = message_of(page)
    assert msg["type"] == "copa-login" and msg["login_code"] and msg["login_id"]
    assert "access_token" not in page and "refresh_token" not in page   # no tokens in the page
    assert "nonce-" in headers["Content-Security-Policy"]


def test_wrong_password_shows_the_form_again_and_issues_no_code(svc):
    _app, client = svc
    _lid, status, _h, page = sign_in(client, password="wrong")
    assert status == 401 and "Wrong user or password" in page and "login_code" not in page


def test_cancel_reports_cancelled_and_nothing_can_be_redeemed(svc):
    _app, client = svc
    _s, _h, html = start(client)
    lid = login_id_of(html)
    status, _h, page = client.post_form("/login/submit", {"login_id": lid, "action": "cancel"})
    msg = message_of(page)
    assert status == 200 and msg["type"] == "copa-login-error" and msg["error"] == "cancelled"
    assert client.post_json("/poll", {"verifier": VERIFIER})[1]["status"] == "denied"


# ---------------------------------------------------------------- token exchange


def test_exchange_returns_a_verifiable_token_pair(svc):
    app, client = svc
    _lid, code = full_login(client)
    status, body, headers = exchange(client, code)
    assert status == 200 and "no-store" in headers["Cache-Control"]
    assert body["token_type"] == "Bearer" and body["sub"] == "alice" and body["scope"] == "copa:team:rw"
    key = PyJWKSet.from_dict(client.get_json("/jwks.json")[1])[jwt.get_unverified_header(body["access_token"])["kid"]]
    claims = jwt.decode(body["access_token"], key.key, algorithms=["ES256"], audience=AUD,
                        issuer=app.settings.public_url, leeway=0, options={"verify_exp": False, "verify_nbf": False, "verify_iat": False})
    assert claims["aud"] == AUD and claims["groups"] == ["copa-team"]
    now_ms = app.clock() * 1000
    assert body["access_expires_at"] == now_ms + app.settings.access_ttl * 1000
    assert body["expires_in"] == app.settings.access_ttl
    assert body["refresh_expires_at"] == now_ms + app.settings.refresh_ttl * 1000


def test_refresh_token_is_opaque(svc):
    _app, client = svc
    _lid, code = full_login(client)
    body = exchange(client, code)[1]
    assert "." not in body["refresh_token"]


def test_a_user_without_a_scope_still_gets_tokens_with_an_empty_scope(svc):
    _app, client = svc
    _lid, code = full_login(client, user="carol", password="carol")
    assert exchange(client, code)[1]["scope"] == ""


def test_code_replay_is_refused(svc):
    _app, client = svc
    _lid, code = full_login(client)
    assert exchange(client, code)[0] == 200
    status, body, _ = exchange(client, code)
    assert status == 400 and body["error"] == "invalid_grant"


def test_wrong_verifier_is_refused_and_burns_the_code(svc):
    _app, client = svc
    _lid, code = full_login(client)
    status, body, _ = exchange(client, code, verifier="w" * 43)
    assert status == 400 and body["error"] == "invalid_grant"
    assert exchange(client, code)[0] == 400        # even the right verifier cannot rescue a stolen code


def test_unknown_code(svc):
    _app, client = svc
    assert exchange(client, "nope")[0] == 400


def test_code_expires_after_60_seconds(svc, clock):
    _app, client = svc
    _lid, code = full_login(client)
    clock.advance(61)
    assert exchange(client, code)[0] == 400


def test_login_expires_after_five_minutes(svc, clock):
    _app, client = svc
    _s, _h, html = start(client)
    clock.advance(301)
    status, _h, page = client.post_form("/login/submit", {"login_id": login_id_of(html), "user": "alice", "password": "alice"})
    assert status == 400 and "expired" in page


def test_a_login_can_only_be_finished_once(svc):
    _app, client = svc
    lid, status, _h, page = sign_in(client)
    assert status == 200
    first_code = message_of(page)["login_code"]
    again = client.post_form("/login/submit", {"login_id": lid, "user": "alice", "password": "alice", "action": "signin"})
    assert again[0] == 400 and "already finished" in again[2] and "login_code" not in again[2]
    assert exchange(client, first_code)[0] == 200      # the first code is unaffected


# ---------------------------------------------------------------- poll fallback


def test_poll_pending_then_ok_and_the_code_redeems(svc):
    _app, client = svc
    _s, _h, html = start(client)
    lid = login_id_of(html)
    # the widget polls with its verifier only: it does not know the login id when the opener link is gone
    assert client.post_json("/poll", {"verifier": VERIFIER})[1] == {"status": "pending", "detached": False}
    client.post_form("/login/submit", {"login_id": lid, "user": "bob", "password": "bob", "action": "signin"})
    status, body, _ = client.post_json("/poll", {"verifier": VERIFIER})
    assert status == 200 and body["status"] == "ok"
    token = exchange(client, body["login_code"])[1]
    assert token["sub"] == "bob" and token["scope"] == "copa:team:r"


def test_poll_reports_a_cancelled_login(svc):
    _app, client = svc
    _s, _h, html = start(client)
    client.post_form("/login/submit", {"login_id": login_id_of(html), "action": "cancel"})
    assert client.post_json("/poll", {"verifier": VERIFIER})[1] == {"status": "denied", "detached": False}


def test_poll_needs_the_matching_verifier(svc):
    _app, client = svc
    _s, _h, html = start(client)
    lid = login_id_of(html)
    client.post_form("/login/submit", {"login_id": lid, "user": "alice", "password": "alice", "action": "signin"})
    status, body, _ = client.post_json("/poll", {"verifier": "x" * 43})
    assert status == 400 and "login_code" not in json.dumps(body)       # someone else's verifier finds nothing
    assert client.post_json("/poll", {})[0] == 400
    assert client.post_json("/poll", {"login_id": lid})[0] == 400        # knowing the login id is not enough


def test_poll_does_not_cross_between_two_widgets(svc):
    _app, client = svc
    other = "o" * 43
    _s, _h, a = start(client, verifier=VERIFIER)
    _s, _h, b = start(client, verifier=other)
    client.post_form("/login/submit", {"login_id": login_id_of(a), "user": "alice", "password": "alice", "action": "signin"})
    assert client.post_json("/poll", {"verifier": VERIFIER})[1]["status"] == "ok"
    assert client.post_json("/poll", {"verifier": other})[1] == {"status": "pending", "detached": False}
    assert b


def test_a_popup_without_an_opener_tells_the_service_and_poll_reports_it(svc):
    _app, client = svc
    _s, headers, html = start(client)
    lid = login_id_of(html)
    # the page carries the script that reports a lost opener, allowed by its CSP nonce
    nonce = re.search(r"script-src 'nonce-([^']+)'", headers["Content-Security-Policy"]).group(1)
    assert f'<script nonce="{nonce}">' in html and "window.opener" in html and "/login/detached" in html
    assert "connect-src 'self'" in headers["Content-Security-Policy"]
    assert client.post_json("/poll", {"verifier": VERIFIER})[1]["detached"] is False
    assert client.post_json("/login/detached", {"login_id": lid})[0] == 200
    assert client.post_json("/poll", {"verifier": VERIFIER})[1]["detached"] is True


def test_detached_for_an_unknown_login_is_a_404(svc):
    _app, client = svc
    assert client.post_json("/login/detached", {"login_id": "nope"})[0] == 404
    assert client.post_json("/login/detached", {})[0] == 400


def test_poll_after_the_login_expired(svc, clock):
    _app, client = svc
    start(client)
    clock.advance(301)
    assert client.post_json("/poll", {"verifier": VERIFIER})[0] == 400


# ---------------------------------------------------------------- refresh / logout


def pair(client):
    _lid, code = full_login(client)
    return exchange(client, code)[1]


def refresh(client, token):
    return client.post_json("/refresh", {"refresh_token": token})


def test_refresh_rotates_both_tokens(svc, clock):
    _app, client = svc
    first = pair(client)
    clock.advance(30)
    status, second, _ = refresh(client, first["refresh_token"])
    assert status == 200 and second["refresh_token"] != first["refresh_token"]
    assert second["access_token"] != first["access_token"] and second["sub"] == "alice"
    assert second["access_expires_at"] > first["access_expires_at"]


def test_reusing_a_rotated_refresh_token_revokes_the_whole_session(svc):
    _app, client = svc
    first = pair(client)
    second = refresh(client, first["refresh_token"])[1]
    status, body, _ = refresh(client, first["refresh_token"])             # the old token comes back
    assert status == 400 and "reuse" in body["error_description"]
    assert refresh(client, second["refresh_token"])[0] == 400            # the legitimate holder is cut off too


def test_unknown_and_expired_refresh_tokens(svc, clock):
    app, client = svc
    assert refresh(client, "nope")[0] == 400
    first = pair(client)
    clock.advance(app.settings.refresh_ttl + 1)
    status, body, _ = refresh(client, first["refresh_token"])
    assert status == 400 and "expired" in body["error_description"]


def test_logout_revokes_the_session(svc):
    _app, client = svc
    first = pair(client)
    assert client.post_json("/logout", {"refresh_token": first["refresh_token"]})[0] == 200
    assert refresh(client, first["refresh_token"])[0] == 400


def test_logout_is_idempotent(svc):
    _app, client = svc
    assert client.post_json("/logout", {"refresh_token": "never-issued"})[:2] == (200, {"ok": True})


def test_sessions_are_independent(svc):
    _app, client = svc
    a, b = pair(client), pair(client)
    client.post_json("/logout", {"refresh_token": a["refresh_token"]})
    assert refresh(client, b["refresh_token"])[0] == 200


@pytest.mark.parametrize("path", ["/token", "/refresh", "/logout", "/poll"])
def test_malformed_bodies_are_400(svc, path):
    _app, client = svc
    assert client.post_json(path, {})[0] == 400
    assert client.post_json(path, [])[0] == 400


# ---------------------------------------------------------------- CORS


def test_preflight_for_an_allowed_origin(svc):
    _app, client = svc
    status, headers, _ = client.request("OPTIONS", "/token", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST"})
    assert status == 204 and headers["Access-Control-Allow-Origin"] == ORIGIN
    assert "content-type" in headers["Access-Control-Allow-Headers"].lower()


def test_preflight_for_a_foreign_origin_is_refused(svc):
    _app, client = svc
    status, headers, _ = client.request("OPTIONS", "/token", headers={"Origin": "https://evil.example"})
    assert status == 403 and "Access-Control-Allow-Origin" not in headers


def test_api_calls_from_foreign_origins_are_refused_even_with_a_valid_code(svc):
    _app, client = svc
    _lid, code = full_login(client)
    status, headers, _ = client.request("POST", "/token", {"login_code": code, "verifier": VERIFIER}, {"Origin": "https://evil.example"})
    assert status == 403 and "Access-Control-Allow-Origin" not in headers
    assert exchange(client, code)[0] == 200      # the refused request did not consume it


def test_cors_headers_on_success_and_on_errors(svc):
    _app, client = svc
    for body in ({"login_code": "bad", "verifier": VERIFIER}, {}):
        status, headers, _ = client.request("POST", "/token", body, {"Origin": ORIGIN})
        assert status == 400 and headers["Access-Control-Allow-Origin"] == ORIGIN     # browsers can read the error


def test_requests_without_an_origin_header_are_fine(svc):
    _app, client = svc
    assert client.post_json("/logout", {"refresh_token": "x"})[0] == 200


def test_public_documents_are_readable_from_any_origin(svc):
    _app, client = svc
    for path in ("/.well-known/copa-token-service", "/jwks.json"):
        assert client.get_json(path)[2]["Access-Control-Allow-Origin"] == "*"


# ---------------------------------------------------------------- redirect mode (full-page fallback)

HOST_PAGE = "http://localhost:5180/app/index.html?tab=1"
STATE = "st_" + "a" * 20


def start_redirect(client, *, redirect_uri=HOST_PAGE, state=STATE, verifier=VERIFIER, audience=AUD):
    q = urllib.parse.urlencode({"mode": "redirect", "audience": audience, "redirect_uri": redirect_uri,
                                "state": state, "challenge": s256(verifier)})
    return client.get_text(f"/login?{q}")


def no_follow(client, fields):
    """POST without following the redirect: returns (status, Location)."""
    import http.client

    host, port = client.base.replace("http://", "").split(":")
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    c.request("POST", "/login/submit", urllib.parse.urlencode(fields), {"Content-Type": "application/x-www-form-urlencoded"})
    r = c.getresponse()
    return r.status, r.getheader("Location"), r.read().decode()


def test_redirect_mode_sends_the_user_back_with_the_code_in_the_fragment(svc):
    _app, client = svc
    status, _h, html = start_redirect(client)
    assert status == 200
    status, location, body = no_follow(client, {"login_id": login_id_of(html), "user": "alice", "password": "alice", "action": "signin"})
    assert status == 303 and body == ""
    base, _, frag = location.partition("#")
    assert base == HOST_PAGE                                  # the host page, query kept, no fragment of ours in the path
    fields = dict(urllib.parse.parse_qsl(frag))
    assert fields["state"] == STATE and fields["copa_login_code"]
    assert "?" not in frag and "copa_login_code" not in base  # the code is never in the query string (it would reach servers)
    token = exchange(client, fields["copa_login_code"])[1]    # same verifier binding as the popup flow
    assert token["sub"] == "alice"


def test_redirect_mode_code_needs_the_verifier(svc):
    _app, client = svc
    _s, _h, html = start_redirect(client)
    _st, location, _b = no_follow(client, {"login_id": login_id_of(html), "user": "alice", "password": "alice", "action": "signin"})
    code = dict(urllib.parse.parse_qsl(location.partition("#")[2]))["copa_login_code"]
    assert exchange(client, code, verifier="w" * 43)[0] == 400


def test_redirect_mode_cancel_comes_back_with_an_error(svc):
    _app, client = svc
    _s, _h, html = start_redirect(client)
    status, location, _b = no_follow(client, {"login_id": login_id_of(html), "action": "cancel"})
    fields = dict(urllib.parse.parse_qsl(location.partition("#")[2]))
    assert status == 303 and fields == {"copa_login_error": "cancelled", "state": STATE}


def test_redirect_mode_wrong_password_stays_on_the_form(svc):
    _app, client = svc
    _s, _h, html = start_redirect(client)
    status, location, body = no_follow(client, {"login_id": login_id_of(html), "user": "alice", "password": "nope", "action": "signin"})
    assert status == 401 and location is None and "Wrong user or password" in body


@pytest.mark.parametrize("redirect_uri", [
    "https://evil.example/cb",                 # origin not allowed
    "http://localhost.evil.example/cb",
    "javascript:alert(1)",
    "ftp://localhost/x",
    "//localhost/x",
    "/relative",
    "",
    "http://user:pw@localhost:5180/cb",        # credentials in the URL
])
def test_redirect_mode_refuses_unsafe_redirect_uris(svc, redirect_uri):
    _app, client = svc
    status, _h, html = start_redirect(client, redirect_uri=redirect_uri)
    assert status == 400 and "login_id" not in html


@pytest.mark.parametrize("state", ["", "short", "has space in it!!", "x" * 129])
def test_redirect_mode_needs_a_sane_state(svc, state):
    _app, client = svc
    assert start_redirect(client, state=state)[0] == 400


def test_redirect_mode_cannot_smuggle_a_fragment_into_the_redirect_uri(svc):
    _app, client = svc
    _s, _h, html = start_redirect(client, redirect_uri="http://localhost:5180/cb#evil=1")
    _st, location, _b = no_follow(client, {"login_id": login_id_of(html), "user": "alice", "password": "alice", "action": "signin"})
    assert location.count("#") == 1 and "evil" not in location


def test_the_origin_in_redirect_mode_comes_from_the_redirect_uri_not_the_query(svc):
    _app, client = svc
    q = urllib.parse.urlencode({"mode": "redirect", "audience": AUD, "origin": "https://evil.example",
                                "redirect_uri": "http://localhost:5180/cb", "state": STATE, "challenge": s256(VERIFIER)})
    assert client.get_text(f"/login?{q}")[0] == 200   # the bogus `origin` is ignored; the redirect_uri's origin is what is checked


def test_popup_mode_is_unchanged(svc):
    _app, client = svc
    _lid, code = full_login(client)
    assert exchange(client, code)[0] == 200
