/**
 * Parse every JavaScript file in the project with `node --check`.
 * Catches syntax errors in browser-only modules that the unit tests never import.
 *
 *   npm run check
 */
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['server.js', 'src', 'public', 'tests', 'scripts'];

function collect(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) collect(join(path, name), out);
  } else if (path.endsWith('.js')) {
    out.push(path);
  }
  return out;
}

const files = TARGETS.flatMap((t) => collect(join(ROOT, t), []));
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✖ ${f}\n${r.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files parsed cleanly`);
process.exit(failed ? 1 : 0);
