#!/usr/bin/env node
'use strict';

// Sync + provision domains from Linode DNS.
//
// 1. Discover: pull every domain in the Linode account (read-only) and insert
//    new ones as `parked`. Existing rows are never touched.
// 2. Provision (unless SYNC_PROVISION=0): make sure every managed domain has an
//    nginx vhost on disk. Domains without one get a parked HTTP-only vhost.
// 3. Certify: for any domain whose DNS already points at this server (SERVER_IP)
//    and that has no cert yet, issue its own cert and flip the vhost to HTTPS.
//
// Idempotent and safe to run on a timer: it only writes/reloads when something
// actually changes, validates with `nginx -t`, and rolls back on failure.
//
// Env: LINODE_TOKEN (domains:read_only), SERVER_IP (this host's public IP).
// Runs as root (systemd timer), so it writes /etc/nginx and calls site-cert
// directly.

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const dns  = require('dns').promises;
const { execFileSync } = require('child_process');

const db    = require('../lib/db');
const nginx = require('../lib/nginx');

const TOKEN     = process.env.LINODE_TOKEN;
const SERVER_IP = process.env.SERVER_IP || '';
const PROVISION = process.env.SYNC_PROVISION !== '0';
const AVAIL     = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
const LE_LIVE   = process.env.LE_LIVE_DIR || '/etc/letsencrypt/live';
const SITE_CERT = '/usr/local/bin/site-cert';

if (!TOKEN) { console.error('[sync] LINODE_TOKEN not set'); process.exit(1); }

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/;

async function fetchAllDomains() {
  const out = [];
  let page = 1, pages = 1;
  do {
    const res = await fetch(`https://api.linode.com/v4/domains?page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`Linode API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const d of body.data || []) if (d.domain) out.push(d.domain.toLowerCase());
    pages = body.pages || 1;
    page += 1;
  } while (page <= pages);
  return out;
}

function hasCert(domain) { return fs.existsSync(path.join(LE_LIVE, domain, 'fullchain.pem')); }
function hasVhost(domain) { return fs.existsSync(path.join(AVAIL, domain)); }
function nginxTest() { execFileSync('nginx', ['-t'], { stdio: 'pipe' }); }
function nginxReload() { execFileSync('systemctl', ['reload', 'nginx'], { stdio: 'pipe' }); }

async function resolvesHere(domain) {
  if (!SERVER_IP) return false;
  try { return (await dns.resolve4(domain)).includes(SERVER_IP); }
  catch { return false; }
}

(async () => {
  // ── 1. Discover ───────────────────────────────────────────────────────────
  const domains = await fetchAllDomains();
  const insert = db.prepare(`INSERT OR IGNORE INTO domains (domain, state) VALUES (?, 'parked')`);
  let added = 0;
  db.transaction(list => {
    for (const d of list) if (DOMAIN_RE.test(d) && insert.run(d).changes) added++;
  })(domains);

  const rows = db.prepare('SELECT * FROM domains ORDER BY domain').all();

  if (!PROVISION) {
    console.log(`[sync] linode=${domains.length} added=${added} registry=${rows.length} (provision off)`);
    return;
  }

  // ── 2. Provision: ensure every domain has a vhost (parked HTTP-only if new) ──
  const created = [];
  for (const row of rows) {
    if (!hasVhost(row.domain)) { nginx.write(row); created.push(row.domain); }
  }
  if (created.length) {
    try { nginxTest(); nginxReload(); }
    catch (e) {
      for (const d of created) nginx.remove(d);          // roll back new vhosts
      console.error(`[sync] nginx rejected ${created.length} new vhosts, rolled back: ${String(e.stderr || e).slice(0, 300)}`);
      console.log(`[sync] linode=${domains.length} added=${added} vhosts=0 certs=0 (provision aborted)`);
      return;
    }
  }

  // ── 3. Certify: domains that point here and have no cert get one + HTTPS ─────
  const certified = [];
  const certErrors = [];
  for (const row of rows) {
    if (hasCert(row.domain) || !(await resolvesHere(row.domain))) continue;
    const snap = fs.readFileSync(path.join(AVAIL, row.domain));
    try {
      execFileSync(SITE_CERT, [row.domain], { stdio: 'pipe', timeout: 120_000 });
      nginx.write(row);                                  // rebuild → now HTTPS
      certified.push(row.domain);
    } catch (e) {
      fs.writeFileSync(path.join(AVAIL, row.domain), snap);
      certErrors.push(`${row.domain}: ${String(e.stderr || e.message).split('\n')[0]}`);
    }
  }
  if (certified.length) {
    try { nginxTest(); nginxReload(); }
    catch (e) { console.error(`[sync] HTTPS reload failed: ${String(e.stderr || e).slice(0, 200)}`); }
  }

  console.log(
    `[sync] linode=${domains.length} added=${added} registry=${rows.length} ` +
    `vhosts_created=${created.length} certs_issued=${certified.length}` +
    (certErrors.length ? ` cert_errors=${certErrors.length} (${certErrors.slice(0, 2).join('; ')})` : '')
  );
})().catch((e) => { console.error(`[sync] ${e.message}`); process.exit(1); });
