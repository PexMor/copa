# copa Ansible deployment

Pushes prebuilt binaries (from `../bin/`, see `make dist`), the frontend and a `systemd --user`
unit to the target hosts. Nothing is built on the targets; no root/`become` is used. Everything
lives in the SSH user's `$HOME`.

## Setup

```bash
uv tool install ansible-core           # once
make dist                               # ../bin/{x86_64,arm64,armhf}/ + ../bin/frontend/
cp inventory.example.toml inventory.toml  # git-ignored; edit hosts
```

Per-host config (only needed for `install`/`overwrite`, see below): copy
`files/config/host.example.toml` to `files/config/<inventory_hostname>.toml`. See `files/README.md`.

## Run

```bash
ansible-playbook site.yml --tags preflight --check   # report only: arch, config, frontend, work dir, unit, bus, linger
ansible-playbook site.yml --limit srv1 --check --diff # dry run of a deploy
ansible-playbook site.yml --limit srv1                # deploy
```

Preflight always runs first and fails (before any change) when a build artifact for the host's
architecture is missing, the policy/token is invalid, or a required `files/` entry is absent.

| Host `uname -m` | Build arch | Notes |
|---|---|---|
| `x86_64` | `x86_64` | static musl |
| `aarch64` | `arm64` | dynamic, needs glibc >= 2.31 |
| `armv7l` / `armv8l` | `armhf` | Raspberry Pi 3B+ on a 32-bit OS; static musl. A 64-bit Pi OS is `aarch64`. |

## Server or client per host

Set `copa_role` per host in `inventory.toml` (default `client`; only hosts with `copa_role = "server"` run the service):

```toml
[copa.hosts.srv1]
ansible_host = "srv1.example.com"
copa_role = "server"     # service enabled and started

[copa.hosts.pi1]
ansible_host = "pi1.example.com"
copa_role = "client"     # same files installed, service stopped and disabled
```

Both roles get `copasrv`, `copacli`, the frontend, the work dir, the unit and the config per the
policy below; only the service (and linger) is server-only. On a client the service is stopped and
disabled on every run, and it starts again only after you explicitly set `copa_role = "server"`. Override ad hoc with
`-e copa_role=client --limit pi1`.

## Config is never overwritten without approval

`~/.config/copa/config.toml` is governed by `copa_config_policy`:

| Policy | Behaviour |
|---|---|
| `keep` (default) | Never touched. If missing, it is reported and the service is **not** started. |
| `install` | Created from `files/config/<host>.toml` only if missing (mode `0600`). Existing files untouched. |
| `overwrite` | Replaces an existing config. Requires `-e copa_config_overwrite_confirm=<inventory_hostname>`; a timestamped `config.toml.<ts>.bak` (`0600`) is made first. A wrong/missing token fails before any change. |

```bash
ansible-playbook site.yml --limit pi1 -e copa_config_policy=install
ansible-playbook site.yml --limit pi1 -e copa_config_policy=overwrite -e copa_config_overwrite_confirm=pi1
```

## What gets installed

| Item | Path |
|---|---|
| `copasrv`, `copacli` (previous kept as `*.prev`) | `~/.local/bin/` |
| frontend (`COPA_STATIC_DIR`) | `~/.local/share/copa/dist/` |
| working dir (`0700`) | `~/.local/share/copa/work/` |
| unit | `~/.config/systemd/user/copasrv.service` |

The service is enabled and started only when a config exists and a user systemd session is
available; it restarts only when a binary, the frontend, the unit or the config changed. Without
a login session the user bus is absent: pass `-e copa_enable_linger=true` (runs
`loginctl enable-linger`). Files deleted from the frontend build are not removed on the host.

Known limitation: `copasrv` currently always reads `$HOME/.config/copa/config.toml` (its
`--config`/`COPA_CONFIG` option is declared but ignored), so do not change `copa_config_dir`.

## Optional: file sharing via S3 / Garage (`[server.storage]`)

Extends a **running** instance with presigned-URL file sharing (see `../docs/FILES.md`) without
replacing its config. Opt-in; with `copa_config_policy=keep` only the `[server.storage]` block is
managed (between `# BEGIN/END ANSIBLE MANAGED [server.storage]` markers, a `0600` timestamped
`config.toml.<ts>.bak` is made first) and the rest of the file stays byte-for-byte unchanged.
The secret never enters `config.toml`: it is written to `~/.config/copa/storage.env` (`0600`) and
loaded by the unit as `COPA_S3_SECRET_ACCESS_KEY`.

```bash
cp files/storage.example.yml files/storage.yml      # git-ignored; fill in, chmod 600
ansible-playbook site.yml --limit srv1 -e copa_storage_enabled=true --check --diff
ansible-playbook site.yml --limit srv1 -e copa_storage_enabled=true            # or: --tags storage
ansible-playbook site.yml --limit srv1 -e copa_storage_remove=true             # remove block + secret
```

| Variable / `storage.yml` key | Meaning |
|---|---|
| `copa_storage_public_url` / `public_url` | what clients reach (required; `https` unless loopback, or `copa_storage_allow_insecure=true`) |
| `copa_storage_bucket`, `..._access_key_id`, `..._secret_access_key` | required |
| `copa_storage_endpoint`, `..._region`, `..._key_prefix`, `..._presign_ttl_secs` | optional (TTL 1-604800) |

Explicit `-e copa_storage_*` variables override `files/storage.yml`. Preflight fails (nothing
changed) on incomplete settings, on a hand-written `[server.storage]` outside the markers, or when
no config exists on the host (the storage step is then skipped). A change restarts the service,
which empties the in-memory history; use **one `key_prefix` per instance** because copasrv deletes
unknown objects under its prefix. Provision Garage/CORS separately (`make s3-up`, `../deploy/garage/`).

## Optional: Cloudflare cache purge

`cp files/cloudflare.example.yml files/cloudflare.yml`, fill in zone and API token, then add
`-e copa_cf_purge=true` (purges the whole zone cache after deploy; replaces `30_purge_cache.sh`).

## Variables

See `roles/copa/defaults/main.yml` (paths, `copa_service_name`, `copa_binaries`, ...).
