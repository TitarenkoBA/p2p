import { spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  statSync,
  copyFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TOOLS_DIR = join(__dirname, '..', '.tools', 'loophole');
const LOOPHOLE_VERSION = '1.0.0-beta.15';
const LOOPHOLE_BASE = `https://github.com/loophole/cli/releases/download/${LOOPHOLE_VERSION}`;

const isWin = process.platform === 'win32';
const loopholeBinName = isWin ? 'loophole.exe' : 'loophole';

function loopholeAsset() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    return arch === 'ia32'
      ? `loophole-cli_${LOOPHOLE_VERSION}_windows_32bit.zip`
      : `loophole-cli_${LOOPHOLE_VERSION}_windows_64bit.zip`;
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return `loophole-cli_${LOOPHOLE_VERSION}_linux_arm64.tar.gz`;
    if (arch.startsWith('arm')) return `loophole-cli_${LOOPHOLE_VERSION}_linux_armv7.tar.gz`;
    return `loophole-cli_${LOOPHOLE_VERSION}_linux_64bit.tar.gz`;
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? `loophole-cli_${LOOPHOLE_VERSION}_macos_arm64.tar.gz`
      : `loophole-cli_${LOOPHOLE_VERSION}_macos_64bit.tar.gz`;
  }
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

async function download(url, dest) {
  await new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          download(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode} ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

async function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith('.zip')) {
    if (isWin) {
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
        ],
        { stdio: 'inherit' }
      );
      if (r.status !== 0) throw new Error('Expand-Archive failed');
    } else {
      const r = spawnSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('unzip failed');
    }
  } else if (archivePath.endsWith('.tar.gz')) {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tar extract failed');
  } else {
    throw new Error(`Unknown archive: ${archivePath}`);
  }
}

function locateLoopholeBinary(searchDir) {
  const direct = join(searchDir, loopholeBinName);
  if (existsSync(direct)) return direct;
  for (const name of readdirSync(searchDir)) {
    const full = join(searchDir, name);
    if (statSync(full).isDirectory()) {
      const nested = join(full, loopholeBinName);
      if (existsSync(nested)) return nested;
    }
  }
  return null;
}

export async function ensureLoopholeBinary(log = console.log) {
  const installed = join(TOOLS_DIR, loopholeBinName);
  if (existsSync(installed)) {
    return installed;
  }

  const global = spawnSync(isWin ? 'where' : 'which', ['loophole'], { encoding: 'utf8', shell: isWin });
  if (global.status === 0 && global.stdout.trim()) {
    return global.stdout.trim().split(/\r?\n/)[0];
  }

  log('[signaling] Downloading Loophole CLI...');
  mkdirSync(TOOLS_DIR, { recursive: true });
  const asset = loopholeAsset();
  const url = `${LOOPHOLE_BASE}/${asset}`;
  const archivePath = join(TOOLS_DIR, asset);
  await download(url, archivePath);
  await extractArchive(archivePath, TOOLS_DIR);

  const found = locateLoopholeBinary(TOOLS_DIR);
  if (!found) {
    throw new Error('Loophole binary not found. Install from https://loophole.cloud/download');
  }

  if (found !== installed) {
    copyFileSync(found, installed);
  }
  if (!isWin) {
    chmodSync(installed, 0o755);
  }
  return installed;
}
