// Differences between running from source (npm start) and the packaged .exe.
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { exec } from 'node:child_process';

declare const __PACKAGED__: boolean | undefined;
declare const __VERSION__: string | undefined;

export const PACKAGED = typeof __PACKAGED__ !== 'undefined' && __PACKAGED__;
export const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';
const SRC_ROOT = PACKAGED ? '' : resolve(import.meta.dirname, '..');

export const USERSCRIPT = 'mahjong-soul-bridge.user.js';

/** Where settings/tokens live: %APPDATA%\<folder> for the .exe, the repo folder when run from source. */
export function dataDir(folder: string) {
  const dir = PACKAGED ? resolve(process.env.APPDATA || dirname(process.execPath), folder) : SRC_ROOT;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reads a bundled file (public/* or the userscript). */
export function readAsset(name: string): string {
  if (PACKAGED) return (require('node:sea') as typeof import('node:sea')).getAsset(name, 'utf8');
  return readFileSync(resolve(SRC_ROOT, name === USERSCRIPT ? 'userscript' : 'public', name), 'utf8');
}

export function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore failures */ });
}

/** In the .exe, keep the console window open so error messages can be read. */
export async function pauseIfPackaged(message = 'Press Enter to close this window.') {
  if (!PACKAGED || !process.stdin.isTTY) return;
  console.log(`\n${message}`);
  await new Promise((r) => { process.stdin.resume(); process.stdin.once('data', r); });
}
