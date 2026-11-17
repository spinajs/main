#!/usr/bin/env node
// Replaces scripts/mutation/baseline.json with the scores of a mutation.yml run on a GitHub runner. The workflow never
// writes the baseline: a person runs this on the branch that holds it (v4 for 4.x) and commits the file in a pull request.
//   node scripts/mutation/update-baseline.mjs --latest [--branch <name>] [--allow-lower <target>]...
//   node scripts/mutation/update-baseline.mjs --run <run id> [--branch <name>] [--allow-lower <target>]...
//   node scripts/mutation/update-baseline.mjs <candidate.json> [--branch <name>] [--allow-lower <target>]...
// The run and the candidate must be of REPOSITORY's --branch (default v4). --latest and --run need the gh CLI.
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
export const REPOSITORY = 'spinajs/main';
const RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/`;
const DEFAULT_BRANCH = 'v4';
// A pull_request run executes gate code its author controls, a fork's above all, so its candidate proves nothing.
const TRUSTED_EVENTS = ['push', 'workflow_dispatch', 'schedule'];
const USAGE = 'usage: update-baseline.mjs (--latest | --run <run id> | <candidate.json>) [--branch <name>] [--allow-lower <target>]...';

export function parseArgs(argv) {
  const allowLower = [];
  const rest = [];
  let branch;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--allow-lower' && flag !== '--branch') {
      rest.push(flag);
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw new Error(USAGE);
    if (flag === '--branch') {
      if (branch !== undefined) throw new Error(USAGE);
      branch = value;
    } else {
      if (!/^[a-z0-9-]+$/.test(value)) throw new Error(USAGE);
      allowLower.push(value);
    }
  }
  const common = { branch: branch ?? DEFAULT_BRANCH, allowLower };
  const [first, ...more] = rest;
  if (first === '--latest' && more.length === 0) return { latest: true, ...common };
  if (first === '--run' && more.length === 1 && /^\d+$/.test(more[0])) return { run: more[0], ...common };
  if (rest.length === 1 && first && !first.startsWith('-')) return { file: first, ...common };
  throw new Error(USAGE);
}

export function runRefusal(run, branch) {
  if (run.path !== WORKFLOW) return `run is of ${run.path}, not of ${WORKFLOW}`;
  if (!TRUSTED_EVENTS.includes(run.event)) return `run was started by ${run.event}; take the baseline from a ${TRUSTED_EVENTS.join(', ')} run`;
  const repository = run.repository?.full_name;
  if (repository !== REPOSITORY) return `run belongs to ${repository ?? 'an unknown repository'}, not to ${REPOSITORY}`;
  const head = run.head_repository?.full_name;
  if (head !== REPOSITORY) return `run measured code of ${head ?? 'an unknown repository'}, not of ${REPOSITORY}`;
  if (run.head_branch !== branch) return `run measured branch ${run.head_branch ?? '(none)'}, not ${branch}; pass --branch <name> for another branch`;
  return undefined;
}

/**
 * Checks the candidate's own record of where it was measured; `runId` and `commit` are the run it was downloaded from
 * and that run's head commit, if any.
 */
export function provenanceRefusal(measuredOn, { branch, runId, commit }) {
  if (measuredOn?.ci !== 'github-actions') return `the candidate was not measured on CI (measuredOn.ci is ${JSON.stringify(measuredOn?.ci)})`;
  if (measuredOn.repository !== REPOSITORY) return `the candidate was measured in ${JSON.stringify(measuredOn.repository)}, not in ${REPOSITORY}`;
  if (measuredOn.ref !== `refs/heads/${branch}`) return `the candidate was measured on ${JSON.stringify(measuredOn.ref)}, not on refs/heads/${branch}`;
  const id = typeof measuredOn.runUrl === 'string' && measuredOn.runUrl.startsWith(RUN_URL) ? measuredOn.runUrl.slice(RUN_URL.length) : '';
  if (!/^\d+$/.test(id)) return `the candidate's run URL ${JSON.stringify(measuredOn.runUrl)} is not a run of ${RUN_URL}<id>`;
  if (runId !== undefined && id !== runId) return `the candidate names run ${id}, not run ${runId}`;
  if (commit !== undefined && measuredOn.commit !== commit) return `the candidate names commit ${JSON.stringify(measuredOn.commit)}, not the run's head commit ${commit}`;
  return undefined;
}

// `head_branch` holds a tag's name for a run of a tag, so only the commit's ancestry tells a branch run from a tag run.
/** `status` of GitHub's compare of refs/heads/<branch> (base) with the run's head commit. */
export function ancestryRefusal(status, { branch, commit }) {
  if (status === 'identical' || status === 'behind') return undefined;
  return `the run's head commit ${commit} is not on refs/heads/${branch} (compare status ${JSON.stringify(status)})`;
}

function entryRefusal(name, entry) {
  const { score, valid } = entry ?? {};
  if (!(typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100)) return `${name}: score ${JSON.stringify(score)} is not a number from 0 to 100`;
  if (!(Number.isInteger(valid) && valid >= 0)) return `${name}: valid ${JSON.stringify(valid)} is not a non-negative integer`;
  return undefined;
}

export function nextBaseline({ candidate, current, targets, allowLower, branch, runId, commit }) {
  const refusal = provenanceRefusal(candidate.measuredOn, { branch, runId, commit });
  if (refusal) throw new Error(refusal);
  const missing = targets.filter((t) => candidate.targets?.[t.name] === undefined).map((t) => t.name);
  if (missing.length) throw new Error(`the run has no score for ${missing.join(', ')}: take a run in which every target finished`);
  const malformed = targets.map((t) => entryRefusal(t.name, candidate.targets[t.name])).filter(Boolean);
  if (malformed.length) throw new Error(`the candidate is malformed: ${malformed.join('; ')}`);
  const lowered = targets.filter((t) => current.targets[t.name] !== undefined && candidate.targets[t.name].score < current.targets[t.name].score && !allowLower.includes(t.name));
  if (lowered.length) {
    const list = lowered.map((t) => `${t.name} ${candidate.targets[t.name].score} < ${current.targets[t.name].score}`).join(', ');
    throw new Error(`lower than the baseline: ${list}; pass --allow-lower <target> for each and say why in the pull request`);
  }
  return { measuredOn: candidate.measuredOn, targets: Object.fromEntries(targets.map((t) => [t.name, { score: candidate.targets[t.name].score, valid: candidate.targets[t.name].valid }])) };
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`gh is needed for this: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

// Not `gh run list --workflow`: it looks the workflow up on the default branch, which a 4.x workflow is not on yet.
function latestRun(branch) {
  const fields = '.workflow_runs | map({ id, path, event, head_branch, repository: { full_name: .repository.full_name }, head_repository: { full_name: .head_repository.full_name } })';
  const runs = JSON.parse(gh(['api', `repos/${REPOSITORY}/actions/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=100`, '--jq', fields]));
  const found = runs.find((r) => runRefusal(r, branch) === undefined);
  if (!found) throw new Error(`no successful push, workflow_dispatch or schedule run of mutation.yml among the last ${runs.length} successful runs on ${branch}: pass --run <run id>`);
  return String(found.id);
}

function checkedRun(runId, branch) {
  const run = JSON.parse(gh(['api', `repos/${REPOSITORY}/actions/runs/${runId}`]));
  const refusal = runRefusal(run, branch) ?? (/^[0-9a-f]{40}$/.test(run.head_sha ?? '') ? undefined : `run head commit ${JSON.stringify(run.head_sha)} is not a commit id`);
  if (refusal) throw new Error(`run ${runId} cannot set the baseline: ${refusal}`);
  const ref = `refs/heads/${branch}`.split('/').map(encodeURIComponent).join('/');
  const status = gh(['api', `repos/${REPOSITORY}/compare/${ref}...${run.head_sha}`, '--jq', '.status']).trim();
  const off = ancestryRefusal(status, { branch, commit: run.head_sha });
  if (off) throw new Error(`run ${runId} cannot set the baseline: ${off}`);
  console.log(`run ${runId}: ${run.event} on ${run.head_branch} (${run.head_sha})`);
  return { runId, commit: run.head_sha };
}

function fromRun({ runId, commit }, apply) {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-baseline-'));
  try {
    gh(['run', 'download', runId, '--repo', REPOSITORY, '--name', 'mutation-gate', '--dir', dir]);
    return apply(join(dir, CANDIDATE_FILE), runId, commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const apply = (file, runId, commit) => {
    const next = nextBaseline({ candidate: JSON.parse(readFileSync(file, 'utf8')), current: readBaseline(BASELINE), targets: readTargets(TARGETS).targets, allowLower: options.allowLower, branch: options.branch, runId, commit });
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n');
    console.log(`${BASELINE} updated from ${next.measuredOn.runUrl ?? file}:`);
    for (const [name, { score, valid }] of Object.entries(next.targets)) console.log(`  ${name}: ${score.toFixed(2)} (${valid} valid mutants)`);
    console.log('Commit it in a pull request; the gate compares against it from the next run on.');
  };
  if (options.latest) return fromRun(checkedRun(latestRun(options.branch), options.branch), apply);
  if (options.run) return fromRun(checkedRun(options.run, options.branch), apply);
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
