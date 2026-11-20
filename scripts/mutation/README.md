# Mutation testing of the authz decision code

Stryker mutates the authz engine, the IR reference evaluator and the three model packages; a gate fails a run when a
target's score drops more than 2 points below a baseline that only a person raises, in a reviewed pull request.

Files: `targets.json` (targets, tolerance, CI concurrency, triage focus), `baseline.json` (CI scores),
`gate.mjs` (score, verdict, summary, candidate, matrix), `update-baseline.mjs` (copies a CI candidate into
`baseline.json`), `mocha-setup.mjs` (fixed fast-check seed and reduced run counts, required by every
`.mocharc.stryker.json`). The workflow is `.github/workflows/mutation.yml`; the tests are
`scripts/__tests__/mutation-*.test.mjs` (`npm run test:scripts`).

## What runs

| Package | Whole-package `mutate` (`stryker.config.json`) | Targets (gate keys) | Triage focus |
|---|---|---|---|
| `authz` | `src/engine/**/*.ts` | four shards, `authz-engine-<shard>` (below) | `src/engine/combinators.ts` |
| `authz-ir` | `src/eval/**/*.ts` | `authz-ir-eval` | `src/eval/check.ts` |
| `authz-rbac` | `src/model/**/*.ts`, `!src/model/memory.ts` | three shards, `authz-rbac-model-<shard>` (below) | none |
| `authz-rebac` | `src/model/**/*.ts`, `src/namespace/compile.ts` | `authz-rebac-model` | none |
| `authz-abac` | `src/model/**/*.ts`, `!src/model/stores/**`, `!src/model/schema.ts` | `authz-abac-model` | none |

Each package has a `stryker.config.json` (mocha runner, ts-node ESM loader in `testRunnerNodeArgs`, per-test coverage,
`inPlace`, `ignoreStatic`, `timeoutMS` 10000) and a `.mocharc.stryker.json` with its test selection. Stryker's mocha
runner ignores the `node-option` entries of `.mocharc`, hence the separate file.

### Shards

The engine and the RBAC model take longer than the 90-minute budget ("Runtime"), so CI runs them as shards: one
`stryker.<shard>.config.json` next to `stryker.config.json` each, the same settings with a part of the `mutate` set, a
report of its own (`reports/mutation/<shard>/mutation.json`) and a temp folder of its own, and one entry in
`targets.json`. The whole-package `stryker.config.json` stays for local runs and triage; `mutation-shards.test.mjs`
checks that the shards of a package together mutate exactly its files, each file in one shard.

| Target | Config `mutate` (under `src/engine/` or `src/model/`) | Files | Mutants | Projected CI minutes |
|---|---|---|---|---|
| `authz-engine-decide` | `{evaluate,combinators,vote,ceiling,delegation,attributes}.ts` | 6 | 2,203 | 66 to 76 |
| `authz-engine-pipeline` | `pipeline/**`, `{authorizer,run,tracing}.ts`, `summary/**` | 16 | 2,153 | 63 to 75 |
| `authz-engine-cache` | `{cache-key,cache,context,plan,registry,routes}.ts`, `{cache,context,plan}/**` | 16 | 2,283 | 65 to 79 |
| `authz-engine-rest` | every other engine file: `refs`, `fields`, `reasons`, `validate`, `support/**`, `types`, ... | 16 | 2,342 | 59 to 81 |
| `authz-rbac-model-rules` | `rules/**`, `sets/**`, `links/**`, `{service,contributor}.ts` | 13 | 1,675 | 40 to 60 |
| `authz-rbac-model-ladder` | `ladder/**`, `{evaluate,roles,patterns,fields}.ts` | 10 | 1,584 | 38 to 61 |
| `authz-rbac-model-rest` | every other model file but `memory.ts`: `model`, `cache`, `grants`, `list/**`, ... | 13 | 1,675 | 40 to 59 |

How the cuts were made: mutant counts per file from Stryker's own instrumenter (they add up to the dry-run totals),
and a cost per file from a dry run, the summed time of the tests covering each mutant (what a mutant costs when it
survives). Each shard holds about a quarter (engine) or a third (RBAC) of both. The projections scale the
whole-package ones ("Runtime"): for the engine, from the shard's share of the cost (~253 minutes for the package, the
cost calibrated on the measured `evaluate.ts` + `combinators.ts` sample) to its share of the mutants at that sample's
rate (~311); for RBAC, from its share of the mutants at the linear rate (117) to its share of the cost at Stryker's
estimate (~180). RBAC is cut in three, not two: at Stryker's estimate two halves would take about 90 minutes each.

To re-cut a shard (a file grew, or a shard runs over the budget): move globs between the shard configs, keep the shard
that holds a target's `focus` file listing it, and run `npm run test:scripts`. A new file under a sharded `mutate` glob
lands in the shard whose globs match it; the `rest` shard of each package matches every file the others do not name.
Once `baseline.json` holds scores, a re-cut moves mutants between gate keys, so the next run may fail the gate for a
shard whose score dropped: record that run with `update-baseline.mjs --run <id> --allow-lower <target>` for each such
shard, and say in the pull request that the drop is the re-cut. A new shard has no baseline entry and is recorded the
same way ("The baseline").

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

- **Timing tests**: a test that asserts a wall-clock bound ends its title with `@timing`, and every
  `.mocharc.stryker.json` drops those titles with `"grep": "^(?!.*@timing)"` (Stryker's mocha runner ignores `invert`).
  Instrumented code runs slower, so such a test would kill a mutant by being slow, and a slow runner could fail the dry
  run. `npm test` still runs them. Tag every new test that measures elapsed time.
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
npm run mutation                                                     # whole package (stryker.config.json)
npx stryker run stryker.decide.config.json                           # one shard, as CI runs it
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

| Whole package | Mutants | Tests | Initial test run | Local measurement | Projected CI minutes | 90-minute budget |
|---|---|---|---|---|---|---|
| `authz-engine` | 8,981 | 1,897 | 100 s | scaled from a 783-mutant sample (`evaluate.ts`, `combinators.ts`): 6.24 s per mutant per worker | ~311 | does not fit: four shards |
| `authz-ir-eval` | 952 | 73 | 8 s | complete in 1 min | ~1 | fits |
| `authz-rbac-model` | 4,934 | 1,518 | 112 s | stopped at 60 min with 3,173 of 4,841 tested; Stryker estimated 74 min more | 117 (linear) to ~180 (Stryker's estimate) | does not fit: three shards |
| `authz-rebac-model` | 1,050 | 113 | 16 s | complete in 72 min, 124 timeouts (118 in `namespace/compile.ts`) | ~85 to ~96 | borderline, not sharded (below) |
| `authz-abac-model` | 1,222 | 204 | 15 s | complete in 10 min | ~8 to 13 | fits |

The budget is **90 minutes of Stryker per target**. The `stryker` step stops at 150 minutes and the job at 170, so a
target between 90 and 150 minutes still reports a score; a job cut off fails, and the gate fails its target as "no
report". A target over the budget is split into shards ("Shards"). The workflow's matrix comes from `targets.json`
(`gate.mjs --matrix` adds each config's report path) and its `paths` filter matches `packages/*/stryker*.json`, so a
re-cut needs no workflow change. The step logs `progress-append-only` lines (tested count, elapsed and remaining time),
so a cut-off run still shows its rate.

`authz-rebac-model` is not sharded: its complete local run spent about 2 of its 72 minutes on the 676 mutants of
`model/**` and the other 70 on the 374 of `namespace/compile.ts`, which holds 118 of its 124 timeouts. A cut at file boundaries leaves that one file over the budget on its own, so a split would add a job and
save nothing. If CI confirms more than 90 minutes, the lever is the timeouts of `compile.ts`, not a shard.

## Test minimisation runs

`scripts/coverage/minimal-tests.mjs` needs every killer of each mutant. The configs bail on the first killing test, so
pass `--disableBail` on the command line for a run whose report feeds it:

```bash
npx stryker run stryker.config.json --disableBail
node ../../scripts/coverage/minimal-tests.mjs reports/mutation/mutation.json
```
