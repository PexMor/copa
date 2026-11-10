from __future__ import annotations

import json
from pathlib import Path

import jwt
import pytest
from jwt import PyJWKSet

from conftest import running
from token_issuer.keys import KeyStore
from token_issuer.tokens import access_claims, issue_access_token
from token_issuer.users import DEFAULT_USERS, User, Users, UsersError

ISS = "https://auth.example.com"
ALICE = User(id="alice", name="Alice", email="alice@example.com", groups=("copa-team",), scope="copa:team:rw")


def decode(token: str, jwks: dict, audience: str):
    key = PyJWKSet.from_dict(jwks)[jwt.get_unverified_header(token)["kid"]]
    return jwt.decode(token, key.key, algorithms=["ES256"], audience=audience, issuer=ISS)


def test_every_claim_and_the_header():
    keys = KeyStore(None)
    token, claims = issue_access_token(keys, issuer=ISS, user=ALICE, audience="https://copa.example.com", ttl=300, now=1_000_000)
    decoded = jwt.decode(token, options={
        "verify_signature": False, "verify_exp": False, "verify_aud": False, "verify_nbf": False, "verify_iat": False})
    assert decoded == claims
    assert claims["iss"] == ISS and claims["sub"] == "alice" and claims["aud"] == "https://copa.example.com"
    assert claims["email"] == "alice@example.com" and claims["name"] == "Alice"
    assert claims["groups"] == ["copa-team"] and claims["scope"] == "copa:team:rw"
    assert claims["iat"] == claims["nbf"] == 1_000_000 and claims["exp"] == 1_000_300
    header = jwt.get_unverified_header(token)
    assert header == {"alg": "ES256", "typ": "at+jwt", "kid": keys.active.kid}


def test_token_verifies_with_the_published_key_and_expires(monkeypatch):
    keys = KeyStore(None)
    token, _ = issue_access_token(keys, issuer=ISS, user=ALICE, audience="a", ttl=300)
    assert decode(token, keys.jwks(), "a")["sub"] == "alice"
    expired, _ = issue_access_token(keys, issuer=ISS, user=ALICE, audience="a", ttl=300, now=1_000)
    with pytest.raises(jwt.ExpiredSignatureError):
        decode(expired, keys.jwks(), "a")


def test_wrong_audience_is_detectable():
    keys = KeyStore(None)
    token, _ = issue_access_token(keys, issuer=ISS, user=ALICE, audience="a", ttl=300)
    with pytest.raises(jwt.InvalidAudienceError):
        decode(token, keys.jwks(), "other")


def test_jti_is_unique_per_token():
    ids = {access_claims(issuer=ISS, user=ALICE, audience="a", ttl=60)["jti"] for _ in range(50)}
    assert len(ids) == 50


def test_ttl_is_configurable():
    for ttl in (5, 900):
        c = access_claims(issuer=ISS, user=ALICE, audience="a", ttl=ttl, now=100)
        assert c["exp"] - c["iat"] == ttl


def test_extra_user_claims_are_copied_but_cannot_override_registered_ones():
    u = User(id="x", name="X", email="x@e", scope="s", claims={"tenant": "t1", "sub": "evil", "exp": 1, "scope": "evil"})
    c = access_claims(issuer=ISS, user=u, audience="a", ttl=60, now=100)
    assert c["tenant"] == "t1" and c["sub"] == "x" and c["exp"] == 160 and c["scope"] == "s"


def test_user_without_scope_has_an_empty_scope_claim():
    carol = Users.load(None).get("carol")
    c = access_claims(issuer=ISS, user=carol, audience="a", ttl=60)
    assert c["scope"] == "" and c["groups"] == []


class TestUsers:
    def test_example_file_and_builtin_defaults_are_identical(self):
        example = json.loads((Path(__file__).parent.parent / "users.example.json").read_text())
        assert example == DEFAULT_USERS

    def test_loads_the_example_file(self):
        users = Users.load(Path(__file__).parent.parent / "users.example.json")
        assert [u.id for u in users.all()] == ["alice", "bob", "carol"]
        assert users.get("bob").scope == "copa:team:r"

    def test_password_check(self):
        alice = Users.load(None).get("alice")
        assert alice.check_password("alice") and not alice.check_password("nope") and not alice.check_password(None)
        assert User(id="n", name="n", email="n").check_password(None)  # no password configured: pick-a-user

    @pytest.mark.parametrize("data,message", [
        ([], "users file must be"),
        ({"users": []}, "at least one user"),
        ({"users": [1]}, "must be an object"),
        ({"users": [{"name": "x"}]}, "id must be"),
        ({"users": [{"id": "a"}, {"id": "a"}]}, "duplicate id"),
        ({"users": [{"id": "a", "groups": "g"}]}, "groups must be"),
        ({"users": [{"id": "a", "scope": 5}]}, "scope must be"),
        ({"users": [{"id": "a", "password": 5}]}, "password must be"),
        ({"users": [{"id": "a", "claims": []}]}, "claims must be"),
    ])
    def test_invalid_files_are_rejected_with_a_reason(self, data, message):
        with pytest.raises(UsersError, match=message):
            Users.from_dict(data)

    def test_scope_may_be_a_list(self):
        assert Users.from_dict({"users": [{"id": "a", "scope": ["x", "y"]}]}).get("a").scope == "x y"

    def test_broken_json_file(self, tmp_path):
        p = tmp_path / "u.json"
        p.write_text("{nope")
        with pytest.raises(UsersError, match="not valid JSON"):
            Users.load(p)


def test_app_loads_users_from_the_configured_file(tmp_path):
    f = tmp_path / "u.json"
    f.write_text(json.dumps({"users": [{"id": "zed", "scope": "copa:z:rw"}]}))
    with running(users_file=f) as (app, _client):
        assert [u.id for u in app.users.all()] == ["zed"]
