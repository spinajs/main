#!/usr/bin/env node
// Replaces scripts/bench/cold-start-baseline.json with the numbers of a cold-start workflow run on a GitHub runner.
// Usage:
//   node scripts/bench/update-cold-start-baseline.mjs --latest        the newest successful workflow_dispatch run on master
//   node scripts/bench/update-cold-start-baseline.mjs --run <run id>  that run's `cold-start` artifact ( needs the gh CLI )
//   node scripts/bench/update-cold-start-baseline.mjs <candidate.json>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_FILE, hasCiNumbers, readBaseline } from './cold-start-gate.mjs';

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'cold-start-baseline.json');

/** Writes `candidate` over `target`, refusing numbers that were not measured on CI. */
export function updateBaseline({ candidate, target = BASELINE }) {
  const next = readBaseline(candidate);
  if (!hasCiNumbers(next)) throw new Error(`${candidate} was not measured on CI (measuredOn.ci is ${JSON.stringify(next.measuredOn?.ci)}): the baseline holds GitHub runner numbers only`);
  writeFileSync(target, JSON.stringify(JSON.parse(readFileSync(candidate, 'utf8')), null, 2) + '\n');
  return next;
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`gh is needed for this: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function latestRun() {
  const runs = JSON.parse(gh(['run', 'list', '--workflow', 'cold-start.yml', '--event', 'workflow_dispatch', '--branch', 'master', '--status', 'success', '--limit', '1', '--json', 'databaseId']));
  if (runs.length === 0) throw new Error('no successful workflow_dispatch run of cold-start.yml on master: start one under Actions > cold-start > Run workflow');
  return String(runs[0].databaseId);
}

function fromRun(runId, apply) {
  const dir = mkdtempSync(join(tmpdir(), 'cold-start-baseline-'));
  try {
    gh(['run', 'download', runId, '--name', 'cold-start', '--dir', dir]);
    return apply(join(dir, CANDIDATE_FILE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const apply = (candidate) => {
    const next = updateBaseline({ candidate });
    console.log(`${BASELINE} updated from ${next.measuredOn.runUrl ?? candidate}:`);
    for (const [name, { warmMs, coldMs }] of Object.entries(next.targets)) console.log(`  ${name}: warm ${warmMs} ms, cold ${coldMs} ms`);
    console.log('Commit it in a pull request; the regression check compares against it from then on.');
  };
  if (argv[0] === '--latest') return fromRun(latestRun(), apply);
  if (argv[0] === '--run' && argv[1]) return fromRun(argv[1], apply);
  if (argv.length === 1 && !argv[0].startsWith('--')) return apply(resolve(argv[0]));
  throw new Error('usage: update-cold-start-baseline.mjs --latest | --run <run id> | <candidate.json>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
