from __future__ import annotations

import os
import stat

import jwt
import pytest
from jwt import PyJWKSet

from conftest import running
from token_issuer.app import DISCOVERY_PATH
from token_issuer.keys import KeyError_, KeyStore


def sign(store: KeyStore, claims: dict) -> str:
    return jwt.encode(claims, store.active.private, algorithm="ES256", headers={"kid": store.active.kid})


def verify(token: str, jwks: dict) -> dict:
    key = PyJWKSet.from_dict(jwks)[jwt.get_unverified_header(token)["kid"]]
    return jwt.decode(token, key.key, algorithms=["ES256"], options={"verify_aud": False})


def test_discovery_document_matches_the_contract(served):
    app, client = served
    status, doc, headers = client.get_json(DISCOVERY_PATH)
    base = app.settings.public_url
    assert status == 200
    assert doc == {
        "issuer": base, "jwks_uri": f"{base}/jwks.json", "login_url": f"{base}/login", "poll_url": f"{base}/poll",
        "token_url": f"{base}/token", "refresh_url": f"{base}/refresh", "logout_url": f"{base}/logout",
    }
    assert headers["Cache-Control"] == "no-cache"


def test_discovery_uses_the_configured_public_url():
    from token_issuer.app import discovery_document

    doc = discovery_document("https://auth.example.com")
    assert doc["issuer"] == "https://auth.example.com"
    assert doc["login_url"] == "https://auth.example.com/login"
    assert doc["jwks_uri"] == "https://auth.example.com/jwks.json"


def test_jwks_publishes_only_public_material(served):
    app, client = served
    status, jwks, headers = client.get_json("/jwks.json")
    assert status == 200 and len(jwks["keys"]) == 1
    k = jwks["keys"][0]
    assert {"kty": "EC", "crv": "P-256", "use": "sig", "alg": "ES256"}.items() <= k.items()
    assert "d" not in k and k["kid"] == app.keys.active.kid
    assert "max-age" in headers["Cache-Control"]


def test_tokens_verify_against_the_published_jwks(served):
    app, client = served
    token = sign(app.keys, {"sub": "u1"})
    _s, jwks, _h = client.get_json("/jwks.json")
    assert verify(token, jwks)["sub"] == "u1"


def test_keys_persist_across_restarts_with_private_permissions(tmp_path):
    first = KeyStore(tmp_path)
    kid = first.active.kid
    again = KeyStore(tmp_path)
    assert again.active.kid == kid
    pem = tmp_path / f"{kid}.pem"
    assert stat.S_IMODE(os.stat(pem).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(tmp_path / "keys.json").st_mode) == 0o600
    token = sign(first, {"sub": "x"})
    assert verify(token, again.jwks())["sub"] == "x"


def test_ephemeral_store_writes_nothing(tmp_path):
    store = KeyStore(None)
    assert store.active.kid
    assert list(tmp_path.iterdir()) == []


def test_rotation_overlaps_old_and_new_keys():
    store = KeyStore(None)
    old_token = sign(store, {"sub": "before"})
    old_kid = store.active.kid
    new = store.rotate()
    assert store.active.kid == new.kid != old_kid
    jwks = store.jwks()
    assert {k["kid"] for k in jwks["keys"]} == {old_kid, new.kid}
    assert verify(old_token, jwks)["sub"] == "before"      # old tokens still verify during the overlap
    assert verify(sign(store, {"sub": "after"}), jwks)["sub"] == "after"


def test_retiring_removes_the_key_but_never_the_active_one():
    store = KeyStore(None)
    old = store.active.kid
    new = store.rotate().kid
    with pytest.raises(KeyError_):
        store.retire(new)
    store.retire(old)
    assert [k["kid"] for k in store.jwks()["keys"]] == [new]
    with pytest.raises(KeyError_):
        store.retire(old)


def test_retired_state_survives_restart(tmp_path):
    store = KeyStore(tmp_path)
    old = store.active.kid
    store.rotate()
    store.retire(old)
    assert old not in {k["kid"] for k in KeyStore(tmp_path).jwks()["keys"]}


def test_kids_are_thumbprints_and_unique():
    store = KeyStore(None)
    kids = {store.active.kid, store.rotate().kid, store.rotate().kid}
    assert len(kids) == 3
    assert all(len(k) == 43 for k in kids)  # base64url sha-256


class TestAdmin:
    def test_endpoints_do_not_exist_without_an_admin_token(self, served):
        _app, client = served
        assert client.post_json("/admin/rotate-key")[0] == 404

    def test_rotation_over_http_needs_the_token(self):
        with running(admin_token="s3cret") as (app, client):
            assert client.post_json("/admin/rotate-key")[0] == 401
            assert client.post_json("/admin/rotate-key", headers={"Authorization": "Bearer wrong"})[0] == 401
            status, body, _ = client.post_json("/admin/rotate-key", headers={"Authorization": "Bearer s3cret"})
            assert status == 200 and body["kid"] == app.keys.active.kid
            assert len(client.get_json("/jwks.json")[1]["keys"]) == 2

    def test_retire_over_http(self):
        with running(admin_token="s3cret") as (app, client):
            auth = {"Authorization": "Bearer s3cret"}
            old = app.keys.active.kid
            client.post_json("/admin/rotate-key", headers=auth)
            assert client.post_json("/admin/retire-key", {"kid": old}, headers=auth)[0] == 200
            assert [k["kid"] for k in client.get_json("/jwks.json")[1]["keys"]] == [app.keys.active.kid]
            assert client.post_json("/admin/retire-key", {"kid": app.keys.active.kid}, headers=auth)[0] == 409
            assert client.post_json("/admin/retire-key", {}, headers=auth)[0] == 400
