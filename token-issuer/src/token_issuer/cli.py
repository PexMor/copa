"""Entry point: `token-issuer`."""

from __future__ import annotations

import logging

from .config import build_parser, settings_from_args
from .app import build_app
from .server import make_server


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname).1s %(message)s")
    probe = settings_from_args(args)
    app = build_app(probe)
    server = make_server(app, args.host, args.port)
    bound = server.server_address[1]
    app.settings = settings_from_args(args, bound_port=bound)
    logging.getLogger("token_issuer").info("listening on %s (issuer %s)", f"{args.host}:{bound}", app.settings.public_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
