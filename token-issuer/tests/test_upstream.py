from __future__ import annotations

import http.client
import json
import re
import urllib.parse

import jwt
import pytest

from conftest import running
from mock_oidc import MockOidc
from test_contract import AUD, ORIGIN, VERIFIER, exchange, message_of
from token_issuer.config import Settings, build_parser, settings_from_args
from token_issuer.store import s256
from token_issuer.upstream import MapRule, UpstreamConfig, load_rules, map_scope, user_from_claims

RULES = (
    MapRule("email", "*@example.com", "copa:team:r"),
    MapRule("groups", "admins", "copa:team:rw copa:admin:rw"),
    MapRule("groups", "ops", "copa:ops:rw"),
)


@pytest.fixture
def idp():
    m = MockOidc().start()
    yield m
    m.stop()


def issuer_with(idp, **kw):
    cfg = UpstreamConfig(issuer=idp.issuer, client_id=idp.client_id, client_secret=idp.client_secret, rules=RULES, **kw)
    return running(upstream=cfg)


def login_url():
    q = urllib.parse.urlencode({"audience": AUD, "origin": ORIGIN, "challenge": s256(VERIFIER)})
    return f"/login?{q}"


def claims_of(token):
    return jwt.decode(token, options={"verify_signature": False, "verify_exp": False, "verify_aud": False,
                                      "verify_nbf": False, "verify_iat": False})


# ---------------------------------------------------------------- mapping


@pytest.mark.parametrize("claims,expected", [
    ({"email": "a@example.com"}, "copa:team:r"),
    ({"email": "a@other.org"}, ""),
    ({"email": "a@example.com", "groups": ["admins"]}, "copa:team:r copa:team:rw copa:admin:rw"),
    ({"groups": ["ops", "admins"]}, "copa:team:rw copa:admin:rw copa:ops:rw"),
    ({"groups": "admins"}, "copa:team:rw copa:admin:rw"),               # string claim
    ({"groups": ["Admins"]}, ""),                                       # case-sensitive
    ({}, ""),
    ({"email": 5}, ""),
])
def test_map_scope(claims, expected):
    assert map_scope(claims, RULES) == expected


def test_scope_union_has_no_duplicates():
    rules = (MapRule("a", "x", "s1 s2"), MapRule("b", "y", "s2 s3"))
    assert map_scope({"a": "x", "b": "y"}, rules) == "s1 s2 s3"


def test_user_from_claims():
    cfg = UpstreamConfig("https://i", "c", "s", rules=RULES)
    u = user_from_claims({"sub": "9", "email": "z@example.com", "preferred_username": "zed", "groups": ["ops"]}, cfg)
    assert (u.id, u.name, u.email, u.groups, u.scope) == ("9", "zed", "z@example.com", ("ops",), "copa:team:r copa:ops:rw")


def test_load_rules_validation(tmp_path):
    ok = tmp_path / "ok.json"
    ok.write_text(json.dumps({"rules": [{"claim": "groups", "value": "g", "scope": "s"}]}))
    assert load_rules(ok) == (MapRule("groups", "g", "s"),)
    assert load_rules(None) == ()
    for bad in ({}, {"rules": "x"}, {"rules": [{"claim": "a"}]}, {"rules": [1]}):
        p = tmp_path / "bad.json"
        p.write_text(json.dumps(bad))
        with pytest.raises(ValueError):
            load_rules(p)


def test_secret_is_never_in_the_repr():
    assert "s3cret" not in repr(UpstreamConfig("https://i", "c", "s3cret"))


# ---------------------------------------------------------------- the flow


def no_redirect_get(base: str, path: str):
    host, port = base.replace("http://", "").split(":")
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    c.request("GET", path)
    r = c.getresponse()
    return r.status, dict(r.getheaders()), r.read().decode()


def test_login_redirects_to_the_provider_with_state_nonce_and_pkce(idp):
    with issuer_with(idp) as (app, client):
        status, headers, _ = no_redirect_get(client.base, login_url())
        assert status == 302
        u = urllib.parse.urlsplit(headers["Location"])
        q = {k: v[-1] for k, v in urllib.parse.parse_qs(u.query).items()}
        assert u.path == "/authorize" and q["response_type"] == "code" and q["client_id"] == idp.client_id
        assert q["redirect_uri"] == f"{app.settings.public_url}/login/callback"
        assert q["code_challenge_method"] == "S256" and len(q["code_challenge"]) == 43
        assert q["nonce"] and q["state"] and q["scope"] == "openid email profile"
        assert "client_secret" not in headers["Location"]          # the secret goes only to the token endpoint


def test_full_login_through_the_provider_issues_a_token_with_mapped_claims(idp):
    with issuer_with(idp) as (app, client):
        status, _h, html = client.get_text(login_url())             # follows authorize -> callback
        assert status == 200, html
        msg = message_of(html)
        assert msg["type"] == "copa-login"
        token = exchange(client, msg["login_code"])[1]
        claims = claims_of(token["access_token"])
        assert claims["sub"] == "u-123" and claims["email"] == "dana@example.com" and claims["name"] == "Dana"
        assert claims["groups"] == ["admins"] and claims["aud"] == AUD and claims["iss"] == app.settings.public_url
        assert claims["scope"] == "copa:team:r copa:team:rw copa:admin:rw"
        assert token["scope"] == claims["scope"]
        assert "upstream-access" not in html and "id_token" not in html          # provider tokens never reach the widget


def test_refresh_keeps_working_for_upstream_users(idp):
    with issuer_with(idp) as (_app, client):
        msg = message_of(client.get_text(login_url())[2])
        pair = exchange(client, msg["login_code"])[1]
        again = client.post_json("/refresh", {"refresh_token": pair["refresh_token"]})
        assert again[0] == 200 and claims_of(again[1]["access_token"])["sub"] == "u-123"


def test_the_fake_user_form_is_disabled_in_upstream_mode(idp):
    with issuer_with(idp) as (_app, client):
        status, _h, _b = client.post_form("/login/submit", {"login_id": "x", "user": "alice", "password": "alice", "action": "signin"})
        assert status == 404


def test_provider_denial_is_reported_to_the_opener(idp):
    idp.deny = True
    with issuer_with(idp) as (_app, client):
        html = client.get_text(login_url())[2]
        msg = message_of(html)
        assert msg["type"] == "copa-login-error" and msg["error"] == "access_denied"
        assert client.post_json("/poll", {"verifier": VERIFIER})[1]["status"] == "denied"


@pytest.mark.parametrize("tamper", ["nonce", "aud", "exp", "iss", "sig"])
def test_an_invalid_id_token_is_rejected_and_no_code_is_issued(idp, tamper):
    idp.tamper = tamper
    with issuer_with(idp) as (_app, client):
        status, _h, html = client.get_text(login_url())
        assert status == 502 and "Cannot sign in" in html and "login_code" not in html


def test_wrong_client_secret_fails_cleanly_without_leaking_it(idp):
    cfg = UpstreamConfig(issuer=idp.issuer, client_id=idp.client_id, client_secret="WRONG-secret-value", rules=RULES)
    with running(upstream=cfg) as (_app, client):
        status, _h, html = client.get_text(login_url())
        assert status == 502 and "refused the code" in html and "WRONG-secret-value" not in html


def test_unreachable_provider(idp):
    cfg = UpstreamConfig(issuer="http://127.0.0.1:9", client_id="c", client_secret="s")
    with running(upstream=cfg) as (_app, client):
        status, _h, html = client.get_text(login_url())
        assert status == 502 and "cannot reach" in html


def test_callback_cannot_be_replayed(idp):
    with issuer_with(idp) as (app, client):
        status, headers, _ = no_redirect_get(client.base, login_url())
        auth = urllib.parse.urlsplit(headers["Location"])
        host_status, h2, _ = no_redirect_get(idp.issuer, auth.path + "?" + auth.query)
        callback = h2["Location"]
        path = callback.replace(app.settings.public_url, "")
        first = no_redirect_get(client.base, path)
        assert first[0] == 200 and "copa-login" in first[2]
        second = no_redirect_get(client.base, path)
        assert second[0] in (400, 502) and "login_code" not in second[2]


def test_callback_with_an_unknown_state(idp):
    with issuer_with(idp) as (_app, client):
        status, _h, html = client.get_text("/login/callback?code=x&state=nope")
        assert status == 400 and "expired" in html


def test_callback_does_not_exist_without_an_upstream():
    with running() as (_app, client):
        assert client.get_text("/login/callback?code=x&state=y")[0] == 404


# ---------------------------------------------------------------- command line


def test_cli_needs_all_upstream_options(monkeypatch):
    monkeypatch.delenv("TOKEN_ISSUER_UPSTREAM_CLIENT_SECRET", raising=False)
    with pytest.raises(SystemExit):
        settings_from_args(build_parser().parse_args(["--upstream-issuer", "https://idp"]))


def test_cli_upstream_settings_with_the_secret_from_the_environment(monkeypatch, tmp_path):
    rules = tmp_path / "m.json"
    rules.write_text(json.dumps({"rules": [{"claim": "email", "value": "a@b", "scope": "x"}]}))
    monkeypatch.setenv("TOKEN_ISSUER_UPSTREAM_CLIENT_SECRET", "from-env")
    s = settings_from_args(build_parser().parse_args([
        "--upstream-issuer", "https://idp", "--upstream-client-id", "cid", "--upstream-map-file", str(rules)]))
    assert s.upstream.client_secret == "from-env" and s.upstream.rules == (MapRule("email", "a@b", "x"),)
    assert settings_from_args(build_parser().parse_args([])).upstream is None
