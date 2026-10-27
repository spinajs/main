import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = /^packages\/[^/]+\/src\//;
const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;

export function requiresChangeset(files) {
  const normalized = files.map((f) => f.replace(/\\/g, '/'));
  return normalized.some((f) => SRC.test(f)) && !normalized.some((f) => CHANGESET.test(f));
}

function changedFiles(base) {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRD', `${base}...HEAD`], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
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
