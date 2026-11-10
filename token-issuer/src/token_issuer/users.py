"""Fake users for the login page; the claims they carry end up in the access tokens."""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass, field
from pathlib import Path

#: Same content as users.example.json (a test keeps them identical).
DEFAULT_USERS: dict = {
    "users": [
        {"id": "alice", "name": "Alice (team writer)", "email": "alice@example.com", "password": "alice",
         "groups": ["copa-team"], "scope": "copa:team:rw"},
        {"id": "bob", "name": "Bob (team reader)", "email": "bob@example.com", "password": "bob",
         "groups": ["copa-readers"], "scope": "copa:team:r"},
        {"id": "carol", "name": "Carol (no copa access)", "email": "carol@elsewhere.example", "password": "carol",
         "groups": [], "scope": ""},
    ]
}


class UsersError(ValueError):
    """The users file is invalid."""


@dataclass(frozen=True)
class User:
    id: str
    name: str
    email: str
    #: None = no password check (pick-a-user login); otherwise compared in constant time
    password: str | None = None
    groups: tuple[str, ...] = ()
    #: space-delimited OAuth scope string, e.g. "copa:team:rw copa:other:r"
    scope: str = ""
    #: extra claims copied verbatim into the access token
    claims: dict = field(default_factory=dict, compare=False, hash=False)

    def check_password(self, given: str | None) -> bool:
        if self.password is None:
            return True
        return given is not None and secrets.compare_digest(self.password.encode(), given.encode())


class Users:
    def __init__(self, users: list[User]) -> None:
        self._by_id = {u.id: u for u in users}

    def all(self) -> list[User]:
        return list(self._by_id.values())

    def upsert(self, user: User) -> None:
        """Add or replace a user at run time (users that signed in upstream)."""
        self._by_id[user.id] = user

    def get(self, user_id: str) -> User | None:
        return self._by_id.get(user_id)

    @classmethod
    def from_dict(cls, data: object) -> "Users":
        if not isinstance(data, dict) or not isinstance(data.get("users"), list) or not data["users"]:
            raise UsersError('users file must be {"users": [ ... ]} with at least one user')
        users: list[User] = []
        seen: set[str] = set()
        for i, raw in enumerate(data["users"]):
            where = f"users[{i}]"
            if not isinstance(raw, dict):
                raise UsersError(f"{where} must be an object")
            uid = raw.get("id")
            if not isinstance(uid, str) or not uid:
                raise UsersError(f"{where}.id must be a non-empty string")
            if uid in seen:
                raise UsersError(f"{where}: duplicate id {uid!r}")
            seen.add(uid)
            groups = raw.get("groups", [])
            if not isinstance(groups, list) or not all(isinstance(g, str) for g in groups):
                raise UsersError(f"{where}.groups must be a list of strings")
            scope = raw.get("scope", "")
            if isinstance(scope, list) and all(isinstance(s, str) for s in scope):
                scope = " ".join(scope)
            if not isinstance(scope, str):
                raise UsersError(f"{where}.scope must be a string or a list of strings")
            password = raw.get("password")
            if password is not None and not isinstance(password, str):
                raise UsersError(f"{where}.password must be a string")
            extra = raw.get("claims", {})
            if not isinstance(extra, dict):
                raise UsersError(f"{where}.claims must be an object")
            users.append(User(
                id=uid, name=str(raw.get("name", uid)), email=str(raw.get("email", f"{uid}@example.com")),
                password=password, groups=tuple(groups), scope=scope, claims=extra,
            ))
        return cls(users)

    @classmethod
    def load(cls, path: Path | None) -> "Users":
        if path is None:
            return cls.from_dict(DEFAULT_USERS)
        try:
            return cls.from_dict(json.loads(Path(path).expanduser().read_text()))
        except json.JSONDecodeError as e:
            raise UsersError(f"{path}: not valid JSON: {e}") from None
