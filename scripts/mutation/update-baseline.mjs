#!/usr/bin/env node
// Replaces scripts/mutation/baseline.json with the scores of a mutation.yml run on a GitHub runner. The workflow never
// writes the baseline: a person runs this on the branch that holds it (v4 for 4.x) and commits the file in a pull request.
//   node scripts/mutation/update-baseline.mjs --latest [--branch <name>] [--allow-lower <target>]...
//   node scripts/mutation/update-baseline.mjs --run <run id> [--allow-lower <target>]...
//   node scripts/mutation/update-baseline.mjs <candidate.json> [--allow-lower <target>]...
// --latest and --run need the gh CLI.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_FILE, readBaseline, readTargets } from './gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'baseline.json');
const TARGETS = join(HERE, 'targets.json');
const WORKFLOW = '.github/workflows/mutation.yml';
const DEFAULT_BRANCH = 'v4';
// A pull_request run executes gate code its author controls, a fork's above all, so its candidate proves nothing.
const TRUSTED_EVENTS = ['push', 'workflow_dispatch', 'schedule'];
const USAGE = 'usage: update-baseline.mjs (--latest [--branch <name>] | --run <run id> | <candidate.json>) [--allow-lower <target>]...';

export function parseArgs(argv, { currentBranch }) {
  const allowLower = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--allow-lower') {
      rest.push(argv[i]);
      continue;
    }
    const name = argv[++i];
    if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error(USAGE);
    allowLower.push(name);
  }
  const [first, ...more] = rest;
  if (first === '--latest' && more.length === 0) return { latest: true, branch: currentBranch ?? DEFAULT_BRANCH, allowLower };
  if (first === '--latest' && more.length === 2 && more[0] === '--branch' && more[1] && !more[1].startsWith('-')) return { latest: true, branch: more[1], allowLower };
  if (first === '--run' && more.length === 1 && /^\d+$/.test(more[0])) return { run: more[0], allowLower };
  if (rest.length === 1 && first && !first.startsWith('-')) return { file: first, allowLower };
  throw new Error(USAGE);
}

export function runRefusal(run) {
  if (run.path !== WORKFLOW) return `run is of ${run.path}, not of ${WORKFLOW}`;
  if (!TRUSTED_EVENTS.includes(run.event)) return `run was started by ${run.event}; take the baseline from a ${TRUSTED_EVENTS.join(', ')} run`;
  const repository = run.repository?.full_name;
  const head = run.head_repository?.full_name;
  if (!repository || head !== repository) return `run measured code of ${head ?? 'an unknown repository'}, not of ${repository}: a fork's run cannot set the baseline`;
  return undefined;
}

export function nextBaseline({ candidate, current, targets, allowLower }) {
  if (candidate.measuredOn?.ci !== 'github-actions') throw new Error(`the candidate was not measured on CI (measuredOn.ci is ${JSON.stringify(candidate.measuredOn?.ci)})`);
  const missing = targets.filter((t) => candidate.targets?.[t.name] === undefined).map((t) => t.name);
  if (missing.length) throw new Error(`the run has no score for ${missing.join(', ')}: take a run in which every target finished`);
  const lowered = targets.filter((t) => current.targets[t.name] !== undefined && candidate.targets[t.name].score < current.targets[t.name].score && !allowLower.includes(t.name));
  if (lowered.length) {
    const list = lowered.map((t) => `${t.name} ${candidate.targets[t.name].score} < ${current.targets[t.name].score}`).join(', ');
    throw new Error(`lower than the baseline: ${list}; pass --allow-lower <target> for each and say why in the pull request`);
  }
  return { measuredOn: candidate.measuredOn, targets: Object.fromEntries(targets.map((t) => [t.name, candidate.targets[t.name]])) };
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
  const found = runs.find((r) => runRefusal(r) === undefined);
  if (!found) throw new Error(`no successful push, workflow_dispatch or schedule run of mutation.yml among the last ${runs.length} successful runs on ${branch}: pass --run <run id>`);
  return String(found.id);
}

function checkedRun(runId) {
  const run = JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/runs/${runId}`]));
  const refusal = runRefusal(run);
  if (refusal) throw new Error(`run ${runId} cannot set the baseline: ${refusal}`);
  console.log(`run ${runId}: ${run.event} on ${run.head_branch} (${run.head_sha})`);
  return runId;
}

function fromRun(runId, apply) {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-baseline-'));
  try {
    gh(['run', 'download', runId, '--name', 'mutation-gate', '--dir', dir]);
    return apply(join(dir, CANDIDATE_FILE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const options = parseArgs(argv, { currentBranch: currentBranch() });
  const apply = (file) => {
    const next = nextBaseline({ candidate: JSON.parse(readFileSync(file, 'utf8')), current: readBaseline(BASELINE), targets: readTargets(TARGETS).targets, allowLower: options.allowLower });
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n');
    console.log(`${BASELINE} updated from ${next.measuredOn.runUrl ?? file}:`);
    for (const [name, { score, valid }] of Object.entries(next.targets)) console.log(`  ${name}: ${score.toFixed(2)} (${valid} valid mutants)`);
    console.log('Commit it in a pull request; the gate compares against it from the next run on.');
  };
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
