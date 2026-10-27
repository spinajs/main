import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = /^packages\/[^/]+\/src\//;
const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;

// Entries are paths or { path, status } with a git name-status letter; a deleted changeset does not count.
export function requiresChangeset(files) {
  const entries = files.map((f) => (typeof f === 'string' ? { path: f, status: 'M' } : f));
  const norm = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/') }));
  return norm.some((e) => SRC.test(e.path)) && !norm.some((e) => e.status !== 'D' && CHANGESET.test(e.path));
}

function changedFiles(base) {
  const out = execFileSync('git', ['diff', '--name-status', `${base}...HEAD`], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status: status[0], path: paths[paths.length - 1] };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : 'origin/master';
  if (requiresChangeset(changedFiles(base))) {
    console.error('This PR changes packages/*/src but adds no changeset. Run `npx changeset` and commit the generated .changeset/*.md file.');
    process.exit(1);
  }
  console.log('changeset guard: ok');
}
