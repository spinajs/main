#!/usr/bin/env node
/**
 * Creates an annotated vX.Y.Z tag on every `release vX.Y.Z [skip ci]` commit that has none.
 *
 *   node scripts/backfill-tags.mjs [--dry-run] [--push] [--min-major N]
 *
 * --dry-run prints the tags without creating them. --push pushes only the tags it created.
 * --min-major ( default 3 ) leaves older lines alone.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RELEASE_RE = /^(\S+) release v(\d+\.\d+\.\d+) \[skip ci\]$/;

export function parseReleaseCommits(log) {
  const found = [];
  for (const line of log.split(/\r?\n/)) {
    const m = RELEASE_RE.exec(line);
    if (m) found.push({ sha: m[1], version: m[2] });
  }
  return found;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

export function backfillTags({ cwd = process.cwd(), dryRun = false, push = false, minMajor = 3 } = {}) {
  const existing = new Set(git(cwd, 'tag', '-l').split(/\r?\n/).filter(Boolean));
  const missing = parseReleaseCommits(git(cwd, 'log', '--format=%H %s'))
    .filter(({ version }) => Number(version.split('.')[0]) >= minMajor)
    .map(({ sha, version }) => ({ sha, tag: `v${version}` }))
    .filter(({ tag }) => !existing.has(tag))
    .reverse();

  if (dryRun) return missing;
  for (const { sha, tag } of missing) git(cwd, 'tag', '-a', tag, '-m', `release ${tag}`, sha);
  if (push && missing.length) git(cwd, 'push', 'origin', ...missing.map(({ tag }) => `refs/tags/${tag}`));
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--min-major');
  const dryRun = args.includes('--dry-run');
  const created = backfillTags({ dryRun, push: args.includes('--push'), minMajor: i >= 0 ? Number(args[i + 1]) : 3 });
  for (const { sha, tag } of created) console.log(`${dryRun ? 'would tag' : 'tagged'} ${tag} ${sha}`);
  console.log(`${created.length} tag(s) ${dryRun ? 'would be created' : 'created'}`);
}
