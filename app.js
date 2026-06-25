'use strict';

require('dotenv').config();

const express      = require('express');
const cookieSession = require('cookie-session');
const flash        = require('connect-flash');
const { execSync } = require('child_process');
const path         = require('path');
const fs           = require('fs');

const db      = require('./lib/db');
const nginx   = require('./lib/nginx');
const service = require('./lib/service');

const app  = express();
const PORT = process.env.PORT || 4000;
const PASS = process.env.ADMIN_PASSWORD || 'changeme';

// ── Middleware ────────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({ name: 'tfg', secret: process.env.SESSION_SECRET || 'dev-secret', maxAge: 7 * 24 * 60 * 60 * 1000 }));
app.use(flash());

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session.authed) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => res.render('login', { flash: req.flash() }));

app.post('/login', (req, res) => {
  if (req.body.password === PASS) {
    req.session.authed = true;
    return res.redirect('/');
  }
  req.flash('error', 'Wrong password');
  res.redirect('/login');
});

app.post('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function allDomains() {
  return db.prepare('SELECT * FROM domains ORDER BY domain ASC').all();
}

function getDomain(domain) {
  return db.prepare('SELECT * FROM domains WHERE domain = ?').get(domain);
}

// ── Port allocation ─────────────────────────────────────────────────────────
// Live domains proxy to 127.0.0.1:<port>. Rather than tracking ports by hand,
// the admin hands out the lowest free port from a pool. A domain keeps its
// port for life once assigned (even while parked), so it never shifts under a
// running app; an explicit port in the form always overrides.

const PORT_POOL_START = parseInt(process.env.PORT_POOL_START || '3001', 10);
const PORT_POOL_END   = parseInt(process.env.PORT_POOL_END   || '3999', 10);

function nextFreePort() {
  const used = new Set(
    db.prepare('SELECT port FROM domains WHERE port IS NOT NULL').all().map(r => r.port)
  );
  for (let p = PORT_POOL_START; p <= PORT_POOL_END; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(`no free port in pool ${PORT_POOL_START}-${PORT_POOL_END}`);
}

// Decide which port to store: explicit form value wins, then any port already
// allocated to this domain, then auto-assign when it first goes live.
function resolvePort(state, explicit, existing) {
  if (explicit) return parseInt(explicit, 10);
  if (existing) return existing;
  if (state === 'live') return nextFreePort();
  return null;
}

function reloadNginx() {
  execSync('nginx -t && systemctl reload nginx', { timeout: 10_000 });
}

function syncDomain(row) {
  nginx.write(row);
  if (row.state === 'redirect' && row.target) nginx.writeRedirectHtml(row.domain, row.target);
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', requireAuth, (req, res) => {
  const domains = allDomains();
  // Annotate live domains with their systemd service state (cheap: few live).
  for (const d of domains) {
    d.svc = d.state === 'live' ? service.status(d.domain) : null;
  }
  const counts  = {
    total:    domains.length,
    live:     domains.filter(d => d.state === 'live').length,
    redirect: domains.filter(d => d.state === 'redirect').length,
    parked:   domains.filter(d => d.state === 'parked').length,
  };
  res.render('sites', { domains, counts, flash: req.flash() });
});

// Add domain
app.post('/add', requireAuth, (req, res) => {
  const { domain, state = 'parked', target = '', port = '', note = '' } = req.body;
  const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
  if (!DOMAIN_RE.test(domain)) { req.flash('error', 'Invalid domain'); return res.redirect('/'); }
  if (getDomain(domain))       { req.flash('error', `${domain} already exists`); return res.redirect('/'); }
  let assignedPort;
  try { assignedPort = resolvePort(state, port, null); }
  catch (e) { req.flash('error', e.message); return res.redirect('/'); }
  db.prepare(`INSERT INTO domains (domain, state, target, port, note) VALUES (?, ?, ?, ?, ?)`)
    .run(domain.trim().toLowerCase(), state, target || null, assignedPort, note || null);
  req.flash('success', `${domain} added${state === 'live' && assignedPort ? ` on port ${assignedPort}` : ''}`);
  res.redirect('/');
});

// Save domain
app.post('/:domain/save', requireAuth, (req, res) => {
  const row = getDomain(req.params.domain);
  if (!row) { req.flash('error', 'Not found'); return res.redirect('/'); }
  const { state, target, port, note } = req.body;
  const newState = state || row.state;
  let newPort;
  try { newPort = resolvePort(newState, port, row.port); }
  catch (e) { req.flash('error', e.message); return res.redirect('/'); }
  db.prepare(`UPDATE domains SET state=?, target=?, port=?, note=?, updated_at=datetime('now') WHERE id=?`)
    .run(newState, target || null, newPort, note || null, row.id);
  const portNote = newState === 'live' && newPort && !row.port ? ` — assigned port ${newPort}` : '';
  req.flash('success', `${row.domain} saved${portNote} — sync nginx to apply`);
  res.redirect('/');
});

// Sync single domain to nginx
app.post('/:domain/sync', requireAuth, (req, res) => {
  const row = getDomain(req.params.domain);
  if (!row) { req.flash('error', 'Not found'); return res.redirect('/'); }
  const confPath = require('path').join(process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available', row.domain);
  const snap = fs.existsSync(confPath) ? fs.readFileSync(confPath) : null;
  try {
    syncDomain(row);
    reloadNginx();
    req.flash('success', `${row.domain} synced (${row.state})`);
  } catch (e) {
    if (snap) fs.writeFileSync(confPath, snap); else try { fs.unlinkSync(confPath); } catch {}
    req.flash('error', `sync failed: ${e.message}`);
  }
  res.redirect('/');
});

// Install/enable the systemd service for a live domain (wired to its port).
app.post('/:domain/service/install', requireAuth, (req, res) => {
  const row = getDomain(req.params.domain);
  if (!row) { req.flash('error', 'Not found'); return res.redirect('/'); }
  if (row.state !== 'live' || !row.port) {
    req.flash('error', 'Service is only for live domains with a port');
    return res.redirect('/');
  }
  try {
    const dir = service.install(row.domain, row.port);
    req.flash('success', `Service tfg-site@${row.domain} installed (port ${row.port}). Put your app in ${dir} and start it.`);
  } catch (e) {
    req.flash('error', `Service install failed: ${e.message}`);
  }
  res.redirect('/');
});

// Start/restart/stop a domain's service.
app.post('/:domain/service/:action', requireAuth, (req, res) => {
  const { action } = req.params;
  if (!['restart', 'stop'].includes(action)) { req.flash('error', 'Unknown action'); return res.redirect('/'); }
  const row = getDomain(req.params.domain);
  if (!row) { req.flash('error', 'Not found'); return res.redirect('/'); }
  try {
    if (action === 'restart') { service.restart(row.domain); req.flash('success', `${row.domain} service restarted`); }
    else                      { service.stop(row.domain);    req.flash('success', `${row.domain} service stopped`); }
  } catch (e) {
    req.flash('error', `${action} failed: ${e.message}`);
  }
  res.redirect('/');
});

// Sync all domains to nginx
app.post('/sync-all', requireAuth, (req, res) => {
  const rows     = allDomains();
  const snapDir  = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'nginx-snap-'));
  const AVAIL    = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
  let ok = 0;
  const errors = [];

  try {
    for (const row of rows) {
      const f = path.join(AVAIL, row.domain);
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(snapDir, row.domain));
    }
    for (const row of rows) {
      try { syncDomain(row); ok++; }
      catch (e) { errors.push(`${row.domain}: ${e.message}`); }
    }
    try { execSync('nginx -t 2>&1', { timeout: 10_000 }); }
    catch (e) {
      for (const f of fs.readdirSync(snapDir)) fs.copyFileSync(path.join(snapDir, f), path.join(AVAIL, f));
      throw new Error(`nginx -t failed, configs restored: ${e.stdout?.toString() || e.message}`);
    }
    execSync('systemctl reload nginx', { timeout: 10_000 });
    if (errors.length) req.flash('error', `${ok} synced, errors: ${errors.slice(0, 3).join('; ')}`);
    else               req.flash('success', `${ok} domains synced to nginx`);
  } catch (e) {
    req.flash('error', e.message);
  } finally {
    try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {}
  }
  res.redirect('/');
});

// Remove domain
app.post('/:domain/remove', requireAuth, (req, res) => {
  const row = getDomain(req.params.domain);
  if (!row) { req.flash('error', 'Not found'); return res.redirect('/'); }
  try { nginx.remove(row.domain); reloadNginx(); } catch {}
  db.prepare('DELETE FROM domains WHERE id = ?').run(row.id);
  req.flash('success', `${row.domain} removed`);
  res.redirect('/');
});

// Renew platform cert — only served (live/redirect) domains go on the SAN cert.
// Parked domains are excluded: they don't need a cert, and including every
// registered domain blows past Let's Encrypt's 100-names-per-cert limit
// (each domain also carries a www. SAN, so the ceiling is ~50 domains).
app.post('/platform-cert', requireAuth, (req, res) => {
  const domains = allDomains()
    .filter(r => r.state === 'live' || r.state === 'redirect')
    .map(r => r.domain);
  if (!domains.length) {
    req.flash('error', 'No live/redirect domains to certify (parked domains are skipped)');
    return res.redirect('/');
  }
  if (domains.length * 2 > 100) {
    req.flash('error', `${domains.length} served domains exceed the 100-name cert limit (each adds a www. SAN). Reduce served domains or split certs.`);
    return res.redirect('/');
  }
  try {
    execSync(
      `sudo /usr/local/bin/platform-cert ${domains.join(' ')}`,
      { timeout: 120_000 }
    );
    reloadNginx();
    req.flash('success', `Platform cert renewed for ${domains.length} served domain(s)`);
  } catch (e) {
    req.flash('error', `Cert renewal failed: ${e.message}`);
  }
  res.redirect('/');
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => console.log(`[tfg-admin] http://127.0.0.1:${PORT}`));
