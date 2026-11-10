"""Each fault switch must produce exactly the documented token or behaviour."""

from __future__ import annotations

import time

import jwt
import pytest
from jwt import PyJWKSet

from conftest import FakeClock, running
from test_contract import AUD, ORIGIN, VERIFIER, exchange, full_login, sign_in, start
from token_issuer.app import Issuer
from token_issuer.config import build_parser, settings_from_args
from token_issuer.faults import FaultError, Faults, KNOWN


def resource_server_verify(token: str, jwks: dict, issuer: str, audience: str = AUD) -> dict:
    """What copasrv does: allow-listed algorithm, key by kid from the JWKS, iss/aud/exp checks."""
    kid = jwt.get_unverified_header(token).get("kid")
    key = PyJWKSet.from_dict(jwks)[kid]            # KeyError for an unknown kid
    return jwt.decode(token, key.key, algorithms=["ES256"], audience=audience, issuer=issuer, leeway=0,
                      options={"require": ["exp", "iss", "aud"]})


def token_with(faults, clock=None, **settings):
    clock = clock or FakeClock()
    with running(lambda s: Issuer(s, clock=clock), faults=tuple(faults), **settings) as (app, client):
        _lid, code = full_login(client)
        body = exchange(client, code)[1]
        jwks = client.get_json("/jwks.json")[1]
        return body["access_token"], jwks, app.settings.public_url, clock


def test_baseline_without_faults_verifies_strictly():
    token, jwks, iss, clock = token_with([])
    # the issuer's fake clock is far in the future: verify with the real clock disabled
    claims = jwt.decode(token, PyJWKSet.from_dict(jwks)[jwt.get_unverified_header(token)["kid"]].key,
                        algorithms=["ES256"], audience=AUD, issuer=iss, options={"verify_exp": False, "verify_nbf": False, "verify_iat": False})
    assert claims["sub"] == "alice"


# For the rest, run the issuer on the real clock so strict verification is meaningful.
def real(faults, **settings):
    return token_with(faults, clock=time.time, **settings)


def test_baseline_real_clock():
    token, jwks, iss, _ = real([])
    assert resource_server_verify(token, jwks, iss)["sub"] == "alice"


@pytest.mark.parametrize("fault,exception", [
    ("expired-token", jwt.ExpiredSignatureError),
    ("wrong-audience", jwt.InvalidAudienceError),
    ("wrong-issuer", jwt.InvalidIssuerError),
    ("bad-signature", jwt.InvalidSignatureError),
    ("alg-none", jwt.InvalidAlgorithmError),
    ("hs256-confusion", jwt.InvalidAlgorithmError),
    ("unknown-kid", KeyError),
])
def test_the_resource_server_must_reject(fault, exception):
    token, jwks, iss, _ = real([fault])
    with pytest.raises(exception):
        resource_server_verify(token, jwks, iss)


def test_alg_none_token_really_is_unsigned():
    token, *_ = real(["alg-none"])
    assert token.endswith(".") and jwt.get_unverified_header(token)["alg"] == "none"


def test_hs256_confusion_token_uses_hs256_and_the_active_kid():
    token, jwks, *_ = real(["hs256-confusion"])
    h = jwt.get_unverified_header(token)
    assert h["alg"] == "HS256" and h["kid"] == jwks["keys"][0]["kid"]


def test_unknown_kid_is_not_in_the_jwks():
    token, jwks, *_ = real(["unknown-kid"])
    assert jwt.get_unverified_header(token)["kid"] not in {k["kid"] for k in jwks["keys"]}


def test_claim_faults_keep_a_valid_signature():
    # only the claim is wrong, so a verifier that skips the claim check would (wrongly) accept it
    for fault in ("expired-token", "wrong-audience", "wrong-issuer"):
        token, jwks, iss, _ = real([fault])
        key = PyJWKSet.from_dict(jwks)[jwt.get_unverified_header(token)["kid"]].key
        jwt.decode(token, key, algorithms=["ES256"], options={"verify_exp": False, "verify_aud": False, "verify_iss": False})


@pytest.mark.parametrize("spec,expected", [("short-ttl", 5), ("short-ttl:2", 2), ("short-ttl:30", 30)])
def test_short_ttl(spec, expected):
    token, *_ = real([spec])
    c = jwt.decode(token, options={"verify_signature": False, "verify_exp": False, "verify_aud": False})
    assert c["exp"] - c["iat"] == expected


def test_refreshed_tokens_carry_the_fault_too():
    clock = FakeClock()
    with running(lambda s: Issuer(s, clock=clock), faults=("wrong-audience",)) as (_app, client):
        _lid, code = full_login(client)
        pair = exchange(client, code)[1]
        again = client.post_json("/refresh", {"refresh_token": pair["refresh_token"]})[1]
        assert jwt.decode(again["access_token"], options={"verify_signature": False, "verify_exp": False, "verify_aud": False, "verify_nbf": False, "verify_iat": False})["aud"] == "https://wrong.example"


# ---------------------------------------------------------------- COOP


def test_coop_fault_adds_the_header_to_every_popup_page():
    with running(faults=("coop",)) as (_app, client):
        status, headers, _ = start(client)
        assert status == 200 and headers["Cross-Origin-Opener-Policy"] == "same-origin"
        _lid, _s, rheaders, _page = sign_in(client)
        assert rheaders["Cross-Origin-Opener-Policy"] == "same-origin"
        assert "Cross-Origin-Opener-Policy" not in client.get_json("/jwks.json")[2]


def test_no_coop_header_by_default(served):
    _app, client = served
    assert "Cross-Origin-Opener-Policy" not in start(client)[1]


# ---------------------------------------------------------------- JWKS faults


def test_jwks_fail():
    with running(faults=("jwks-fail",)) as (_app, client):
        status, body, _ = client.get_json("/jwks.json")
        assert status == 500 and body["error"] == "server_error"
        assert client.get_json("/.well-known/copa-token-service")[0] == 200     # discovery still works


def test_jwks_slow_delays_by_the_parameter():
    with running(faults=("jwks-slow:0.4",)) as (_app, client):
        t = time.time()
        assert client.get_json("/jwks.json")[0] == 200
        assert time.time() - t >= 0.4


# ---------------------------------------------------------------- runtime control


def test_faults_can_be_switched_at_runtime_through_the_admin_api():
    auth = {"Authorization": "Bearer adm"}
    with running(admin_token="adm") as (_app, client):
        assert client.get_json("/admin/faults", headers=auth)[1] == {"faults": []}
        assert client.post_json("/admin/faults", {"faults": ["wrong-audience", "short-ttl:3"]}, headers=auth)[1] == {"faults": ["short-ttl", "wrong-audience"]}
        _lid, code = full_login(client)
        c = jwt.decode(exchange(client, code)[1]["access_token"], options={"verify_signature": False, "verify_exp": False, "verify_aud": False, "verify_nbf": False, "verify_iat": False})
        assert c["aud"] == "https://wrong.example" and c["exp"] - c["iat"] == 3
        client.post_json("/admin/faults", {"faults": []}, headers=auth)
        _lid, code = full_login(client)
        c = jwt.decode(exchange(client, code)[1]["access_token"], options={"verify_signature": False, "verify_exp": False, "verify_aud": False, "verify_nbf": False, "verify_iat": False})
        assert c["aud"] == AUD


def test_admin_faults_need_the_token_and_valid_names():
    with running(admin_token="adm") as (_app, client):
        assert client.post_json("/admin/faults", {"faults": []})[0] == 401
        status, body, _ = client.post_json("/admin/faults", {"faults": ["nope"]}, headers={"Authorization": "Bearer adm"})
        assert status == 400 and "unknown fault" in body["error_description"]
        assert client.post_json("/admin/faults", {"faults": "x"}, headers={"Authorization": "Bearer adm"})[0] == 400


def test_faults_object():
    f = Faults(["short-ttl:7", "coop"])
    assert f.has("coop") and f.param("short-ttl") == "7" and f.names() == ["coop", "short-ttl"] and f
    assert Faults(["short-ttl"]).param("short-ttl") == "5"
    assert not Faults([])
    with pytest.raises(FaultError):
        Faults(["bogus"])


def test_every_documented_fault_is_exercised_here():
    covered = {"expired-token", "wrong-audience", "wrong-issuer", "unknown-kid", "bad-signature", "alg-none",
               "hs256-confusion", "short-ttl", "coop", "jwks-fail", "jwks-slow"}
    assert covered == set(KNOWN)


def test_command_line_and_env_switches(monkeypatch):
    s = settings_from_args(build_parser().parse_args(["--fault", "coop", "--fault", "short-ttl:9"]))
    assert s.faults == ("coop", "short-ttl:9")
    monkeypatch.setenv("TOKEN_ISSUER_FAULTS", "wrong-audience,jwks-fail")
    assert settings_from_args(build_parser().parse_args([])).faults == ("wrong-audience", "jwks-fail")
