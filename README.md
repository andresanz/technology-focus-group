# technology-focus-group

Minimal domain admin. Manages a registry of domains (live / redirect / parked), writes nginx configs, and keeps everyone on a single shared SSL cert.

## Setup

```bash
cp .env.example .env   # fill in ADMIN_PASSWORD and SESSION_SECRET
npm install
node app.js            # listens on 127.0.0.1:4000
```

## Domain states

| State | What nginx does |
|-------|----------------|
| **live** | Proxy to `127.0.0.1:<port>` — a site app running there |
| **redirect** | Serve `/var/www/redirects/<domain>/index.html` (meta-refresh + JS) |
| **parked** | Serve `/var/www/parked/index.html` |

## One cert for everyone

All domains share a single Let's Encrypt SAN cert at `/etc/letsencrypt/live/platform/`.

**First time / adding a domain:**
1. Add the domain in the admin and set its state.
2. Click **⟳ Sync All** to write nginx configs (HTTP-only until cert is ready).
3. Click **🔒 Renew Cert** — runs `sudo platform-cert <all domains>` to issue/expand the cert.
4. Click **⟳ Sync All** again — all configs now point at the platform cert.

**Install the cert script (root, once):**
```bash
cp scripts/platform-cert.sh /usr/local/bin/platform-cert
chmod 755 /usr/local/bin/platform-cert
echo 'www-data ALL=(ALL) NOPASSWD: /usr/local/bin/platform-cert *' \
  > /etc/sudoers.d/platform-cert
```

## Parked page

Put an `index.html` at `/var/www/parked/index.html`. Nginx falls back to it for all parked domains.

## Redirect files

Written automatically on sync to `/var/www/redirects/<domain>/index.html`. Updating the target URL and syncing rewrites the file — no nginx reload needed beyond the initial config write.

## Nginx

Configs are written to `/etc/nginx/sites-available/<domain>` and mirrored to `sites-enabled/`. The app needs `nginx -t && systemctl reload nginx` after config changes (done automatically on sync).

Certbot auto-renewal (`/etc/cron.d/certbot` or systemd timer) handles ongoing renewal — the `--cert-name platform` flag keeps it at the same path.
