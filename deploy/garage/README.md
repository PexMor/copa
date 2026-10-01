# Reference S3 backend: Garage in Docker

A single-node [Garage](https://garagehq.deuxfleurs.fr/) object store for copa
file sharing — for local testing, and as a template for a small real
deployment. How copa uses it is described in [docs/FILES.md](../../docs/FILES.md).

## Start

```bash
./init.sh          # or: make s3-up   (from the repository root)
```

`init.sh` is safe to re-run. It:

1. creates `.env` from `.env.example` with a freshly generated RPC secret (first run only);
2. starts Garage and assigns the single-node layout;
3. creates the bucket and an access key that may read/write **that bucket only**;
4. sets the bucket CORS policy for the origins in `COPA_CORS_ORIGINS`
   and a lifecycle rule that expires objects after `COPA_LIFECYCLE_DAYS`;
5. prints the `[server.storage]` block for `~/.config/copa/config.toml`
   and saves it to `storage.toml`.

It needs `docker`, `openssl`, and either a local `aws` CLI or the ability to
pull the `amazon/aws-cli` image (used once, for the CORS and lifecycle calls).

`.env` and `storage.toml` hold secrets; both are git-ignored and created with
mode 600.

Stop with `docker compose down` (`make s3-down`); add `-v` to also delete the data.

## What is exposed

| Port | Purpose | Published |
|------|---------|-----------|
| 3900 | S3 API | `127.0.0.1` only |
| 3901 | Garage RPC | no |
| —    | Admin HTTP API | not enabled |
| —    | Static website hosting | not enabled |

Unsigned requests are refused (`curl -i http://127.0.0.1:3900/copa` → 403).
Administration goes through the CLI inside the container:

```bash
docker compose exec garage /garage status
docker compose exec garage /garage bucket info copa
```

## Settings (`.env`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `GARAGE_RPC_SECRET` | generated | Cluster secret. |
| `GARAGE_IMAGE` | `dxflrs/garage:v2.1.0` | Pinned image. |
| `COPA_S3_PORT` | `3900` | Loopback port of the S3 API. |
| `COPA_BUCKET` / `COPA_KEY_NAME` | `copa` / `copa` | Bucket and key created for copasrv. |
| `GARAGE_CAPACITY` | `10G` | Capacity announced for the node. |
| `COPA_CORS_ORIGINS` | local dev origins | Space-separated origins of the web app. Explicit list, never `*` on the internet. |
| `COPA_LIFECYCLE_DAYS` | `8` | Expiry backstop; keep it above your largest `item_ttl_secs`. |
| `COPA_S3_PUBLIC_URL` | `http://127.0.0.1:3900` | What clients use to reach the S3 API; printed as `public_url`. |
| `COPA_HOST`, `COPA_S3_HOST`, `COPA_HTTPS_PORT`, `COPA_UPSTREAM` | `copa.localhost`, `s3.localhost`, `8443`, `127.0.0.1:8080` | Only for the `caddy` profile. |
| `COPA_LOCAL_CERTS` | empty | `local_certs` forces Caddy's internal CA for every hostname (local testing with non-`.localhost` names). |

After changing `COPA_CORS_ORIGINS`, `COPA_LIFECYCLE_DAYS` or
`COPA_S3_PUBLIC_URL`, run `./init.sh` again.

## Reaching it from the internet

Keep Garage and copasrv on loopback and publish them through a reverse proxy on
**two HTTPS hostnames**, for example `copa.example.com` → `127.0.0.1:8080` and
`s3.example.com` → `127.0.0.1:3900`. Then:

```bash
# .env
COPA_S3_PUBLIC_URL=https://s3.example.com
COPA_CORS_ORIGINS="https://copa.example.com"
```

```bash
./init.sh     # prints public_url = "https://s3.example.com" and endpoint = "http://127.0.0.1:3900"
```

and in copa's config add `allowed_origins = ["https://copa.example.com"]` under `[server]`.

The one hard requirement for the proxy: **forward the Host header, path and
query string to Garage unchanged.** They are what a presigned URL's signature
covers. Also allow request bodies as large as copa's `max_file_size` (50 MiB by
default) and pass WebSocket upgrades to copasrv (`/ws`, `/ws/events`).

Examples in [`proxy/`](proxy/):

| File | Proxy | Notes |
|------|-------|-------|
| `Caddyfile` | Caddy | Automatic certificates. Also wired into Compose: `docker compose --profile caddy up -d`. |
| `haproxy.cfg` | HAProxy | Bring your own certificates. Validate with `haproxy -c -f haproxy.cfg`. |
| `cloudflared.yml` | Cloudflare Tunnel | No open inbound ports. 100 MB body limit on Free/Pro. Validate with `cloudflared tunnel --config cloudflared.yml ingress validate`. |

### Try the proxy locally

With the defaults, the `caddy` profile serves `https://copa.localhost:8443` and
`https://s3.localhost:8443` using Caddy's internal CA:

```bash
# .env:  COPA_S3_PUBLIC_URL=https://s3.localhost:8443
./init.sh
docker compose --profile caddy up -d

# trust Caddy's local CA for this shell
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
export SSL_CERT_FILE=$PWD/caddy-root.crt

copacli put --server https://copa.localhost:8443 --token "$TOKEN" some-file
```

Browsers and `curl` resolve `*.localhost` on their own; `copacli` uses the system
resolver, so either add both names to `/etc/hosts` or pick names that already
resolve to `127.0.0.1` and set `COPA_LOCAL_CERTS=local_certs` so Caddy does not
ask Let's Encrypt for them.

`caddy-root.crt` is a public certificate, not a secret, but there is no reason
to commit it.

The full security checklist is in
[docs/FILES.md](../../docs/FILES.md#security-checklist).
