from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from contextlib import contextmanager

import pytest

from token_issuer.config import Settings
from token_issuer.app import Issuer
from token_issuer.server import make_server


class Client:
    def __init__(self, base: str) -> None:
        self.base = base

    def request(self, method: str, path: str, body: object | None = None, headers: dict | None = None):
        data = None if body is None else json.dumps(body).encode()
        h = {"Content-Type": "application/json"} if body is not None else {}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def post_form(self, path: str, fields: dict, headers: dict | None = None):
        import urllib.parse

        data = urllib.parse.urlencode(fields).encode()
        h = {"Content-Type": "application/x-www-form-urlencoded", **(headers or {})}
        req = urllib.request.Request(self.base + path, data=data, method="POST", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.headers, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read().decode()

    def get_text(self, path: str, headers: dict | None = None):
        status, h, body = self.request("GET", path, headers=headers)
        return status, h, body.decode()

    def get_json(self, path: str, **kw):
        status, headers, body = self.request("GET", path, **kw)
        return status, json.loads(body or b"null"), headers

    def post_json(self, path: str, body: object | None = None, **kw):
        status, headers, raw = self.request("POST", path, {} if body is None else body, **kw)
        return status, json.loads(raw or b"null"), headers


class FakeClock:
    def __init__(self, now: float = 1_800_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@contextmanager
def running(app_factory=lambda s: Issuer(s), **overrides):
    # bind first so the settings (issuer URL) know the real port
    settings = Settings(host="127.0.0.1", port=0, public_url="http://127.0.0.1:0", log_level="warning", **overrides)
    app = app_factory(settings)
    server = make_server(app, "127.0.0.1", 0)
    port = server.server_address[1]
    app.settings = Settings(host="127.0.0.1", port=port, public_url=f"http://127.0.0.1:{port}", log_level="warning", **overrides)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.02), daemon=True)
    thread.start()
    try:
        yield app, Client(f"http://127.0.0.1:{port}")
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def served():
    with running() as r:
        yield r
