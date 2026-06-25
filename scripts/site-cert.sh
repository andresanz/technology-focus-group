#!/usr/bin/env bash
# site-cert <domain> — issue or renew an individual Let's Encrypt cert for ONE
# domain (cert-name == domain). Tries to include www.<domain>; if that name
# can't validate (no www DNS), retries with the apex only.
#
# Install (root):
#   cp scripts/site-cert.sh /usr/local/bin/site-cert
#   chmod 755 /usr/local/bin/site-cert
#   echo 'root ALL=(ALL) NOPASSWD: /usr/local/bin/site-cert *' > /etc/sudoers.d/site-cert
#
# The admin calls: sudo /usr/local/bin/site-cert <domain>

set -euo pipefail

EMAIL="${CERTBOT_EMAIL:-sanz.andre@gmail.com}"
WEBROOT="${CERTBOT_WEBROOT:-/var/www/certbot}"

[[ $# -eq 1 ]] || { echo "usage: site-cert <domain>" >&2; exit 2; }
DOMAIN="$1"
[[ $DOMAIN =~ ^[a-z0-9][a-z0-9.-]{2,253}$ ]] || { echo "bad domain: $DOMAIN" >&2; exit 2; }
[[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "bad email" >&2; exit 2; }

issue() {
  certbot certonly --webroot -w "$WEBROOT" --cert-name "$DOMAIN" \
    "$@" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
}

# Apex + www first; fall back to apex-only when www has no DNS / can't validate.
tmp="$(mktemp)"
if issue -d "$DOMAIN" -d "www.$DOMAIN" 2>"$tmp"; then
  rm -f "$tmp"
else
  cat "$tmp" >&2; rm -f "$tmp"
  echo "==> www.$DOMAIN failed to validate; retrying apex only" >&2
  issue -d "$DOMAIN"
fi
