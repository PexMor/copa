"""Wires the services into an :class:`App` with all contract routes."""

from __future__ import annotations

import re
import secrets
import time
import urllib.parse
from typing import Callable

from .config import Settings
from .faults import FaultError, Faults, adjust_claims, jwks_fault_response, sign_token
from .keys import KeyError_, KeyStore
from .pages import error_page, login_page, result_page
from .server import App, HttpError, Request, Response
from .store import GrantError, Login, Session, Store
from .tokens import access_claims
from .upstream import Upstream, UpstreamError, user_from_claims
from .users import Users

DISCOVERY_PATH = "/.well-known/copa-token-service"
LOGIN_TTL = 300   # seconds a started login stays valid
CODE_TTL = 60     # seconds a login code can be redeemed
_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")          # base64url(sha256)
_STATE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_LOOPBACK_ORIGIN = re.compile(r"^http://(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$")


def discovery_document(base: str) -> dict:
    """The widget <-> token-service contract: where everything lives."""
    return {
        "issuer": base,
        "jwks_uri": f"{base}/jwks.json",
        "login_url": f"{base}/login",
        "poll_url": f"{base}/poll",
        "token_url": f"{base}/token",
        "refresh_url": f"{base}/refresh",
        "logout_url": f"{base}/logout",
    }


def _no_store() -> dict[str, str]:
    return {"Cache-Control": "no-store", "Pragma": "no-cache"}


class Issuer(App):
    def __init__(self, settings: Settings, keys: KeyStore | None = None, clock: Callable[[], float] = time.time) -> None:
        super().__init__(settings)
        self.clock = clock
        self.keys = keys or KeyStore(settings.state_dir)
        self.users = Users.load(settings.users_file)
        self.store = Store(clock)
        self.faults = Faults(settings.faults)
        self.upstream = Upstream(settings.upstream, lambda: self.settings.public_url) if settings.upstream else None

        self.route("GET", DISCOVERY_PATH, self._discovery)
        self.route("GET", "/jwks.json", self._jwks)
        self.route("GET", "/login", self._login)
        self.route("POST", "/login/submit", self._login_submit)
        self.route("GET", "/login/callback", self._login_callback)
        self.route("POST", "/login/detached", self._login_detached)
        for path, handler in (("/poll", self._poll), ("/token", self._token),
                              ("/refresh", self._refresh), ("/logout", self._logout)):
            self.route("POST", path, self._api(handler))
            self.route("OPTIONS", path, self._preflight)
        if settings.admin_token:
            self.route("POST", "/admin/rotate-key", self._admin(self._rotate))
            self.route("POST", "/admin/retire-key", self._admin(self._retire))
            self.route("GET", "/admin/faults", self._admin(self._get_faults))
            self.route("POST", "/admin/faults", self._admin(self._set_faults))

    # -- origin policy ------------------------------------------------------------------------

    def origin_allowed(self, origin: str) -> bool:
        allowed = self.settings.allowed_origins
        return origin in allowed if allowed else bool(_LOOPBACK_ORIGIN.match(origin))

    def audience_allowed(self, audience: str) -> bool:
        allowed = self.settings.allowed_audiences
        return not allowed or audience in allowed

    @staticmethod
    def _cors(origin: str) -> dict[str, str]:
        return {
            "Access-Control-Allow-Origin": origin, "Vary": "Origin",
            "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Max-Age": "600",
        }

    def _preflight(self, req: Request) -> Response:
        origin = req.headers.get("origin", "")
        if not origin or not self.origin_allowed(origin):
            return Response.json({"error": "origin_not_allowed"}, 403)
        return Response(204, b"", "text/plain", self._cors(origin))

    def _api(self, handler: Callable[[Request], Response]) -> Callable[[Request], Response]:
        """JSON endpoint called by the widget: origin allow-list, CORS, no-store, OAuth-style errors."""

        def wrapped(req: Request) -> Response:
            origin = req.headers.get("origin")
            if origin and not self.origin_allowed(origin):
                return Response.json({"error": "origin_not_allowed"}, 403)
            headers = {**_no_store(), **(self._cors(origin) if origin else {})}
            try:
                res = handler(req)
            except GrantError as e:
                res = Response.json({"error": "invalid_grant", "error_description": str(e)}, 400)
            except HttpError as e:
                res = Response.json({"error": e.code, "error_description": e.description}, e.status)
            res.headers.update(headers)
            return res

        return wrapped

    # -- public documents ------------------------------------------------------------------------

    def _discovery(self, _req: Request) -> Response:
        return Response.json(
            discovery_document(self.settings.public_url),
            headers={"Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"},
        )

    def _jwks(self, _req: Request) -> Response:
        fault = jwks_fault_response(self.faults)
        if fault:
            status, delay = fault
            if delay:
                time.sleep(delay)
            if status != 200:
                return Response.json({"error": "server_error", "error_description": "injected fault: jwks-fail"}, status)
        return Response.json(self.keys.jwks(), headers={"Cache-Control": "max-age=60", "Access-Control-Allow-Origin": "*"})

    # -- popup ---------------------------------------------------------------------------------------

    def _page_headers(self, nonce: str | None = None) -> dict[str, str]:
        script = f"script-src 'nonce-{nonce}'; " if nonce else ""
        coop = {"Cross-Origin-Opener-Policy": "same-origin"} if self.faults.has("coop") else {}
        return {
            **coop,
            **_no_store(),
            "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": f"default-src 'none'; {script}style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        }

    def _bad_login_request(self, text: str) -> Response:
        return Response.html(error_page("Cannot sign in", text), 400, self._page_headers())

    def _login(self, req: Request) -> Response:
        q = req.query
        audience, origin, challenge = q.get("audience", ""), q.get("origin", ""), q.get("challenge", "")
        redirect_uri = state = None
        if q.get("mode") == "redirect":
            # Full-page flow for popup-hostile environments: the user comes back to `redirect_uri`
            # with the login code in the URL fragment (never sent to any server, cleared by the widget).
            redirect_uri, state = q.get("redirect_uri", ""), q.get("state", "")
            parts = urllib.parse.urlsplit(redirect_uri)
            if parts.scheme not in ("http", "https") or not parts.netloc or parts.username or parts.password:
                return self._bad_login_request("The redirect address is not valid.")
            origin = f"{parts.scheme}://{parts.netloc}"           # the origin is derived, not claimed
            redirect_uri = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
            if not _STATE.match(state):
                return self._bad_login_request("The sign-in request is missing a valid state.")
        if not origin or not self.origin_allowed(origin):
            return self._bad_login_request("The application that started this sign-in is not allowed to use this service.")
        if not audience or not self.audience_allowed(audience):
            return self._bad_login_request("This service does not issue tokens for the requested audience.")
        if not _CHALLENGE.match(challenge):
            return self._bad_login_request("The sign-in request is missing a valid challenge.")
        login = self.store.new_login(audience, origin, challenge, LOGIN_TTL, redirect_uri, state)
        if self.upstream:
            try:
                url = self.upstream.authorize_url(login.id)
            except UpstreamError as e:
                return Response.html(error_page("Cannot sign in", str(e)), 502, self._page_headers())
            return Response(302, b"", "text/plain", {**self._page_headers(), "Location": url})
        nonce = secrets.token_urlsafe(12)
        return Response.html(login_page(login.id, audience, self.users.all(), nonce=nonce), 200, self._page_headers(nonce))

    def _deliver(self, login: Login, *, code: str | None = None, error: str | None = None, text: str) -> Response:
        """Hand the result to the application: postMessage page (popup) or a redirect (full page)."""
        if login.redirect_uri:
            frag = urllib.parse.urlencode({"copa_login_code": code, "state": login.state} if code
                                          else {"copa_login_error": error or "failed", "state": login.state})
            return Response(303, b"", "text/plain", {**self._page_headers(), "Location": f"{login.redirect_uri}#{frag}"})
        nonce = secrets.token_urlsafe(12)
        message = ({"type": "copa-login", "login_id": login.id, "login_code": code} if code
                   else {"type": "copa-login-error", "login_id": login.id, "error": error or "failed"})
        page = result_page(nonce=nonce, origin=login.origin, text=text, message=message)
        return Response.html(page, 200, self._page_headers(nonce))

    def _login_callback(self, req: Request) -> Response:
        """Return from the upstream provider (only used in upstream mode)."""
        if not self.upstream:
            return Response.json({"error": "not_found"}, 404)
        q = req.query
        login = self.store.get_login(q.get("state", ""))
        if login is None:
            return self._bad_login_request("This sign-in has expired. Close the window and try again.")
        if q.get("error"):
            self.store.deny_login(login)
            return self._deliver(login, error=q["error"], text=f"Sign-in failed: {q['error']}")
        try:
            claims = self.upstream.complete(login.id, q.get("code", ""))
        except UpstreamError as e:
            self.store.deny_login(login)
            return Response.html(error_page("Cannot sign in", str(e)), 502, self._page_headers())
        user = user_from_claims(claims, self.settings.upstream)  # type: ignore[arg-type]
        self.users.upsert(user)
        try:
            code = self.store.complete_login(login, user.id, CODE_TTL)
        except GrantError:
            return self._bad_login_request("This sign-in was already finished. Close the window and try again.")
        return self._deliver(login, code=code, text=f"Signed in as {user.name}.")

    def _login_submit(self, req: Request) -> Response:
        if self.upstream:  # the fake-user form must not be a way around the upstream provider
            return Response.json({"error": "not_found"}, 404)
        form = req.form()
        login = self.store.get_login(form.get("login_id", ""))
        if login is None:
            return self._bad_login_request("This sign-in has expired. Close the window and try again.")
        if form.get("action") == "cancel":
            self.store.deny_login(login)
            return self._deliver(login, error="cancelled", text="Sign-in cancelled.")
        user = self.users.get(form.get("user", ""))
        if user is None or not user.check_password(form.get("password")):
            retry_nonce = secrets.token_urlsafe(12)
            page = login_page(login.id, login.audience, self.users.all(), error="Wrong user or password.",
                              selected=form.get("user"), nonce=retry_nonce)
            return Response.html(page, 401, self._page_headers(retry_nonce))
        try:
            code = self.store.complete_login(login, user.id, CODE_TTL)
        except GrantError:
            return self._bad_login_request("This sign-in was already finished. Close the window and try again.")
        return self._deliver(login, code=code, text=f"Signed in as {user.name}.")

    # -- contract endpoints (JSON) --------------------------------------------------------------------

    @staticmethod
    def _str(body: dict, key: str) -> str:
        v = body.get(key)
        if not isinstance(v, str) or not v:
            raise HttpError(400, "invalid_request", f"{key} is required")
        return v

    def _poll(self, req: Request) -> Response:
        status, code, detached = self.store.poll(self._str(req.json(), "verifier"))
        return Response.json({"status": status, "detached": detached, **({"login_code": code} if code else {})})

    def _login_detached(self, req: Request) -> Response:
        """Called by the popup page when it has no opener (COOP): not an authenticated endpoint,
        it only flips a flag on a login whose unguessable id the caller knows."""
        if not self.store.mark_detached(self._str(req.json(), "login_id")):
            raise HttpError(404, "not_found", "unknown or expired login")
        return Response.json({"ok": True})

    def _pair(self, session: Session, refresh_token: str, refresh_expires: float) -> Response:
        user = self.users.get(session.user_id)
        if user is None:
            raise GrantError("user no longer exists")
        now = self.clock()
        claims = adjust_claims(
            access_claims(issuer=self.settings.public_url, user=user, audience=session.audience,
                          ttl=self.settings.access_ttl, now=now),
            self.faults, now,
        )
        token = sign_token(self.keys, claims, self.faults)
        return Response.json({
            "token_type": "Bearer",
            "access_token": token,
            "expires_in": self.settings.access_ttl,
            "access_expires_at": claims["exp"] * 1000,
            "refresh_token": refresh_token,
            "refresh_expires_at": int(refresh_expires * 1000),
            "scope": claims["scope"],
            "sub": user.id,
        })

    def _token(self, req: Request) -> Response:
        body = req.json()
        login = self.store.redeem_code(self._str(body, "login_code"), self._str(body, "verifier"))
        session = self.store.new_session(login.user_id or "", login.audience)
        refresh, expires = self.store.issue_refresh(session.sid, self.settings.refresh_ttl)
        return self._pair(session, refresh, expires)

    def _refresh(self, req: Request) -> Response:
        session, refresh, expires = self.store.rotate_refresh(self._str(req.json(), "refresh_token"), self.settings.refresh_ttl)
        return self._pair(session, refresh, expires)

    def _logout(self, req: Request) -> Response:
        self.store.revoke_by_refresh(self._str(req.json(), "refresh_token"))  # idempotent: unknown tokens are fine
        return Response.json({"ok": True})

    # -- admin (tests only; enabled by --admin-token) ----------------------------------------------------

    def _admin(self, handler: Callable[[Request], Response]) -> Callable[[Request], Response]:
        expected = self.settings.admin_token or ""

        def wrapped(req: Request) -> Response:
            scheme, _, token = req.headers.get("authorization", "").partition(" ")
            if scheme.lower() != "bearer" or not secrets.compare_digest(token, expected):
                raise HttpError(401, "unauthorized", "admin token required")
            return handler(req)

        return wrapped

    def _get_faults(self, _req: Request) -> Response:
        return Response.json({"faults": self.faults.names()})

    def _set_faults(self, req: Request) -> Response:
        specs = req.json().get("faults", [])
        if not isinstance(specs, list) or not all(isinstance(x, str) for x in specs):
            raise HttpError(400, "invalid_request", "faults must be a list of strings")
        try:
            self.faults.set(specs)
        except FaultError as e:
            raise HttpError(400, "invalid_request", str(e)) from None
        return Response.json({"faults": self.faults.names()})

    def _rotate(self, _req: Request) -> Response:
        return Response.json({"kid": self.keys.rotate().kid})

    def _retire(self, req: Request) -> Response:
        kid = req.json().get("kid")
        if not isinstance(kid, str):
            raise HttpError(400, "invalid_request", "kid is required")
        try:
            self.keys.retire(kid)
        except KeyError_ as e:
            raise HttpError(409, "conflict", str(e)) from None
        return Response.json({"retired": kid})


def build_app(settings: Settings) -> Issuer:
    return Issuer(settings)
