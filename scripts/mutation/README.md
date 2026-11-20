# Mutation testing of the authz decision code

Stryker mutates the authz engine, the IR reference evaluator and the three model packages; a gate fails a run when a
target's score drops more than 2 points below a baseline that only a person raises, in a reviewed pull request.

Files: `targets.json` (targets, tolerance, CI concurrency, triage focus), `baseline.json` (CI scores),
`gate.mjs` (score, verdict, summary, candidate, matrix), `update-baseline.mjs` (copies a CI candidate into
`baseline.json`), `mocha-setup.mjs` (fixed fast-check seed and reduced run counts, required by every
`.mocharc.stryker.json`). The workflow is `.github/workflows/mutation.yml`; the tests are
`scripts/__tests__/mutation-*.test.mjs` (`npm run test:scripts`).

## What runs

| Target (gate key) | Package | `mutate` | Triage focus |
|---|---|---|---|
| `authz-engine` | `authz` | `src/engine/**/*.ts` | `src/engine/combinators.ts` |
| `authz-ir-eval` | `authz-ir` | `src/eval/**/*.ts` | `src/eval/check.ts` |
| `authz-rbac-model` | `authz-rbac` | `src/model/**/*.ts`, `!src/model/memory.ts` | none |
| `authz-rebac-model` | `authz-rebac` | `src/model/**/*.ts`, `src/namespace/compile.ts` | none |
| `authz-abac-model` | `authz-abac` | `src/model/**/*.ts`, `!src/model/stores/**`, `!src/model/schema.ts` | none |

Each package has a `stryker.config.json` (mocha runner, ts-node ESM loader in `testRunnerNodeArgs`, per-test coverage,
`inPlace`, `ignoreStatic`, `timeoutMS` 10000) and a `.mocharc.stryker.json` with its test selection. Stryker's mocha
runner ignores the `node-option` entries of `.mocharc`, hence the separate file.

Left out, and why:

- **Stores and persistence** (abac `model/stores/**`, rbac `model/memory.ts`, every `src/stores/**`): they hold data,
  and the decision logic is what is measured. The store-contract suites cover them.
- **Test files that boot a database** (sqlite or Postgres through `test/support/db.ts` or `db-harness`): a dry run must
  not need a server, and a DI boot per mutant would dominate the run. The `ignore` list of each `.mocharc.stryker.json`
  names them.
- **Test files with a test slower than 5 s** under the reduced run counts: Stryker reruns every covering test of each
  mutant. Dropped after profiling:

  | Package | File | Slowest test |
  |---|---|---|
  | authz | `test/contracts/api-snapshot.test.ts` | 69.7 s |
  | authz | `test/engine/behaviour/B03-combination.test.ts` | 9.2 s |
  | authz | `test/contracts/fields.test.ts` | 5.0 s |
  | authz-rbac | `test/stores/config-role-store.test.ts` | 8.9 s |
  | authz-rbac | `test/ladder/agreement.test.ts` | 5.6 s |
  | authz-rbac | `test/cli/discovery.test.ts` | 5.8 s, and it hit its own 30 s timeout in a dry run (it reads built `lib/` only) |

- **`authz` host and admin suites** (`test/host/**`, `test/admin/**`): they boot DI in separate mocha processes.
  Engine code only they reach counts as NoCoverage.
- **Cross-package kills:** a package's tests import other packages from their built `lib/`, so a mutant in `authz/src`
  is invisible to `authz-rbac` tests. Each score counts its own package's tests only.
- **Not mutated:** `authz/src/contracts/filter.ts`, `authz/src/conditions/**`, `authz-ir/src/compile/**` and `dsl/**`,
  `authz-rebac/src/{expand,list-subjects}.ts`.

The rbac `.mocharc.stryker.json` also requires `@spinajs/log`: some of its test files need it loaded, which a full
`npm test` gets through the DB support files this selection leaves out.

## The workflow

`.github/workflows/mutation.yml` runs on:

- **push to `v4`** when a mutated package's `src` or `test`, `authz-testing/src`, a Stryker config or `scripts/mutation/`
  changes (the `paths` filter);
- **`schedule`** (02:17 UTC) and **`workflow_dispatch`**, which GitHub starts only from the default branch's copy of the
  file: they are inert until v4 reaches master.

Pull requests are not gated: a run takes hours. A pull request that lowers a score merges green, and the next push run
turns red and names the target.

Jobs: `targets` prints the matrix (`gate.mjs --matrix`); `mutate` runs one job per target (`npm ci`, full build,
`npx stryker run <config> --concurrency 3`), fails if the run left mutants in `packages/`, and uploads
`mutation-<target>` (its `mutation.json`); `gate` downloads them all and runs
`gate.mjs --reports mutation-reports --out-dir mutation-gate`, writes the table to the job summary and uploads
`mutation-gate` (`mutation-baseline.candidate.json`). A run in progress is never cancelled: a newer push waits for
it, and a third push cancels the waiting run and waits in its place (the newest run covers the commits of both).

The runner checks out LF line endings (every authz fixture is stored LF and Linux git does not convert them).

## The score and the gate

Score = (killed + timeout) / (killed + timeout + survived + no coverage), floored to two decimals. Ignored,
CompileError and RuntimeError mutants are not valid and do not count. NoCoverage counts as undetected, so untested
code lowers the score. `ignoreStatic` drops mutants of module-level constants (a static mutant needs a fresh module
per test).

A target fails when its score is more than `tolerance` (2) points below its `baseline.json` entry, when its report is
missing (the job failed or timed out), or when the report still holds Pending mutants. The gate cannot run without
`baseline.json` or with a malformed one. While the baseline holds no score at all (`"targets": {}`, before the first
recorded run), every target is reported as "not gated: no baseline yet". Once it holds scores, a target without an
entry fails until its first CI score is recorded. Surviving and NoCoverage mutants of each target's `focus` files are
listed under the table.

## The baseline

`baseline.json` holds GitHub runner scores only. The workflow never writes it.

- **Raise** after a run that scored higher: `node scripts/mutation/update-baseline.mjs --latest` from any branch, then
  commit `baseline.json` in a pull request. Every mode takes the scores of branch `v4`; `--branch <name>` names another
  (`master`, once 4.x is there).
- **A given run:** `--run <run id>`. **A downloaded candidate:** pass the file path, but see below: the reviewed
  baseline change must come from `--run` or `--latest`.
- **Lower** only with `--allow-lower <target>` for each target that dropped, and the reason in the pull request
  (new untested code, a Stryker upgrade).
- **A new or split target** added to `targets.json` after the first baseline fails the next run ("no baseline entry")
  by design. Record it from that run with `--run <id>`: the script writes the targets of `targets.json` only, so a
  replaced target's old key leaves `baseline.json` in the same commit.

The script reads runs of `spinajs/main` only (`gh --repo spinajs/main`, whatever the clone's remote). It refuses:

- a run of another workflow, a `pull_request` run, a run whose repository or head repository is not `spinajs/main`,
  and a run whose head branch is not the `--branch`;
- a candidate whose `measuredOn` is not `ci: "github-actions"`, `repository: "spinajs/main"`,
  `ref: "refs/heads/<branch>"` and a `runUrl` of a `spinajs/main` run (with `--run <id>` or `--latest`: that run), so a
  candidate file without these fields is refused too;
- with `--run <id>` or `--latest`: a candidate whose `commit` is not the run's head commit, and a run whose head commit
  is not on `refs/heads/<branch>` (GitHub's compare of the branch with that commit), which refuses a run of a tag named
  like the branch;
- a candidate in which a target has no score, or an entry that is not a `score` from 0 to 100 with a non-negative
  integer `valid` (the whole update is refused, naming the target).

A candidate file passed by path is checked only against what it says about itself: anyone can type the provenance
fields next to invented scores, so file mode proves nothing about where the scores came from. The pull request that
changes `baseline.json` must take them from `--run <id>` (or `--latest`) and link the run.

`--latest` and `--run` need the `gh` CLI.

## Running locally

```bash
cd packages/<pkg>
npm run mutation                                                     # whole target
npx stryker run stryker.config.json --mutate src/engine/combinators.ts   # one file
node ../../scripts/mutation/gate.mjs --report <target>=reports/mutation/mutation.json
git status --porcelain src test                                     # must print nothing
```

- One target at a time, `--concurrency 4` at most: the machine runs out of memory otherwise.
- A partial run (`--mutate` one file) compared with a full-target baseline reads as a drop; judge it by its survivors.
- Runs are in place. Stryker writes mutants into `src/` and `// @ts-nocheck` into every `.js`/`.ts` file of `src/`,
  `test/` and `lib/`, and restores them only on a clean exit. A killed run leaves `src/` and `test/` modified:
  1. Stop the Stryker parent and its workers. On Windows, killing `npx` (or `timeout`) leaves them running as orphans:
     find them by command line and stop them by PID.
  2. `git checkout -- packages/<pkg>/src packages/<pkg>/test`.
  3. Copy `lib/` back from `.stryker-tmp/<pkg>/backup-*/lib` (git does not see `lib/`), then delete that backup folder.
- On Windows with `core.autocrlf=true`, the golden fixtures `authz-ir/test/fixtures/{docs.fga,impact-3-3.fga,impact-3-3.ir.json}`
  and `authz-rbac/test/fixtures/invoice.ir.json` check out with CRLF line endings, and their tests fail locally, and so
  does a Stryker dry run. Check them out as LF: `git -c core.autocrlf=false checkout -- <files>`.

## Triage of survivors

A survivor is closed in one of three ways, nothing else ("not worth a test" is not a verdict):

1. **Flaky:** confirm it in a clean process,
   `npx stryker run stryker.config.json --mutate <file>:<line>-<line> --concurrency 1`. Killed now means the survival
   came from worker state: no change.
2. **Kill it:** find an input whose observable result differs under the mutant. Hand-apply the replacement, write the
   test so it fails against the mutant, restore the source with `git checkout -- <file>`, see the test pass, repeat
   step 1 (expected: Killed).
3. **Equivalent:** only when no input tells the two apart. Write the argument in the pull request and put above the
   line:

   ```ts
   // Stryker disable next-line <MutatorName>: <why no input can tell them apart>
   ```

   Repeat step 1; expected: Ignored.

## Runtime

Measured locally (Windows, `--concurrency 4`, on a machine shared with other builds, so pessimistic). Projected CI
minutes are for 3 workers at the same speed per worker.

| Target | Mutants | Tests | Initial test run | Local measurement | Projected CI minutes | 90-minute budget |
|---|---|---|---|---|---|---|
| `authz-engine` | 8,981 | 1,897 | 100 s | scaled from a 783-mutant sample (`evaluate.ts`, `combinators.ts`): 6.24 s per mutant per worker | ~311 | does not fit |
| `authz-ir-eval` | 952 | 73 | 8 s | complete in 1 min | ~1 | fits |
| `authz-rbac-model` | 4,934 | 1,518 | 112 s | stopped at 60 min with 3,173 of 4,841 tested; Stryker estimated 74 min more | 117 (linear) to ~180 (Stryker's estimate) | does not fit |
| `authz-rebac-model` | 1,050 | 113 | 16 s | stopped at 60 min with 1,011 of 1,035 tested, 100 of them timeouts at 10 s each | ~85 to 87 | borderline |
| `authz-abac-model` | 1,222 | 204 | 15 s | complete in 10 min | ~8 to 13 | fits |

The budget is **90 minutes of Stryker per target**. The `stryker` step stops at 150 minutes and the job at 170, so a
target between 90 and 150 minutes still reports a score. A target over the budget is split into targets with disjoint
`mutate` globs (one config and one gate key each, `authz-engine` into about four, `authz-rbac-model` into two). The
workflow's matrix comes from `targets.json` and its `paths` filter matches `packages/*/stryker*.json`, so a split needs
no workflow change as long as each shard config keeps `jsonReporter.fileName` `reports/mutation/mutation.json`. The
split lands before the first baseline is recorded. **Until it lands, the `authz-engine` job is expected to exceed its
time limit, and the `authz-rbac-model` job may** (117 minutes projected linearly fits the 150-minute step limit, ~180
by Stryker's estimate does not): a job cut off fails, the gate fails its target as "no report", and the run cannot set
a baseline. The step
logs `progress-append-only` lines (tested count, elapsed and remaining time), so a cut-off run still shows its rate.

## Test minimisation runs

`scripts/coverage/minimal-tests.mjs` needs every killer of each mutant. The configs bail on the first killing test, so
pass `--disableBail` on the command line for a run whose report feeds it:

```bash
npx stryker run stryker.config.json --disableBail
node ../../scripts/coverage/minimal-tests.mjs reports/mutation/mutation.json
```
