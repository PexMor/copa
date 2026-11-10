"""Drive a complete popup login through dex and check the token the issuer signs.

Needs a running dex (dev/docker-compose.yml) and a token issuer started in upstream mode
(see dev/run-dex-demo.sh). Pure standard library plus PyJWT.

    uv run python dev/dex_login_check.py [--issuer http://127.0.0.1:8090]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import http.cookiejar
import json
import re
import sys
import urllib.parse
import urllib.request

import jwt
from jwt import PyJWKSet


def s256(v: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--issuer", default="http://127.0.0.1:8090")
    ap.add_argument("--origin", default="http://localhost:5180")
    ap.add_argument("--audience", default="https://copa.example.com")
    ap.add_argument("--user", default="admin@example.com")
    ap.add_argument("--password", default="password")
    args = ap.parse_args()

    verifier = "v" * 43
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    # 1. the popup URL: issuer -> dex authorize -> dex login form
    q = urllib.parse.urlencode({"audience": args.audience, "origin": args.origin, "challenge": s256(verifier)})
    with opener.open(f"{args.issuer}/login?{q}", timeout=15) as r:
        page, url = r.read().decode(), r.geturl()
    print(f"dex login page: {url}")
    form = re.search(r'<form[^>]*action="([^"]*)"', page)
    if not form:
        print("no login form found:\n" + page[:500])
        return 1
    action = urllib.parse.urljoin(url, html.unescape(form.group(1)))

    # 2. submit the credentials; dex redirects back to the issuer's callback, which renders the result page
    data = urllib.parse.urlencode({"login": args.user, "password": args.password}).encode()
    with opener.open(urllib.request.Request(action, data=data), timeout=15) as r:
        result = r.read().decode()
    m = re.search(r"const msg = (\{.*?\});", result)
    if not m:
        print("the issuer did not return a login result:\n" + result[:500])
        return 1
    msg = json.loads(m.group(1))
    print("popup message:", {k: (v[:8] + "…" if k == "login_code" else v) for k, v in msg.items()})
    assert msg["type"] == "copa-login", msg

    # 3. redeem the code like the widget does
    req = urllib.request.Request(f"{args.issuer}/token", method="POST", headers={"Content-Type": "application/json"},
                                 data=json.dumps({"login_code": msg["login_code"], "verifier": verifier}).encode())
    with opener.open(req, timeout=15) as r:
        tokens = json.loads(r.read())

    # 4. verify it like a resource server would
    with opener.open(f"{args.issuer}/jwks.json", timeout=15) as r:
        jwks = json.loads(r.read())
    key = PyJWKSet.from_dict(jwks)[jwt.get_unverified_header(tokens["access_token"])["kid"]]
    claims = jwt.decode(tokens["access_token"], key.key, algorithms=["ES256"], audience=args.audience, issuer=args.issuer)
    print("claims:", json.dumps({k: claims[k] for k in ("iss", "sub", "aud", "email", "name", "groups", "scope")}))
    assert claims["email"] == args.user, claims
    assert claims["scope"] == "copa:team:rw copa:public:r", claims["scope"]
    assert "id_token" not in tokens and "access_token" in tokens
    print("OK: login through dex produced a signed token with mapped claims")
    return 0


if __name__ == "__main__":
    sys.exit(main())
