"""Optional upstream mode: delegate the user login to a real OIDC provider (dex, Keycloak, Google...).

The token issuer is the confidential OAuth client; the provider's tokens never leave this
process. The user's claims are mapped to copa scopes and put into the access token the
issuer signs itself, exactly as in the fake-user mode.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import json
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import jwt

from .users import User

ALLOWED_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"]


class UpstreamError(Exception):
    """The upstream login failed; the message is safe to show to the user (no secrets)."""


@dataclass(frozen=True)
class MapRule:
    #: claim name in the ID token (string or list claim)
    claim: str
    #: exact value or fnmatch pattern (`*@example.com`)
    value: str
    #: scope(s) granted when the rule matches, space-separated
    scope: str


@dataclass(frozen=True)
class UpstreamConfig:
    issuer: str
    client_id: str
    client_secret: str
    scopes: str = "openid email profile"
    rules: tuple[MapRule, ...] = ()
    #: claim holding the user's groups (copied into the token's `groups`)
    groups_claim: str = "groups"

    def __repr__(self) -> str:  # never print the secret
        return f"UpstreamConfig(issuer={self.issuer!r}, client_id={self.client_id!r}, client_secret='***')"


def load_rules(path: Path | None) -> tuple[MapRule, ...]:
    if path is None:
        return ()
    data = json.loads(Path(path).expanduser().read_text())
    rules = data.get("rules") if isinstance(data, dict) else None
    if not isinstance(rules, list):
        raise ValueError(f'{path}: expected {{"rules": [ {{"claim", "value", "scope"}} ]}}')
    out = []
    for i, r in enumerate(rules):
        if not isinstance(r, dict) or not all(isinstance(r.get(k), str) and r.get(k) for k in ("claim", "value")) \
                or not isinstance(r.get("scope"), str):
            raise ValueError(f"{path}: rules[{i}] needs string claim, value and scope")
        out.append(MapRule(r["claim"], r["value"], r["scope"]))
    return tuple(out)


def _values(claim: object) -> list[str]:
    if isinstance(claim, str):
        return [claim]
    if isinstance(claim, list):
        return [str(x) for x in claim]
    return []


def map_scope(claims: dict, rules: tuple[MapRule, ...]) -> str:
    """Union of the scopes of every matching rule, in rule order, without duplicates."""
    scopes: list[str] = []
    for rule in rules:
        if any(fnmatch.fnmatchcase(v, rule.value) for v in _values(claims.get(rule.claim))):
            scopes.extend(s for s in rule.scope.split() if s not in scopes)
    return " ".join(scopes)


def user_from_claims(claims: dict, cfg: UpstreamConfig) -> User:
    sub = str(claims["sub"])
    email = str(claims.get("email", ""))
    return User(
        id=sub,
        name=str(claims.get("name") or claims.get("preferred_username") or email or sub),
        email=email,
        groups=tuple(_values(claims.get(cfg.groups_claim))),
        scope=map_scope(claims, cfg.rules),
    )


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@dataclass
class _Pending:
    nonce: str
    verifier: str


class Upstream:
    def __init__(self, cfg: UpstreamConfig, public_url: Callable[[], str], timeout: float = 10.0) -> None:
        self.cfg = cfg
        self._public_url = public_url          # resolved lazily: the real port may be known only after binding
        self.timeout = timeout
        self._lock = threading.Lock()
        self._meta: dict | None = None
        self._jwks: jwt.PyJWKClient | None = None
        self._pending: dict[str, _Pending] = {}

    @property
    def redirect_uri(self) -> str:
        return f"{self._public_url()}/login/callback"

    def _get_json(self, url: str) -> dict:
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            raise UpstreamError(f"cannot reach the upstream provider ({url}): {e}") from None

    def metadata(self) -> dict:
        with self._lock:
            if self._meta is None:
                meta = self._get_json(self.cfg.issuer.rstrip("/") + "/.well-known/openid-configuration")
                for k in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
                    if k not in meta:
                        raise UpstreamError(f"upstream discovery document lacks {k}")
                self._meta = meta
                self._jwks = jwt.PyJWKClient(meta["jwks_uri"], cache_keys=True)
            return self._meta

    def authorize_url(self, login_id: str) -> str:
        meta = self.metadata()
        pending = _Pending(nonce=secrets.token_urlsafe(16), verifier=secrets.token_urlsafe(48))
        with self._lock:
            self._pending[login_id] = pending
        q = {
            "response_type": "code", "client_id": self.cfg.client_id, "redirect_uri": self.redirect_uri,
            "scope": self.cfg.scopes, "state": login_id, "nonce": pending.nonce,
            "code_challenge": _b64u(hashlib.sha256(pending.verifier.encode()).digest()), "code_challenge_method": "S256",
        }
        return meta["authorization_endpoint"] + ("&" if "?" in meta["authorization_endpoint"] else "?") + urllib.parse.urlencode(q)

    def complete(self, login_id: str, code: str) -> dict:
        """Exchange the code (client secret + PKCE) and return the validated ID-token claims."""
        meta = self.metadata()
        with self._lock:
            pending = self._pending.pop(login_id, None)
        if pending is None:
            raise UpstreamError("unknown or already used sign-in")
        data = urllib.parse.urlencode({
            "grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect_uri,
            "client_id": self.cfg.client_id, "client_secret": self.cfg.client_secret, "code_verifier": pending.verifier,
        }).encode()
        req = urllib.request.Request(meta["token_endpoint"], data=data, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read()).get("error_description", "")
            except Exception:  # noqa: BLE001
                pass
            raise UpstreamError(f"the upstream token endpoint refused the code ({e.code}) {detail}".strip()) from None
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            raise UpstreamError(f"cannot reach the upstream token endpoint: {e}") from None
        id_token = body.get("id_token")
        if not isinstance(id_token, str):
            raise UpstreamError("the upstream provider returned no ID token")
        try:
            assert self._jwks is not None
            key = self._jwks.get_signing_key_from_jwt(id_token).key
            claims = jwt.decode(id_token, key, algorithms=ALLOWED_ALGS, audience=self.cfg.client_id,
                                issuer=meta.get("issuer", self.cfg.issuer), leeway=30)
        except jwt.PyJWTError as e:
            raise UpstreamError(f"the upstream ID token is invalid: {e}") from None
        if not secrets.compare_digest(str(claims.get("nonce", "")), pending.nonce):
            raise UpstreamError("the upstream ID token has the wrong nonce")
        if not claims.get("sub"):
            raise UpstreamError("the upstream ID token has no subject")
        return claims
