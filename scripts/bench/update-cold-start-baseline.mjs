#!/usr/bin/env node
// Replaces scripts/bench/cold-start-baseline.json with the numbers of a cold-start workflow run on a GitHub runner.
// Run it on the branch that will hold the baseline (v4 for 4.x). Usage ( --latest and --run need the gh CLI ):
//   node scripts/bench/update-cold-start-baseline.mjs --latest [--branch <name>]  the newest successful push or
//                                    workflow_dispatch run on that branch, by default the current one
//   node scripts/bench/update-cold-start-baseline.mjs --run <run id>              that run's `cold-start` artifact
//   node scripts/bench/update-cold-start-baseline.mjs <candidate.json>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_FILE, hasCiNumbers, readBaseline } from './cold-start-gate.mjs';

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'cold-start-baseline.json');
const WORKFLOW = '.github/workflows/cold-start.yml';
const DEFAULT_BRANCH = 'v4';
// Runs of these events check out a branch of this repository; a pull_request run runs the gate code of its head, which
// a fork controls, so the `ci` marker of its candidate proves nothing.
const TRUSTED_EVENTS = ['workflow_dispatch', 'push'];
const USAGE = 'usage: update-cold-start-baseline.mjs --latest [--branch <name>] | --run <run id> | <candidate.json>';

/** Writes `candidate` over `target`, refusing numbers that were not measured on CI. */
export function updateBaseline({ candidate, target = BASELINE }) {
  const next = readBaseline(candidate);
  if (!hasCiNumbers(next)) throw new Error(`${candidate} was not measured on CI (measuredOn.ci is ${JSON.stringify(next.measuredOn?.ci)}): the baseline holds GitHub runner numbers only`);
  writeFileSync(target, JSON.stringify(JSON.parse(readFileSync(candidate, 'utf8')), null, 2) + '\n');
  return next;
}

/** `currentBranch` is undefined on a detached HEAD or outside a git checkout. */
export function parseArgs(argv, { currentBranch }) {
  const [first, ...rest] = argv;
  if (first === '--latest') {
    if (rest.length === 0) return { latest: true, branch: currentBranch ?? DEFAULT_BRANCH };
    if (rest.length === 2 && rest[0] === '--branch' && rest[1] && !rest[1].startsWith('-')) return { latest: true, branch: rest[1] };
  }
  // anything else would reach gh as an argument, and one starting with `-` as a flag
  if (first === '--run' && rest.length === 1 && /^\d+$/.test(rest[0])) return { run: rest[0] };
  if (argv.length === 1 && first && !first.startsWith('-')) return { file: first };
  throw new Error(USAGE);
}

/** Why the baseline must not come from `run` (a run of the GitHub REST API), or undefined when it may. */
export function runRefusal(run) {
  if (run.path !== WORKFLOW) return `run is of ${run.path}, not of ${WORKFLOW}`;
  if (!TRUSTED_EVENTS.includes(run.event)) return `run was started by ${run.event}; take the baseline from a ${TRUSTED_EVENTS.join(' or ')} run`;
  const repository = run.repository?.full_name;
  const head = run.head_repository?.full_name;
  if (!repository || head !== repository) return `run measured code of ${head ?? 'an unknown repository'}, not of ${repository}: a fork's run cannot set the baseline`;
  return undefined;
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`gh is needed for this: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function currentBranch() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const branch = result.status === 0 ? result.stdout.trim() : '';
  return branch && branch !== 'HEAD' ? branch : undefined;
}

// Not `gh run list --workflow`: it looks the workflow up on the default branch, which a 4.x workflow is not on yet.
function latestRun(branch) {
  const fields = '.workflow_runs | map({ id, path, event, repository: { full_name: .repository.full_name }, head_repository: { full_name: .head_repository.full_name } })';
  const runs = JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=100`, '--jq', fields]));
  const run = runs.find((r) => runRefusal(r) === undefined);
  if (!run) throw new Error(`no successful push or workflow_dispatch run of cold-start.yml among the last ${runs.length} successful runs on ${branch}: push to it, or pass --run <run id>`);
  return String(run.id);
}

function checkedRun(runId) {
  const run = JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/runs/${runId}`]));
  const refusal = runRefusal(run);
  if (refusal) throw new Error(`run ${runId} cannot set the baseline: ${refusal}`);
  console.log(`run ${runId}: ${run.event} on ${run.head_branch} (${run.head_sha})`);
  return runId;
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
  const options = parseArgs(argv, { currentBranch: currentBranch() });
  if (options.latest) return fromRun(checkedRun(latestRun(options.branch)), apply);
  if (options.run) return fromRun(checkedRun(options.run), apply);
  return apply(resolve(options.file));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
