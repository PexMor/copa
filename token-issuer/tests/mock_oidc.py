"""A tiny OIDC provider (authorize / token / jwks / discovery) for testing the upstream mode."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from token_issuer.keys import public_jwk


class MockOidc:
    def __init__(self, client_id="copa-issuer", client_secret="s3cret") -> None:
        self.client_id, self.client_secret = client_id, client_secret
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.kid = public_jwk(self.key)["kid"]
        self.claims = {"sub": "u-123", "email": "dana@example.com", "name": "Dana", "groups": ["admins"]}
        self.tamper: str | None = None
        self.deny = False
        self.authorize_calls: list[dict] = []
        self._codes: dict[str, dict] = {}
        self._server: ThreadingHTTPServer | None = None

    @property
    def issuer(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"  # type: ignore[union-attr]

    def start(self) -> "MockOidc":
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _send(self, status, body=b"", ctype="application/json", headers=None):
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                q = {k: v[-1] for k, v in urllib.parse.parse_qs(u.query).items()}
                if u.path == "/.well-known/openid-configuration":
                    return self._send(200, json.dumps({
                        "issuer": mock.issuer, "authorization_endpoint": mock.issuer + "/authorize",
                        "token_endpoint": mock.issuer + "/token", "jwks_uri": mock.issuer + "/jwks"}).encode())
                if u.path == "/jwks":
                    return self._send(200, json.dumps({"keys": [public_jwk(mock.key)]}).encode())
                if u.path == "/authorize":
                    mock.authorize_calls.append(q)
                    back = {"state": q["state"]}
                    if mock.deny:
                        back["error"] = "access_denied"
                    else:
                        code = secrets.token_urlsafe(10)
                        mock._codes[code] = q
                        back["code"] = code
                    return self._send(302, headers={"Location": q["redirect_uri"] + "?" + urllib.parse.urlencode(back)})
                self._send(404)

            def do_POST(self):
                body = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
                f = {k: v[-1] for k, v in body.items()}
                if f.get("client_id") != mock.client_id or f.get("client_secret") != mock.client_secret:
                    return self._send(401, json.dumps({"error": "invalid_client", "error_description": "bad client credentials"}).encode())
                auth = mock._codes.pop(f.get("code", ""), None)
                if auth is None or f.get("redirect_uri") != auth["redirect_uri"]:
                    return self._send(400, json.dumps({"error": "invalid_grant", "error_description": "bad code"}).encode())
                challenge = base64.urlsafe_b64encode(hashlib.sha256(f.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
                if challenge != auth["code_challenge"]:
                    return self._send(400, json.dumps({"error": "invalid_grant", "error_description": "pkce mismatch"}).encode())
                now = int(time.time())
                claims = {**mock.claims, "iss": mock.issuer, "aud": mock.client_id, "iat": now, "exp": now + 300, "nonce": auth["nonce"]}
                key = mock.key
                if mock.tamper == "nonce":
                    claims["nonce"] = "other"
                elif mock.tamper == "aud":
                    claims["aud"] = "someone-else"
                elif mock.tamper == "exp":
                    claims["exp"] = now - 3600
                elif mock.tamper == "iss":
                    claims["iss"] = "https://evil.example"
                elif mock.tamper == "sig":
                    key = ec.generate_private_key(ec.SECP256R1())        # signed by an unpublished key
                token = jwt.encode(claims, key, algorithm="ES256", headers={"kid": mock.kid})
                self._send(200, json.dumps({"access_token": "upstream-access", "token_type": "Bearer", "id_token": token}).encode())

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=lambda: self._server.serve_forever(poll_interval=0.02), daemon=True).start()
        return self

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
