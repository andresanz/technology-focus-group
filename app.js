'use strict';

require('dotenv').config();

const express      = require('express');
const cookieSession = require('cookie-session');
const flash        = require('connect-flash');
const { execSync } = require('child_process');
const path         = require('path');
const fs           = require('fs');

const db    = require('./lib/db');
const nginx = require('./lib/nginx');

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
  db.prepare(`INSERT INTO domains (domain, state, target, port, note) VALUES (?, ?, ?, ?, ?)`)
    .run(domain.trim().toLowerCase(), state, target || null, port ? parseInt(port, 10) : null, note || null);
  req.flash('success', `${domain} added`);
  res.redirect('/');
});

// Save domain
app.post('/:domain/save', requireAuth, (req, res) => {
  const row = getDomain(req.params.domain);
  if (!row) { req.flash('error', 'Not found'); return res.redirect('/'); }
  const { state, target, port, note } = req.body;
  db.prepare(`UPDATE domains SET state=?, target=?, port=?, note=?, updated_at=datetime('now') WHERE id=?`)
    .run(state || row.state, target || null, port ? parseInt(port, 10) : null, note || null, row.id);
  req.flash('success', `${row.domain} saved — sync nginx to apply`);
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
