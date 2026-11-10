"""Layered configuration: CLI > environment > config file > defaults."""

from __future__ import annotations

from dataclasses import dataclass

from pathlib import Path

import configargparse

from .upstream import UpstreamConfig, load_rules

PKG_NAME = "token-issuer"
ENV_PREFIX = "TOKEN_ISSUER_"


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    #: Externally visible base URL; becomes the JWT `iss` and prefixes every endpoint URL.
    public_url: str
    log_level: str
    #: Where signing keys are kept; None = in memory only (regenerated on every start).
    state_dir: Path | None = None
    #: Enables the /admin/* test endpoints (key rotation); off when empty.
    admin_token: str | None = None
    #: JSON file with the fake users (see users.example.json); None = built-in defaults.
    users_file: Path | None = None
    #: Lifetime of access tokens in seconds (copa recommends 300-900).
    access_ttl: int = 600
    #: Lifetime of refresh tokens in seconds.
    refresh_ttl: int = 86400
    #: Origins of the applications that may start logins / call the token endpoints.
    #: Empty = loopback origins only (http://localhost*, http://127.0.0.1*).
    allowed_origins: tuple[str, ...] = ()
    #: Audiences tokens may be issued for; empty = any requested audience.
    allowed_audiences: tuple[str, ...] = ()
    #: Fault injection switches active from the start (`name` or `name:parameter`).
    faults: tuple[str, ...] = ()
    #: When set, users sign in at this OIDC provider instead of the fake-user form.
    upstream: UpstreamConfig | None = None


def build_parser() -> configargparse.ArgumentParser:
    parser = configargparse.ArgumentParser(
        prog=PKG_NAME,
        description="Independent token service for testing the copa widget and copasrv.",
        default_config_files=[f"~/.config/{PKG_NAME}/config.toml"],
        config_file_parser_class=configargparse.TomlConfigParser(sections=[PKG_NAME]),
    )
    parser.add_argument("-c", "--config", is_config_file=True, help="path to an alternate config file")
    parser.add_argument(
        "--host", default="127.0.0.1", env_var=f"{ENV_PREFIX}HOST",
        help="IP address to bind to (default: %(default)s). Endpoints are public by design, like an IdP; "
             "keep this on loopback unless you know why not.",
    )
    parser.add_argument(
        "--port", type=int, default=8090, env_var=f"{ENV_PREFIX}PORT",
        help="port to bind to; 0 picks a free port (default: %(default)s)",
    )
    parser.add_argument(
        "--public-url", default=None, env_var=f"{ENV_PREFIX}PUBLIC_URL",
        help="externally visible base URL, used as the token issuer (default: http://<host>:<port>)",
    )
    parser.add_argument(
        "--log-level", default="info", choices=["debug", "info", "warning", "error"],
        env_var=f"{ENV_PREFIX}LOG_LEVEL", help="log verbosity (default: %(default)s)",
    )
    parser.add_argument(
        "--state-dir", default="~/.local/state/token-issuer", env_var=f"{ENV_PREFIX}STATE_DIR",
        help="directory for persistent signing keys (default: %(default)s)",
    )
    parser.add_argument(
        "--ephemeral", action="store_true", env_var=f"{ENV_PREFIX}EPHEMERAL",
        help="keep signing keys in memory only (new keys on every start)",
    )
    parser.add_argument(
        "--admin-token", default=None, env_var=f"{ENV_PREFIX}ADMIN_TOKEN",
        help="enable /admin/* test endpoints (key rotation) protected by this bearer token",
    )
    parser.add_argument(
        "--users-file", default=None, env_var=f"{ENV_PREFIX}USERS_FILE",
        help="JSON file with the fake users shown on the login page (default: built-in alice/bob/carol)",
    )
    parser.add_argument(
        "--access-ttl", type=int, default=600, env_var=f"{ENV_PREFIX}ACCESS_TTL",
        help="access token lifetime in seconds (default: %(default)s)",
    )
    parser.add_argument(
        "--refresh-ttl", type=int, default=86400, env_var=f"{ENV_PREFIX}REFRESH_TTL",
        help="refresh token lifetime in seconds (default: %(default)s)",
    )
    parser.add_argument(
        "--allowed-origin", action="append", default=[], env_var=f"{ENV_PREFIX}ALLOWED_ORIGINS",
        help="origin of an application allowed to use this service; repeatable "
             "(env: comma-separated; default: loopback origins only)",
    )
    parser.add_argument(
        "--allowed-audience", action="append", default=[], env_var=f"{ENV_PREFIX}ALLOWED_AUDIENCES",
        help="audience tokens may be issued for; repeatable (default: any)",
    )
    parser.add_argument(
        "--fault", action="append", default=[], env_var=f"{ENV_PREFIX}FAULTS",
        help="activate a fault-injection switch (name or name:parameter), repeatable; "
             "see the README for the list",
    )
    parser.add_argument("--upstream-issuer", default=None, env_var=f"{ENV_PREFIX}UPSTREAM_ISSUER",
                        help="OIDC issuer URL: users sign in there instead of the fake-user form")
    parser.add_argument("--upstream-client-id", default=None, env_var=f"{ENV_PREFIX}UPSTREAM_CLIENT_ID",
                        help="client id registered at the upstream provider")
    parser.add_argument("--upstream-client-secret", default=None, env_var=f"{ENV_PREFIX}UPSTREAM_CLIENT_SECRET",
                        help="client secret registered at the upstream provider (prefer the env var)")
    parser.add_argument("--upstream-scopes", default="openid email profile", env_var=f"{ENV_PREFIX}UPSTREAM_SCOPES",
                        help="scopes requested upstream (default: %(default)s)")
    parser.add_argument("--upstream-map-file", default=None, env_var=f"{ENV_PREFIX}UPSTREAM_MAP_FILE",
                        help='JSON {"rules":[{"claim","value","scope"}]} mapping upstream claims to copa scopes')
    parser.add_argument("--upstream-groups-claim", default="groups", env_var=f"{ENV_PREFIX}UPSTREAM_GROUPS_CLAIM",
                        help="ID-token claim that holds the user's groups (default: %(default)s)")
    return parser


def _upstream(args: configargparse.Namespace) -> UpstreamConfig | None:
    if not args.upstream_issuer:
        return None
    if not args.upstream_client_id or not args.upstream_client_secret:
        raise SystemExit("--upstream-issuer needs --upstream-client-id and --upstream-client-secret "
                         f"(or {ENV_PREFIX}UPSTREAM_CLIENT_ID / {ENV_PREFIX}UPSTREAM_CLIENT_SECRET)")
    return UpstreamConfig(
        issuer=args.upstream_issuer, client_id=args.upstream_client_id, client_secret=args.upstream_client_secret,
        scopes=args.upstream_scopes,
        rules=load_rules(Path(args.upstream_map_file).expanduser() if args.upstream_map_file else None),
        groups_claim=args.upstream_groups_claim,
    )


def _listify(value: object) -> tuple[str, ...]:
    items = value if isinstance(value, list) else [value]
    out: list[str] = []
    for item in items:
        out.extend(p.strip() for p in str(item).split(",") if p.strip())
    return tuple(out)


def settings_from_args(args: configargparse.Namespace, *, bound_port: int | None = None) -> Settings:
    port = bound_port if bound_port is not None else args.port
    public = args.public_url or f"http://{args.host}:{port}"
    state_dir = None if args.ephemeral else Path(args.state_dir).expanduser()
    return Settings(
        host=args.host, port=port, public_url=public.rstrip("/"), log_level=args.log_level,
        state_dir=state_dir, admin_token=args.admin_token or None,
        users_file=Path(args.users_file).expanduser() if args.users_file else None,
        access_ttl=args.access_ttl, refresh_ttl=args.refresh_ttl,
        allowed_origins=_listify(args.allowed_origin), allowed_audiences=_listify(args.allowed_audience),
        faults=_listify(args.fault), upstream=_upstream(args),
    )
