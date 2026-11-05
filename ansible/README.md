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

## Optional: Cloudflare cache purge

`cp files/cloudflare.example.yml files/cloudflare.yml`, fill in zone and API token, then add
`-e copa_cf_purge=true` (purges the whole zone cache after deploy; replaces `30_purge_cache.sh`).

## Variables

See `roles/copa/defaults/main.yml` (paths, `copa_service_name`, `copa_binaries`, ...).
