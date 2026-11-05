# ansible/files

Deployment-specific data. Real files here are **git-ignored** (they may hold tokens, Cloudflare
Access secrets or API keys); only `*.example.*` and this README are tracked.

| File | Purpose |
|------|---------|
| `config/<inventory_hostname>.toml` | copa `config.toml` for that host. Needed only when `copa_config_policy` is `install` or `overwrite`. May carry Cloudflare Access headers in `[cli.remotes.*].headers`. Start from `config/host.example.toml`. |
| `cloudflare.yml` | Optional. Cloudflare zone/API key for `-e copa_cf_purge=true` cache purge. Start from `cloudflare.example.yml`. |

Tasks handling these files run with `no_log`. Keep file mode `0600`.
