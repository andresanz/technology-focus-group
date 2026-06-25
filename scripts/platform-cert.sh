#!/usr/bin/env bash
# platform-cert <domain1> <domain2> ...
#
# Issues / renews a single SAN cert covering every registered domain.
# All domains share the cert at /etc/letsencrypt/live/platform/.
#
# Install (root):
#   cp scripts/platform-cert.sh /usr/local/bin/platform-cert
#   chmod 755 /usr/local/bin/platform-cert
#   echo 'www-data ALL=(ALL) NOPASSWD: /usr/local/bin/platform-cert *' >> /etc/sudoers.d/platform-cert
#
# The admin calls: sudo /usr/local/bin/platform-cert domain1 domain2 ...

set -euo pipefail

EMAIL=${CERTBOT_EMAIL:-sanz.andre@gmail.com}
[[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "bad email" >&2; exit 2; }

[[ $# -gt 0 ]] || { echo "usage: platform-cert <domain> [domain ...]" >&2; exit 2; }

ARGS=()
for DOMAIN in "$@"; do
  [[ $DOMAIN =~ ^[a-z0-9][a-z0-9.-]{2,80}$ ]] || { echo "bad domain: $DOMAIN" >&2; exit 2; }
  ARGS+=(-d "$DOMAIN" -d "www.$DOMAIN")
done

exec certbot certonly --webroot -w /var/www/certbot \
  --cert-name platform \
  "${ARGS[@]}" \
  --non-interactive --agree-tos -m "$EMAIL"
