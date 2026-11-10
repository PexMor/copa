"""Access-token (JWT) issuing."""

from __future__ import annotations

import secrets
import time

import jwt

from .keys import ALG, KeyStore
from .users import User

#: claims the issuer sets itself; user-defined extra claims cannot override them
RESERVED = frozenset({"iss", "sub", "aud", "iat", "nbf", "exp", "jti", "scope", "groups", "email", "name"})


def access_claims(
    *, issuer: str, user: User, audience: str, ttl: int, now: float | None = None,
) -> dict:
    t = int(now if now is not None else time.time())
    claims = {
        "iss": issuer,
        "sub": user.id,
        "aud": audience,
        "iat": t,
        "nbf": t,
        "exp": t + ttl,
        "jti": secrets.token_urlsafe(12),
        "email": user.email,
        "name": user.name,
        "groups": list(user.groups),
        "scope": user.scope,
    }
    for k, v in user.claims.items():
        if k not in RESERVED:
            claims[k] = v
    return claims


def sign(keys: KeyStore, claims: dict, *, kid: str | None = None) -> str:
    key = keys.get(kid) if kid else keys.active
    if key is None:
        raise ValueError(f"unknown signing key {kid!r}")
    return jwt.encode(claims, key.private, algorithm=ALG, headers={"kid": key.kid, "typ": "at+jwt"})


def issue_access_token(
    keys: KeyStore, *, issuer: str, user: User, audience: str, ttl: int, now: float | None = None,
) -> tuple[str, dict]:
    claims = access_claims(issuer=issuer, user=user, audience=audience, ttl=ttl, now=now)
    return sign(keys, claims), claims
