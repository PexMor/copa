"""Signing keys: ES256 key pairs, persisted PEMs, JWKS publication, rotation with overlap."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ALG = "ES256"


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def public_jwk(key: ec.EllipticCurvePrivateKey) -> dict:
    """Public JWK of a P-256 key (never contains private material)."""
    n = key.public_key().public_numbers()
    jwk = {"kty": "EC", "crv": "P-256", "x": _b64u(n.x.to_bytes(32, "big")), "y": _b64u(n.y.to_bytes(32, "big"))}
    # RFC 7638 thumbprint: members in lexicographic order, no whitespace
    canonical = json.dumps({k: jwk[k] for k in ("crv", "kty", "x", "y")}, separators=(",", ":"), sort_keys=True)
    jwk["kid"] = _b64u(hashlib.sha256(canonical.encode()).digest())
    jwk["use"] = "sig"
    jwk["alg"] = ALG
    return jwk


@dataclass
class SigningKey:
    kid: str
    private: ec.EllipticCurvePrivateKey
    created: float
    #: retired keys are no longer published and cannot be used
    retired: bool = False


class KeyError_(Exception):
    """Invalid key operation (for example retiring the active key)."""


class KeyStore:
    """
    The newest non-retired key signs. Rotating adds a new key while the old one
    stays in the JWKS (overlap) so tokens signed before the rotation still
    verify; retiring removes a key from the JWKS. With ``state_dir=None`` the
    keys live in memory only.
    """

    def __init__(self, state_dir: Path | None = None) -> None:
        self._dir = state_dir
        self._lock = threading.Lock()
        self._keys: list[SigningKey] = []
        if self._dir is not None:
            self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._load()
        if not self._active_unlocked():
            self._add_unlocked()

    # -- persistence ---------------------------------------------------------------

    def _meta_path(self) -> Path:
        assert self._dir is not None
        return self._dir / "keys.json"

    def _load(self) -> None:
        meta_path = self._meta_path()
        if not meta_path.exists():
            return
        for entry in json.loads(meta_path.read_text()):
            pem = (self._dir / f"{entry['kid']}.pem").read_bytes()  # type: ignore[operator]
            private = serialization.load_pem_private_key(pem, password=None)
            assert isinstance(private, ec.EllipticCurvePrivateKey)
            self._keys.append(SigningKey(entry["kid"], private, entry["created"], entry.get("retired", False)))

    def _save(self) -> None:
        if self._dir is None:
            return
        for k in self._keys:
            pem_path = self._dir / f"{k.kid}.pem"
            if not pem_path.exists():
                fd = os.open(pem_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as f:
                    f.write(k.private.private_bytes(
                        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        meta = [{"kid": k.kid, "created": k.created, "retired": k.retired} for k in self._keys]
        tmp = self._meta_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(self._meta_path())

    # -- operations ------------------------------------------------------------------

    def _active_unlocked(self) -> SigningKey | None:
        live = [k for k in self._keys if not k.retired]
        return max(live, key=lambda k: k.created) if live else None

    def _add_unlocked(self) -> SigningKey:
        private = ec.generate_private_key(ec.SECP256R1())
        # strictly increasing creation time so "newest" is unambiguous even within one tick
        created = max([time.time()] + [k.created + 1e-6 for k in self._keys])
        key = SigningKey(public_jwk(private)["kid"], private, created)
        self._keys.append(key)
        self._save()
        return key

    @property
    def active(self) -> SigningKey:
        with self._lock:
            key = self._active_unlocked()
            assert key is not None
            return key

    def rotate(self) -> SigningKey:
        """Add a new signing key; older keys stay published until retired."""
        with self._lock:
            return self._add_unlocked()

    def retire(self, kid: str) -> None:
        with self._lock:
            key = next((k for k in self._keys if k.kid == kid and not k.retired), None)
            if key is None:
                raise KeyError_(f"no such published key: {kid}")
            if key is self._active_unlocked():
                raise KeyError_("cannot retire the active signing key; rotate first")
            key.retired = True
            self._save()

    def jwks(self) -> dict:
        with self._lock:
            return {"keys": [public_jwk(k.private) for k in self._keys if not k.retired]}

    def get(self, kid: str) -> SigningKey | None:
        with self._lock:
            return next((k for k in self._keys if k.kid == kid and not k.retired), None)
