'use strict';

// systemd unit generation for live site apps.
//
// Convention: a live domain's app lives at  /var/www/sites/<domain>/ , is
// started with `npm start`, and listens on the PORT it's given. Each domain
// runs as an instance of a single template unit, tfg-site@<domain>.service,
// with its port supplied via an EnvironmentFile so the unit itself never
// changes per domain.

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SITES_ROOT   = process.env.SITES_ROOT   || '/var/www/sites';
const ENV_DIR      = process.env.TFG_ENV_DIR  || '/etc/tfg-sites';
const UNIT_PATH    = '/etc/systemd/system/tfg-site@.service';
const SERVICE_USER = process.env.SITE_USER    || 'www-data';

// Domains come from the DB (validated on insert), but anything that lands in a
// shell argument or filesystem path gets re-checked here.
const SAFE = /^[a-z0-9][a-z0-9.-]{1,253}$/;
function assertSafe(domain) {
  if (!SAFE.test(domain) || domain.includes('..')) {
    throw new Error(`unsafe domain: ${domain}`);
  }
}

const TEMPLATE = `[Unit]
Description=tfg site %i
After=network.target

[Service]
Type=simple
WorkingDirectory=${SITES_ROOT}/%i
EnvironmentFile=${ENV_DIR}/%i.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3
# Don't thrash if the app dir is empty / crashing on boot.
StartLimitIntervalSec=60
StartLimitBurst=4
User=${SERVICE_USER}
Group=${SERVICE_USER}

[Install]
WantedBy=multi-user.target
`;

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function ensureTemplate() {
  const current = fs.existsSync(UNIT_PATH) ? fs.readFileSync(UNIT_PATH, 'utf8') : null;
  if (current !== TEMPLATE) {
    fs.writeFileSync(UNIT_PATH, TEMPLATE, 'utf8');
    sh('systemctl', ['daemon-reload']);
  }
}

// Create the app dir + env file and enable (but do not start) the instance.
// Starting is left to the operator once real code is in place.
function install(domain, port) {
  assertSafe(domain);
  if (!port) throw new Error(`${domain} has no port to bind`);

  ensureTemplate();
  fs.mkdirSync(ENV_DIR, { recursive: true });
  const siteDir = path.join(SITES_ROOT, domain);
  fs.mkdirSync(siteDir, { recursive: true });
  // Hand the app dir to the unprivileged service user.
  try { sh('chown', ['-R', `${SERVICE_USER}:${SERVICE_USER}`, siteDir]); } catch { /* best effort */ }

  fs.writeFileSync(
    path.join(ENV_DIR, `${domain}.env`),
    `PORT=${parseInt(port, 10)}\nNODE_ENV=production\n`,
    'utf8'
  );
  sh('systemctl', ['enable', `tfg-site@${domain}`]);
  return siteDir;
}

function restart(domain) { assertSafe(domain); sh('systemctl', ['restart', `tfg-site@${domain}`]); }

function stop(domain) {
  assertSafe(domain);
  sh('systemctl', ['disable', '--now', `tfg-site@${domain}`]);
}

// active | inactive | failed | activating | not-installed | unknown
function status(domain) {
  if (!SAFE.test(domain)) return 'unknown';
  if (!fs.existsSync(path.join(ENV_DIR, `${domain}.env`))) return 'not-installed';
  const r = spawnSync('systemctl', ['is-active', `tfg-site@${domain}`], { encoding: 'utf8', timeout: 5_000 });
  return (r.stdout || r.stderr || 'unknown').trim();
}

module.exports = { install, restart, stop, status, SITES_ROOT };
