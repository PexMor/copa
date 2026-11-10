from __future__ import annotations

import subprocess
import sys
import time
import urllib.request

import pytest

from token_issuer.config import build_parser, settings_from_args
from token_issuer.server import Request


def test_health_route(served):
    _app, client = served
    status, body, _ = client.get_json("/healthz")
    assert (status, body) == (200, {"status": "ok"})


def test_unknown_route_and_wrong_method(served):
    _app, client = served
    assert client.get_json("/nope")[0] == 404
    status, _, headers = client.post_json("/healthz")
    assert status == 405 and headers["Allow"] == "GET"


def test_defaults_are_safe():
    args = build_parser().parse_args([])
    s = settings_from_args(args)
    assert s.host == "127.0.0.1"          # loopback unless the operator says otherwise
    assert s.public_url == "http://127.0.0.1:8090"


def test_precedence_cli_over_env_over_file(tmp_path, monkeypatch):
    cfg = tmp_path / "c.toml"
    cfg.write_text('[token-issuer]\nport = 9001\npublic-url = "https://from-file.example"\n')
    assert build_parser().parse_args(["-c", str(cfg)]).port == 9001
    monkeypatch.setenv("TOKEN_ISSUER_PORT", "9002")
    assert build_parser().parse_args(["-c", str(cfg)]).port == 9002
    assert build_parser().parse_args(["-c", str(cfg), "--port", "9003"]).port == 9003
    args = build_parser().parse_args(["-c", str(cfg)])
    assert settings_from_args(args).public_url == "https://from-file.example"


def test_public_url_has_no_trailing_slash():
    args = build_parser().parse_args(["--public-url", "https://auth.example.com/"])
    assert settings_from_args(args).public_url == "https://auth.example.com"


def test_console_script_serves_health():
    proc = subprocess.Popen(
        [sys.executable, "-m", "token_issuer", "--port", "0", "--ephemeral", "--log-level", "info"],
        stderr=subprocess.PIPE, text=True,
    )
    try:
        line = ""
        deadline = time.time() + 10
        while time.time() < deadline and "listening on" not in line:
            line = proc.stderr.readline()
        assert "listening on" in line, line
        hostport = line.split("listening on ")[1].split(" ")[0]
        with urllib.request.urlopen(f"http://{hostport}/healthz", timeout=5) as r:
            assert r.status == 200
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_bad_json_body_is_a_400(served):
    app, client = served
    app.route("POST", "/echo", lambda r: __import__("token_issuer.server", fromlist=["Response"]).Response.json(r.json()))
    status, _h, body = client.request("POST", "/echo", None, {"Content-Type": "application/json"})
    assert status == 200  # empty body is {}
    req = Request("POST", "/echo", {}, {}, b"{nope")
    assert app.dispatch(req).status == 400
