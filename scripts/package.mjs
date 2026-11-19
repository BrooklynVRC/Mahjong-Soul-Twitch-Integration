// Builds a standalone Windows .exe (no Node install needed) using Node's Single Executable Applications.
//   npm run package   ->   release/<exeName>.exe  +  release/mahjong-soul-bridge.user.js
import { build } from 'esbuild';
import { inject } from 'postject';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const exeName = pkg.exeName;
const out = resolve(root, 'build');
const rel = resolve(root, 'release');
rmSync(out, { recursive: true, force: true });
rmSync(rel, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(rel, { recursive: true });

console.log('1/4 bundling…');
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: resolve(out, 'app.cjs'),
  define: { __PACKAGED__: 'true', __VERSION__: JSON.stringify(pkg.version), 'import.meta.dirname': '""' },
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});

console.log('2/4 creating SEA blob…');
const assets = { 'mahjong-soul-bridge.user.js': resolve(root, 'userscript/mahjong-soul-bridge.user.js') };
for (const f of readdirSync(resolve(root, 'public'))) assets[f] = resolve(root, 'public', f);
const seaConfig = resolve(out, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: resolve(out, 'app.cjs'),
  output: resolve(out, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

console.log('3/4 injecting into node.exe…');
const exe = resolve(rel, `${exeName}.exe`);
copyFileSync(process.execPath, exe);
await inject(exe, 'NODE_SEA_BLOB', readFileSync(resolve(out, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

console.log('4/4 copying userscript…');
copyFileSync(assets['mahjong-soul-bridge.user.js'], resolve(rel, 'mahjong-soul-bridge.user.js'));
console.log(`done: ${exe}`);
