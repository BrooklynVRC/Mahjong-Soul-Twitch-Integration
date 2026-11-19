// Differences between running from source (npm start) and the packaged .exe.
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';

declare const __PACKAGED__: boolean | undefined;
declare const __VERSION__: string | undefined;

export const PACKAGED = typeof __PACKAGED__ !== 'undefined' && __PACKAGED__;
export const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';
const SRC_ROOT = PACKAGED ? '' : resolve(import.meta.dirname, '..');

export function dataDir(folder: string) {
  const dir = PACKAGED ? resolve(process.env.APPDATA || dirname(process.execPath), folder) : SRC_ROOT;
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sea = () => require('node:sea') as typeof import('node:sea');

/** Reads a bundled text file from public/. */
export function readAsset(name: string): string {
  if (PACKAGED) return sea().getAsset(name, 'utf8');
  return readFileSync(resolve(SRC_ROOT, 'public', name), 'utf8');
}

/** Path of the capture helper exe (extracted next to the settings when packaged). */
export function helperPath(dir: string): string {
  if (PACKAGED) {
    const data = Buffer.from(sea().getAsset('wgc-capture.exe'));
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
    const p = resolve(dir, `wgc-capture-${hash}.exe`);
    if (!existsSync(p)) writeFileSync(p, data);
    return p;
  }
  const base = resolve(SRC_ROOT, 'capture-helper', 'bin', 'Release');
  const found = findFile(base, 'wgc-capture.exe');
  if (!found) throw new Error('capture helper not built: run  npm run build:helper');
  return found;
}

function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}

export function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore */ });
}

export async function pauseIfPackaged(message = 'Press Enter to close this window.') {
  if (!PACKAGED || !process.stdin.isTTY) return;
  console.log(`\n${message}`);
  await new Promise((r) => { process.stdin.resume(); process.stdin.once('data', r); });
}
