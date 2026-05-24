#!/usr/bin/env node
/**
 * One command: peer-server deps + PeerJS + Loophole tunnel (fixed subdomain).
 * Windows / Linux / macOS. Node.js 18+.
 *
 * 1) Edit peer-server/loophole.config.json (unique hostname)
 * 2) npm run peer-server:login   (once)
 * 3) npm run peer-server
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { ensureLoopholeBinary } from './loophole-binary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PEER_SERVER_DIR = join(ROOT, 'peer-server');
const isWin = process.platform === 'win32';

function log(msg) {
  console.log(`[signaling] ${msg}`);
}

function loadConfig() {
  const configPath = join(PEER_SERVER_DIR, 'loophole.config.json');
  const examplePath = join(PEER_SERVER_DIR, 'loophole.config.example.json');
  if (!existsSync(configPath)) {
    if (!existsSync(examplePath)) {
      console.error(`Missing ${configPath}`);
      process.exit(1);
    }
    copyFileSync(examplePath, configPath);
    log('Created loophole.config.json — set a unique "hostname", then run again.');
    process.exit(0);
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!cfg.hostname || /[.\s]/.test(cfg.hostname)) {
    console.error('loophole.config.json: "hostname" required (no dots/spaces).');
    process.exit(1);
  }
  cfg.port = Number(cfg.port ?? 9000);
  cfg.domain = cfg.domain ?? 'loophole.site';
  return cfg;
}

function npmInstallPeerServer() {
  const peerModule = join(PEER_SERVER_DIR, 'node_modules', 'peer');
  if (existsSync(peerModule)) return;
  log('Installing peer-server dependencies...');
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], {
    cwd: PEER_SERVER_DIR,
    stdio: 'inherit',
    shell: isWin
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function waitForPeer(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const req = http.get(`http://127.0.0.1:${port}/peerjs/id?ts=1&version=1.5.5`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else if (Date.now() < deadline) setTimeout(tryOnce, 500);
        else reject(new Error(`PeerServer HTTP ${res.statusCode}`));
      });
      req.on('error', () => {
        if (Date.now() < deadline) setTimeout(tryOnce, 500);
        else reject(new Error('PeerServer did not start (port busy?)'));
      });
    };
    tryOnce();
  });
}

function publicUrl(cfg) {
  return `https://${cfg.hostname}.${cfg.domain}`;
}

async function main() {
  const cfg = loadConfig();
  const publicHost = `${cfg.hostname}.${cfg.domain}`;

  npmInstallPeerServer();

  log(`Starting PeerServer on 127.0.0.1:${cfg.port}...`);
  const peerProc = spawn(process.execPath, ['server.js'], {
    cwd: PEER_SERVER_DIR,
    env: { ...process.env, PORT: String(cfg.port), PROXIED: 'true' },
    stdio: 'inherit'
  });

  let loopholeProc;
  const shutdown = (code = 0) => {
    if (loopholeProc && !loopholeProc.killed) loopholeProc.kill();
    if (peerProc && !peerProc.killed) peerProc.kill();
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  peerProc.on('exit', (code) => {
    if (code) {
      log(`PeerServer exited: ${code}`);
      shutdown(code);
    }
  });

  try {
    await waitForPeer(cfg.port);
  } catch (e) {
    console.error(e.message);
    shutdown(1);
  }

  const loopholePath = await ensureLoopholeBinary(log);
  log(`Loophole tunnel -> ${publicUrl(cfg)}`);

  loopholeProc = spawn(loopholePath, ['http', String(cfg.port), '--hostname', cfg.hostname], {
    cwd: PEER_SERVER_DIR,
    stdio: 'inherit'
  });
  loopholeProc.on('exit', (code) => shutdown(code ?? 0));

  writeFileSync(join(PEER_SERVER_DIR, '.tunnel-public-host.txt'), publicHost, 'utf8');

  console.log('\n========================================');
  console.log(`  Public signaling: ${publicUrl(cfg)}`);
  console.log(`  Angular: host '${publicHost}', port 443, secure true`);
  console.log('========================================\n');
}

const isMain = resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
