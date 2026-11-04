import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = /^packages\/([^/]+)\/src\//;
const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;

/** A "private": true package is never published ( .changeset/config.json ignores it ), so its src needs no changeset. */
export function isPrivatePackage(name) {
  try {
    return JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8')).private === true;
  } catch {
    return false;
  }
}

// Entries are paths or { path, status } with a git name-status letter; a deleted changeset does not count.
export function requiresChangeset(files, privatePackage = isPrivatePackage) {
  const entries = files.map((f) => (typeof f === 'string' ? { path: f, status: 'M' } : f));
  const norm = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/') }));
  const publishedSrc = norm.some((e) => {
    const match = SRC.exec(e.path);
    return match !== null && !privatePackage(match[1]);
  });
  return publishedSrc && !norm.some((e) => e.status !== 'D' && CHANGESET.test(e.path));
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
