"""End-to-end: copasrv trusting this token issuer, configured from config.toml.example.

    cargo build                              # from the copa repo root
    uv run python dev/copasrv_e2e.py         # from token-issuer/

Starts the token issuer and copasrv, signs users in through the real login endpoints and
checks what copasrv does with the tokens (access mapping, expiry, every fault switch,
key rotation). Exits non-zero on the first failed expectation.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                      # the copa repo
AUD = "https://copa.example.com"
ORIGIN = "http://localhost:5180"
ADMIN = "adm-e2e"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(method, url, body=None, headers=None, form=False):
    data = None
    h = dict(headers or {})
    if body is not None:
        data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
        h.setdefault("Content-Type", "application/x-www-form-urlencoded" if form else "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def wait_up(url, what, proc):
    for _ in range(100):
        if proc.poll() is not None:
            raise SystemExit(f"{what} exited early with {proc.returncode}")
        try:
            if http("GET", url)[0] < 500:
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise SystemExit(f"{what} did not start")


def issuers_block() -> str:
    """The commented example block of config.toml.example, uncommented."""
    lines = (ROOT / "config.toml.example").read_text().splitlines()
    begin = lines.index("# >>> issuers") + 1
    end = lines.index("# <<< issuers")
    return "\n".join(l[2:] if l.startswith("# ") else l.lstrip("#") for l in lines[begin:end])


class Rig:
    def __init__(self, copasrv: Path) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.procs: list[subprocess.Popen] = []
        self.issuer_port, self.copa_port = free_port(), free_port()
        self.issuer = f"http://127.0.0.1:{self.issuer_port}"
        self.copa = f"http://127.0.0.1:{self.copa_port}"
        self.copasrv = copasrv

    def start(self) -> None:
        self.procs.append(subprocess.Popen(
            [sys.executable, "-m", "token_issuer", "--ephemeral", "--port", str(self.issuer_port),
             "--admin-token", ADMIN, "--log-level", "warning"], cwd=HERE.parent))
        wait_up(f"{self.issuer}/healthz", "token issuer", self.procs[-1])

        block = (issuers_block()
                 .replace("https://auth.example.com/jwks.json", f"{self.issuer}/jwks.json")
                 .replace("https://auth.example.com", self.issuer)
                 .replace("copa:shared:rw", "copa:team:rw")           # the issuer's alice
                 .replace("leeway_secs = 30", "leeway_secs = 0\njwks_min_refresh_secs = 1"))
        cfg = Path(self.tmp.name) / "copasrv.toml"
        cfg.write_text(f'[server.namespaces.default]\nrw_token = "static"\n[server.namespaces.shared]\nrw_token = "shared-static"\n{block}\n')
        self.procs.append(subprocess.Popen(
            [str(self.copasrv), "--config", str(cfg), "--port", str(self.copa_port), "--bind", "127.0.0.1"],
            stderr=subprocess.DEVNULL))
        wait_up(f"{self.copa}/api/version", "copasrv", self.procs[-1])

    def stop(self) -> None:
        for p in self.procs:
            p.terminate()
        for p in self.procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        self.tmp.cleanup()

    # -- helpers ------------------------------------------------------------------------------

    def admin(self, path, body=None):
        return http("POST", f"{self.issuer}{path}", body or {}, {"Authorization": f"Bearer {ADMIN}"})

    def login(self, user: str) -> str:
        """Scripted popup login; returns the access token."""
        verifier = base64.urlsafe_b64encode(hashlib.sha256(user.encode() + str(time.time()).encode()).digest()).rstrip(b"=").decode()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        q = urllib.parse.urlencode({"audience": AUD, "origin": ORIGIN, "challenge": challenge})
        _s, page = http("GET", f"{self.issuer}/login?{q}")
        login_id = re.search(r'name="login_id" value="([^"]+)"', page).group(1)
        _s, result = http("POST", f"{self.issuer}/login/submit",
                          {"login_id": login_id, "user": user, "password": user, "action": "signin"}, form=True)
        code = json.loads(re.search(r"const msg = (\{.*?\});", result).group(1))["login_code"]
        status, body = http("POST", f"{self.issuer}/token", {"login_code": code, "verifier": verifier})
        assert status == 200, body
        return json.loads(body)["access_token"]

    def copa_call(self, token, method="GET", ns="shared", body=None):
        h = {"Authorization": f"Bearer {token}", "X-Copa-Namespace": ns}
        if body is not None:
            h["Content-Type"] = "text/plain"
        req = urllib.request.Request(f"{self.copa}/api/clipboard", data=body.encode() if body is not None else None, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code


failures: list[str] = []


def expect(name: str, got, want) -> None:
    ok = got == want
    print(("✓ " if ok else "✗ ") + name + ("" if ok else f"   (got {got}, want {want})"))
    if not ok:
        failures.append(name)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--copasrv", default=str(ROOT / "target" / "debug" / "copasrv"))
    args = ap.parse_args()
    if not Path(args.copasrv).exists():
        raise SystemExit(f"{args.copasrv} not found; run `cargo build` in the copa repo first")

    rig = Rig(Path(args.copasrv))
    try:
        rig.start()

        # access mapping from the documented example
        alice, bob, carol = rig.login("alice"), rig.login("bob"), rig.login("carol")
        expect("alice (scope copa:team:rw) can write", rig.copa_call(alice, "POST", body="hello"), 200)
        expect("alice can read it back", rig.copa_call(alice), 200)
        expect("bob (group copa-readers) can read", rig.copa_call(bob), 200)
        expect("bob cannot write", rig.copa_call(bob, "POST", body="x"), 401)
        expect("carol (no scope) is forbidden", rig.copa_call(carol), 403)
        expect("alice has no mapping in 'default' -> forbidden", rig.copa_call(alice, ns="default"), 403)
        expect("static token still works", rig.copa_call("shared-static"), 200)
        expect("garbage token is refused", rig.copa_call("a.b.c"), 401)

        # fault switches: every one of these tokens must be refused by the resource server
        for fault in ("expired-token", "wrong-audience", "wrong-issuer", "unknown-kid", "bad-signature", "alg-none", "hs256-confusion"):
            rig.admin("/admin/faults", {"faults": [fault]})
            expect(f"fault {fault}: token refused", rig.copa_call(rig.login("alice")), 401)
        rig.admin("/admin/faults", {"faults": []})

        # short-lived tokens really expire (leeway is 0 in this rig)
        rig.admin("/admin/faults", {"faults": ["short-ttl:2"]})
        short = rig.login("alice")
        expect("short-lived token works at first", rig.copa_call(short), 200)
        time.sleep(3.2)
        expect("short-lived token is refused after expiry", rig.copa_call(short), 401)
        rig.admin("/admin/faults", {"faults": []})

        # key rotation: the new key is picked up (after the rate-limit interval), the old one keeps working
        old = rig.login("alice")
        rig.admin("/admin/rotate-key")
        new = rig.login("alice")
        time.sleep(1.2)
        expect("token signed by the rotated-in key is accepted", rig.copa_call(new), 200)
        expect("token from before the rotation still works (overlap)", rig.copa_call(old), 200)

        # the issuer's JWKS going down does not break cached keys
        rig.admin("/admin/faults", {"faults": ["jwks-fail"]})
        expect("cached keys keep working while the JWKS is failing", rig.copa_call(new), 200)
        rig.admin("/admin/faults", {"faults": []})
    finally:
        rig.stop()

    print("\nFAILED: " + ", ".join(failures) if failures else "\nOK: copasrv and the token issuer agree")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
