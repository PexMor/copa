"""In-memory state of logins, codes, sessions and refresh tokens (this is a test service)."""

from __future__ import annotations

import base64
import hashlib
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Callable


class GrantError(Exception):
    """Maps to the OAuth `invalid_grant` error."""


def s256(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class Login:
    id: str
    audience: str
    origin: str
    challenge: str
    expires: float
    #: pending -> ok | denied
    status: str = "pending"
    user_id: str | None = None
    code: str | None = None
    #: the popup reported that it lost its opener (COOP), so `popup.closed` is meaningless to the widget
    detached: bool = False
    #: redirect mode: where to send the user back (fragment carries the code) and the opaque state to echo
    redirect_uri: str | None = None
    state: str | None = None


@dataclass
class Session:
    sid: str
    user_id: str
    audience: str
    revoked: bool = False


@dataclass
class RefreshRecord:
    sid: str
    expires: float
    used: bool = False


@dataclass
class _Code:
    login_id: str
    expires: float


class Store:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self._lock = threading.RLock()
        self._logins: dict[str, Login] = {}
        self._codes: dict[str, _Code] = {}
        self._sessions: dict[str, Session] = {}
        self._refresh: dict[str, RefreshRecord] = {}

    # -- logins --------------------------------------------------------------------------

    def new_login(self, audience: str, origin: str, challenge: str, ttl: float,
                  redirect_uri: str | None = None, state: str | None = None) -> Login:
        with self._lock:
            login = Login(secrets.token_urlsafe(16), audience, origin, challenge, self.clock() + ttl,
                          redirect_uri=redirect_uri, state=state)
            self._logins[login.id] = login
            return login

    def get_login(self, login_id: str) -> Login | None:
        with self._lock:
            login = self._logins.get(login_id)
            if login is None or login.expires < self.clock():
                self._logins.pop(login_id, None)
                return None
            return login

    def complete_login(self, login: Login, user_id: str, code_ttl: float) -> str:
        """Approve the login; returns the single-use login code."""
        with self._lock:
            if login.status != "pending":
                raise GrantError("login already finished")
            login.status, login.user_id = "ok", user_id
            login.code = secrets.token_urlsafe(24)
            self._codes[login.code] = _Code(login.id, self.clock() + code_ttl)
            return login.code

    def deny_login(self, login: Login) -> None:
        with self._lock:
            if login.status == "pending":
                login.status = "denied"

    # -- codes -----------------------------------------------------------------------------

    def redeem_code(self, code: str, verifier: str) -> Login:
        """Single use: the code is consumed even when the verifier is wrong."""
        with self._lock:
            entry = self._codes.pop(code, None)
            if entry is None or entry.expires < self.clock():
                raise GrantError("invalid or expired login code")
            login = self._logins.get(entry.login_id)
            if login is None or login.status != "ok":
                raise GrantError("invalid or expired login code")
            if not secrets.compare_digest(s256(verifier), login.challenge):
                raise GrantError("verifier does not match the login")
            self._logins.pop(login.id, None)
            return login

    def mark_detached(self, login_id: str) -> bool:
        with self._lock:
            login = self.get_login(login_id)
            if login is None:
                return False
            login.detached = True
            return True

    def poll(self, verifier: str) -> tuple[str, str | None, bool]:
        """(status, login_code, detached) of the newest login started with this verifier's challenge.

        The widget cannot know the login id when the popup lost its opener, so the
        verifier (a secret only the initiating widget has) is the handle.
        """
        challenge = s256(verifier)
        with self._lock:
            candidates = [
                login for login in self._logins.values()
                if login.expires >= self.clock() and secrets.compare_digest(login.challenge, challenge)
            ]
            if not candidates:
                raise GrantError("no pending login for this verifier")
            login = max(candidates, key=lambda l: l.expires)
            return login.status, login.code if login.status == "ok" else None, login.detached

    # -- sessions and refresh tokens ----------------------------------------------------------

    def new_session(self, user_id: str, audience: str) -> Session:
        with self._lock:
            s = Session(secrets.token_urlsafe(12), user_id, audience)
            self._sessions[s.sid] = s
            return s

    def session(self, sid: str) -> Session | None:
        with self._lock:
            return self._sessions.get(sid)

    def issue_refresh(self, sid: str, ttl: float) -> tuple[str, float]:
        with self._lock:
            token = secrets.token_urlsafe(32)
            expires = self.clock() + ttl
            self._refresh[_digest(token)] = RefreshRecord(sid, expires)
            return token, expires

    def rotate_refresh(self, token: str, ttl: float) -> tuple[Session, str, float]:
        """Consume `token`, return the session and a fresh refresh token. Reuse revokes the session."""
        with self._lock:
            rec = self._refresh.get(_digest(token))
            if rec is None:
                raise GrantError("unknown refresh token")
            session = self._sessions.get(rec.sid)
            if session is None or session.revoked:
                raise GrantError("session revoked")
            if rec.used:
                session.revoked = True  # a rotated token came back: assume theft
                raise GrantError("refresh token reuse detected; session revoked")
            if rec.expires < self.clock():
                raise GrantError("refresh token expired")
            rec.used = True
            new, expires = self.issue_refresh(rec.sid, ttl)
            return session, new, expires

    def revoke_by_refresh(self, token: str) -> bool:
        with self._lock:
            rec = self._refresh.get(_digest(token))
            if rec is None:
                return False
            session = self._sessions.get(rec.sid)
            if session is not None:
                session.revoked = True
            return True
