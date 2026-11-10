"""HTTP layer: a small router on the standard library's threading server."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import parse_qs, urlsplit

from .config import Settings

log = logging.getLogger("token_issuer")


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    body: bytes = b""

    def form(self) -> dict[str, str]:
        return {k: v[-1] for k, v in parse_qs(self.body.decode("utf-8", "replace"), keep_blank_values=True).items()}

    def json(self) -> dict:
        try:
            value = json.loads(self.body or b"{}")
        except json.JSONDecodeError:
            raise HttpError(400, "invalid_request", "body is not valid JSON") from None
        if not isinstance(value, dict):
            raise HttpError(400, "invalid_request", "body must be a JSON object")
        return value


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    content_type: str = "application/json"
    headers: dict[str, str] = field(default_factory=dict)

    @staticmethod
    def json(data: object, status: int = 200, headers: dict[str, str] | None = None) -> "Response":
        return Response(status, json.dumps(data).encode(), "application/json", headers or {})

    @staticmethod
    def html(markup: str, status: int = 200, headers: dict[str, str] | None = None) -> "Response":
        return Response(status, markup.encode(), "text/html; charset=utf-8", headers or {})


class HttpError(Exception):
    def __init__(self, status: int, code: str, description: str = "") -> None:
        super().__init__(description or code)
        self.status, self.code, self.description = status, code, description


Handler = Callable[[Request], Response]


class App:
    """Routes requests; everything is testable without a socket through `dispatch`."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._routes: dict[tuple[str, str], Handler] = {}
        self.route("GET", "/healthz", self._health)

    def route(self, method: str, path: str, handler: Handler) -> None:
        self._routes[(method.upper(), path)] = handler

    def _health(self, _req: Request) -> Response:
        return Response.json({"status": "ok"})

    def dispatch(self, req: Request) -> Response:
        handler = self._routes.get((req.method.upper(), req.path))
        if handler is None:
            allowed = sorted({m for (m, p) in self._routes if p == req.path})
            if allowed:
                return Response.json({"error": "method_not_allowed"}, 405, {"Allow": ", ".join(allowed)})
            return Response.json({"error": "not_found"}, 404)
        try:
            return handler(req)
        except HttpError as e:
            return Response.json({"error": e.code, "error_description": e.description}, e.status)
        except Exception:  # noqa: BLE001 - last-resort guard for the test service
            log.exception("unhandled error in %s %s", req.method, req.path)
            return Response.json({"error": "server_error"}, 500)


def make_server(app: App, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _serve(self) -> None:
            parts = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            req = Request(
                method=self.command,
                path=parts.path,
                query={k: v[-1] for k, v in parse_qs(parts.query, keep_blank_values=True).items()},
                headers={k.lower(): v for k, v in self.headers.items()},
                body=self.rfile.read(length) if length else b"",
            )
            res = app.dispatch(req)
            self.send_response(res.status)
            self.send_header("Content-Type", res.content_type)
            self.send_header("Content-Length", str(len(res.body)))
            for k, v in res.headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(res.body)

        do_GET = do_POST = do_OPTIONS = do_DELETE = _serve  # noqa: N815

        def log_message(self, fmt: str, *args: object) -> None:  # route access logs through logging
            log.debug("%s - %s", self.address_string(), fmt % args)

    return ThreadingHTTPServer((host, port), Handler)
