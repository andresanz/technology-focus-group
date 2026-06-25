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

## Certs — one per domain

Each served domain gets its **own** Let's Encrypt cert at
`/etc/letsencrypt/live/<domain>/` (cert-name == domain). No shared SAN cert, so
no 100-name ceiling and each domain renews independently.

Saving a domain in the admin **writes its nginx config and reloads immediately**
— there is no separate sync step. (A bad config rolls back automatically.) A
served domain that has no cert yet is emitted HTTP-only so it still serves and
ACME can validate; it flips to HTTPS once its cert exists.

**First time / adding a live or redirect domain:**
1. Add the domain and set its state — the nginx config is applied on save (HTTP-only until a cert exists).
2. Click **🔒 renew cert** on the domain — runs `sudo site-cert <domain>`, then re-applies so it serves over HTTPS.

Use **🔒 Renew All Certs** to renew every served domain's cert at once. Parked
domains need no cert. The Linode auto-sync only seeds the registry (as parked);
it never writes nginx — that happens when you save a domain here.

**Install the cert script (root, once):**
```bash
cp scripts/site-cert.sh /usr/local/bin/site-cert
chmod 755 /usr/local/bin/site-cert
echo 'root ALL=(ALL) NOPASSWD: /usr/local/bin/site-cert *' \
  > /etc/sudoers.d/site-cert
```

## Parked page

The shared parked page lives in the repo at `assets/parked.html` (a "domain for
sale" page that fills in the visitor's domain + a mailto inquiry link via JS).
Install it to the webroot — nginx falls back to it for all parked domains:

```bash
sudo ./scripts/deploy-assets.sh   # copies assets/parked.html -> /var/www/parked/index.html
```

Edit `assets/parked.html`, commit, then re-run the script to redeploy.

## Redirect files

Written automatically when a redirect domain is saved, to `/var/www/redirects/<domain>/index.html`. Updating the target URL and saving rewrites the file.

## Nginx

Configs are written to `/etc/nginx/sites-available/<domain>` and mirrored to `sites-enabled/`, then `nginx -t && systemctl reload nginx` runs automatically each time a domain is saved.

Certbot auto-renewal (`/etc/cron.d/certbot` or systemd timer) handles ongoing renewal — the `--cert-name platform` flag keeps it at the same path.
