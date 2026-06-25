'use strict';

const fs   = require('fs');
const path = require('path');

const SITES_AVAILABLE = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
const SITES_ENABLED   = process.env.NGINX_SITES_ENABLED   || '/etc/nginx/sites-enabled';
const REDIRECTS_ROOT  = process.env.REDIRECTS_ROOT        || '/var/www/redirects';
const PARKED_ROOT     = process.env.PARKED_ROOT           || '/var/www/parked';
const CERT_DIR        = process.env.PLATFORM_CERT_DIR     || '/etc/letsencrypt/live/platform';
const CERTBOT_WEBROOT = process.env.CERTBOT_WEBROOT       || '/var/www/certbot';

function body(row) {
  if (row.state === 'live') {
    if (!row.port) throw new Error(`live domain ${row.domain} has no port`);
    return `    location / {
        proxy_pass         http://127.0.0.1:${row.port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }`;
  }

  if (row.state === 'redirect') {
    const dir = path.join(REDIRECTS_ROOT, row.domain);
    return `    root  ${dir};
    location / { try_files $uri /index.html; }`;
  }

  // parked
  return `    root  ${PARKED_ROOT};
    location / { try_files $uri /index.html; }`;
}

function buildConfig(row) {
  const names = `${row.domain} www.${row.domain}`;
  const blk   = body(row);

  const http80 = `server {
    listen 80; listen [::]:80;
    server_name ${names};
    location /.well-known/acme-challenge/ { root ${CERTBOT_WEBROOT}; }
    location / { return 301 https://$host$request_uri; }
}`;

  const https443 = `server {
    listen 443 ssl http2; listen [::]:443 ssl http2;
    server_name ${names};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Frame-Options           "SAMEORIGIN" always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;

${blk}
}`;

  return `${http80}\n\n${https443}\n`;
}

function write(row) {
  const conf = buildConfig(row);
  fs.writeFileSync(path.join(SITES_AVAILABLE, row.domain), conf, 'utf8');
  fs.writeFileSync(path.join(SITES_ENABLED,   row.domain), conf, 'utf8');
}

function remove(domain) {
  for (const dir of [SITES_AVAILABLE, SITES_ENABLED]) {
    const f = path.join(dir, domain);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function writeRedirectHtml(domain, target) {
  if (!target) return;
  const dir = path.join(REDIRECTS_ROOT, domain);
  fs.mkdirSync(dir, { recursive: true });
  const safe = target.replace(/"/g, '&quot;');
  fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting…</title>
<meta http-equiv="refresh" content="0;url=${safe}">
</head>
<body>
<script>window.location.replace(${JSON.stringify(target)});</script>
<p><a href="${safe}">Click here</a> if not redirected automatically.</p>
</body>
</html>
`, 'utf8');
}

module.exports = { buildConfig, write, remove, writeRedirectHtml };
