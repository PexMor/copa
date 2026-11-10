"""Fault injection: tokens and behaviours that a resource server must reject or survive."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .keys import ALG, KeyStore, public_jwk

#: name -> (description, default parameter or None)
KNOWN: dict[str, tuple[str, str | None]] = {
    "expired-token": ("access tokens that expired a minute ago", None),
    "wrong-audience": ("access tokens with aud https://wrong.example", None),
    "wrong-issuer": ("access tokens with iss https://evil.example", None),
    "unknown-kid": ("tokens signed by a key that is not in the JWKS (unknown kid)", None),
    "bad-signature": ("valid-looking tokens whose signature was tampered with", None),
    "alg-none": ("unsigned tokens with alg none", None),
    "hs256-confusion": ("HS256 tokens signed with the public key as the HMAC secret", None),
    "short-ttl": ("access tokens that live N seconds (default 5)", "5"),
    "coop": ("login/result pages sending Cross-Origin-Opener-Policy: same-origin (severs window.opener)", None),
    "jwks-fail": ("GET /jwks.json answers 500", None),
    "jwks-slow": ("GET /jwks.json is delayed by N seconds (default 3)", "3"),
}


class FaultError(ValueError):
    pass


class Faults:
    """Thread-safe, replaceable set of active faults (`name` or `name:parameter`)."""

    def __init__(self, specs: tuple[str, ...] | list[str] = ()) -> None:
        self._lock = threading.Lock()
        self._active: dict[str, str | None] = {}
        self.set(list(specs))

    def set(self, specs: list[str]) -> None:
        parsed: dict[str, str | None] = {}
        for spec in specs:
            name, _, param = spec.strip().partition(":")
            if name not in KNOWN:
                raise FaultError(f"unknown fault {name!r}; known: {', '.join(sorted(KNOWN))}")
            parsed[name] = param or KNOWN[name][1]
        with self._lock:
            self._active = parsed

    def has(self, name: str) -> bool:
        with self._lock:
            return name in self._active

    def param(self, name: str) -> str | None:
        with self._lock:
            return self._active.get(name)

    def names(self) -> list[str]:
        with self._lock:
            return sorted(self._active)

    def __bool__(self) -> bool:
        with self._lock:
            return bool(self._active)


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _manual(header: dict, claims: dict, signature: bytes = b"") -> str:
    h = _b64u(json.dumps(header, separators=(",", ":")).encode())
    p = _b64u(json.dumps(claims, separators=(",", ":")).encode())
    return f"{h}.{p}.{_b64u(signature)}"


def adjust_claims(claims: dict, faults: Faults, now: float) -> dict:
    """Claim-level faults (the token is still signed correctly)."""
    c = dict(claims)
    if faults.has("expired-token"):
        c["iat"] = c["nbf"] = int(now) - 3660
        c["exp"] = int(now) - 60
    if faults.has("short-ttl"):
        c["exp"] = c["iat"] + int(faults.param("short-ttl") or 5)
    if faults.has("wrong-audience"):
        c["aud"] = "https://wrong.example"
    if faults.has("wrong-issuer"):
        c["iss"] = "https://evil.example"
    return c


def sign_token(keys: KeyStore, claims: dict, faults: Faults) -> str:
    """Sign `claims`, applying signature-level faults."""
    active = keys.active
    header = {"alg": ALG, "typ": "at+jwt", "kid": active.kid}

    if faults.has("alg-none"):
        return _manual({"alg": "none", "typ": "at+jwt", "kid": active.kid}, claims)

    if faults.has("hs256-confusion"):
        # classic key-confusion attack: the *public* key bytes used as an HMAC secret
        pem = active.private.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        head = {"alg": "HS256", "typ": "at+jwt", "kid": active.kid}
        signing_input = _manual(head, claims).rsplit(".", 1)[0]
        return _manual(head, claims, hmac.new(pem, signing_input.encode(), hashlib.sha256).digest())

    if faults.has("unknown-kid"):
        foreign = ec.generate_private_key(ec.SECP256R1())
        kid = "unknown-" + secrets.token_urlsafe(6)
        return jwt.encode(claims, foreign, algorithm=ALG, headers={"kid": kid, "typ": "at+jwt"})

    token = jwt.encode(claims, active.private, algorithm=ALG, headers=header)
    if faults.has("bad-signature"):
        head, payload, sig = token.split(".")
        raw = bytearray(base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4)))
        raw[0] ^= 0xFF
        token = f"{head}.{payload}.{_b64u(bytes(raw))}"
    return token


def jwks_fault_response(faults: Faults) -> tuple[int, float] | None:
    """(status, delay) for /jwks.json under a JWKS fault, else None."""
    delay = float(faults.param("jwks-slow") or 0) if faults.has("jwks-slow") else 0.0
    if faults.has("jwks-fail"):
        return 500, delay
    if delay:
        return 200, delay
    return None


__all__ = ["Faults", "FaultError", "KNOWN", "adjust_claims", "sign_token", "jwks_fault_response", "public_jwk", "time"]
