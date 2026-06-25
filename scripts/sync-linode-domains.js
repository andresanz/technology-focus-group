#!/usr/bin/env node
'use strict';

// Sync the domain registry from Linode DNS.
//
// Pulls every domain in the Linode account (read-only) and inserts any that
// aren't already in the registry as `parked`. Existing rows — and their
// state/target/port — are left untouched. Does NOT write nginx configs or
// touch certs; run "Sync All" in the admin for that.
//
// Requires LINODE_TOKEN in the environment (or .env). Scope needed:
// domains:read_only.

require('dotenv').config();

const db = require('../lib/db');

const TOKEN = process.env.LINODE_TOKEN;
if (!TOKEN) {
  console.error('[sync-domains] LINODE_TOKEN not set');
  process.exit(1);
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/;

async function fetchAllDomains() {
  const out = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await fetch(`https://api.linode.com/v4/domains?page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`Linode API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json();
    for (const d of body.data || []) if (d.domain) out.push(d.domain.toLowerCase());
    pages = body.pages || 1;
    page += 1;
  } while (page <= pages);
  return out;
}

(async () => {
  const domains = await fetchAllDomains();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO domains (domain, state) VALUES (?, 'parked')`
  );
  let added = 0;
  let skipped = 0;
  const insertMany = db.transaction((list) => {
    for (const domain of list) {
      if (!DOMAIN_RE.test(domain)) { skipped++; continue; }
      const r = insert.run(domain);
      if (r.changes) added++;
    }
  });
  insertMany(domains);

  const total = db.prepare('SELECT COUNT(*) n FROM domains').get().n;
  console.log(
    `[sync-domains] linode=${domains.length} added=${added} ` +
    `skipped_invalid=${skipped} registry_total=${total}`
  );
})().catch((e) => {
  console.error(`[sync-domains] ${e.message}`);
  process.exit(1);
});
