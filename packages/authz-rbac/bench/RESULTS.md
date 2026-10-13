# Release gate 7: canvas `file:read` list and 50-row pages over 1,000 files (results)

How the bench works and how to run it: `BASELINE.md`.

## Release gate 7 for 3.0 after S1 (class-wise rule terms)

Two runs on 2026-10-10, branch `authz/S1-set-based-sql`, then based on `authz-v3-refactor` fb17360ea (A4 merged).
The commits were later rebased onto 66d555dd6, with no change to authz-rbac; their SHAs after that rebase:

- **S1 task 3**: the rule list terms worked out once per class of rows (e1eafae7b), route pruning and attribute
  lookups as columns (ea50b770d), and the agent principal in the bench (f470268e7).
- **S1 task 4**: the same SQL, byte for byte, built in time linear in its size (8f52ade6b: authz-rbac's fragment
  layer no longer copies and checks nested fragments at every level). This is the current state.

`--filter=postgres.jit-off`, once without and once with `L4B_BENCH_BACKGROUND=90`. Limits as in G7 (plan §12
item 7): list p50 ≤ 1.5 s; a 50-row page p50 ≤ 100 ms and p99 ≤ 250 ms.

**Gate 7 for 3.0: OPEN. The owner will rethink the limits** (human decision, 2026-10-10). The numbers below are
set against G7's limits for reference only, not as a verdict.

| measure (G7's limit) | bg0 (task 4)                  | bg90 (task 4)                                                     | task 3 (bg0 / bg90)   |
| -------------------- | ----------------------------- | ----------------------------------------------------------------- | --------------------- |
| list p50 (1.5 s)     | 90 to 182 ms, 7 of 7 under    | 94 to 201 ms, 7 of 7 under                                        | 7 of 7 / 7 of 7 under |
| page p50 (100 ms)    | 90 to 128 ms, 7 of 14 under   | 95 to 174 ms, 3 of 14 under (reruns of three principals: 103-142) | 0 of 14 / 0 of 14     |
| page p99 (250 ms)    | 133 to 189 ms, 14 of 14 under | 13 of 14 under; link's middle page 306 ms (191 ms in its rerun)   | 12 of 14 / 14 of 14   |

At bg0 the owner, guest and external pages are under 100 ms, and so is the member's first page; member-all and link
are 24 to 28 % over, the agent and the member's middle page 2 to 5 %. Compiling a statement in Node now takes 23 to 36 ms
against 67 to 91 ms before (see "What the numbers say"); the rest of a page is the statement on the driver (55 to 93 ms).

### Environment

Windows 11 (10.0.26200), Node 24.14.1, Intel i7-12700KF (20 threads); PostgreSQL 16.6 (Debian, Docker Desktop on
the same machine), `work_mem` 4 MB, `shared_buffers` 128 MB, the bench database with `jit = off`. Data (seed 7):
as in L4b (1,299 assignments, 350 stored rules, 25 attribute rows; ×10 with 90 background tenants), 1,000 files.

Load, task 4: other sessions' processes kept the CPU about 50 % busy. The bg0 run took 13 min; its first two tries
stopped at boot on `connect ETIMEDOUT` to the shared Postgres server (nothing timed). The bg90 run took 17 min and
was disturbed towards its end: the agent's reference (the plain `EXISTS`, the same statement as the member's)
took 140 ms against the member's 116 ms, and link's pages 167 to 174 ms against 127 to 128 ms at bg0. External,
link and the agent were rerun alone at bg90 (`--filter=postgres.jit-off.<who>.`): 103 to 142 ms for their pages,
which still fail. The tables give the full run; the reruns are listed below it. Outputs:
`.authz-sdd/S1-t4-bench-bg0.txt`, `S1-t4-bench-bg90.txt`, `S1-t4-bench-bg90-rerun-<who>.txt`.

Load, task 3: 30 to 50 % busy; bg0 17 min, bg90 18 min after one `ETIMEDOUT` try; no second-long stalls
(`.authz-sdd/S1-bench-bg0.txt`, `S1-bench-bg90.txt`).

Rows per principal (list / reference): owner 100 / 100, member 172 / 181, member-all 760 / 800, guest 38 / 40,
external 22 / 43, link 19 / 20; the agent lists 95. Every list was checked against 1,000 single checks, and every
page against its slice of the list, before it was timed.

### Against G7's limits, no background tenants (bg0)

p50 and p99 in ms, median of 3 repeats (lists 30 iterations, pages 100). Task 4; the last column gives task 3's
page p50s (first / middle).

| principal  | rows | middle offset | list p50 | page-first p50 |   p99 | page-middle p50 |   p99 | list (1.5 s) | page (100 / 250 ms) | task 3 pages p50 |
| ---------- | ---: | ------------: | -------: | -------------: | ----: | --------------: | ----: | ------------ | ------------------- | ---------------: |
| owner      |  100 |            50 |    100.1 |           94.3 | 143.1 |            96.0 | 133.1 | under        | under               |    129.6 / 126.4 |
| member     |  172 |           100 |    111.3 |           96.8 | 138.7 |           101.9 | 142.8 | under        | over (middle p50)   |    131.0 / 130.8 |
| member-all |  760 |           400 |    182.4 |          124.5 | 187.5 |           126.3 | 189.3 | under        | over (p50)          |    159.2 / 170.0 |
| guest      |   38 |     0 (first) |     94.7 |           93.4 | 134.3 |            98.3 | 141.2 | under        | under               |    136.6 / 138.3 |
| external   |   22 |     0 (first) |     90.3 |           91.7 | 136.0 |            89.7 | 134.4 | under        | under               |    126.0 / 122.9 |
| link       |   19 |     0 (first) |    129.1 |          128.1 | 171.0 |           126.6 | 179.8 | under        | over (p50)          |    172.5 / 181.9 |
| agent      |   95 |            50 |    105.6 |          103.9 | 149.3 |           105.3 | 156.6 | under        | over (p50)          |    135.2 / 136.5 |

### Against G7's limits, 90 background tenants (bg90)

| principal  | list p50 | page-first p50 |   p99 | page-middle p50 |   p99 | list (1.5 s) | page (100 / 250 ms)    | task 3 pages p50 |
| ---------- | -------: | -------------: | ----: | --------------: | ----: | ------------ | ---------------------- | ---------------: |
| owner      |    108.3 |          106.9 | 151.0 |           104.7 | 149.4 | under        | over (p50)             |    134.6 / 135.4 |
| member     |    126.6 |          110.2 | 158.7 |           115.2 | 165.5 | under        | over (p50)             |    141.9 / 143.6 |
| member-all |    201.4 |          138.3 | 192.2 |           129.3 | 177.8 | under        | over (p50)             |    170.0 / 169.9 |
| guest      |     93.5 |           96.0 | 136.2 |            94.5 | 132.0 | under        | under                  |    133.6 / 132.5 |
| external   |    100.7 |           96.6 | 129.4 |           114.7 | 211.9 | under        | over (middle p50)      |    133.2 / 132.0 |
| link       |    148.7 |          166.8 | 246.5 |           173.5 | 305.6 | under        | over (p50, middle p99) |    184.1 / 182.9 |
| agent      |    151.6 |          139.3 | 220.7 |           144.4 | 217.1 | under        | over (p50)             |    145.7 / 149.1 |

Reruns alone (bg90): external list 103.7, pages 107.2 / 167.3 and 102.7 / 150.7 (over, p50); link 136.0, 142.1 /
199.0 and 139.5 / 190.6 (over, p50); agent 122.8, 117.2 / 178.8 and 117.4 / 178.8 (over, p50).

### Before → after (bg0, against G7)

G7's run (below) was on a heavily loaded machine; L4b measured the same lists at 394 to 1,183 ms on a quieter one.
The agent is new since task 3. p50 in ms, G7 → task 3 → task 4.

| principal  |               list p50 |        page-first p50 |        page-middle p50 |
| ---------- | ---------------------: | --------------------: | ---------------------: |
| owner      | 2056.1 → 139.7 → 100.1 | 2057.5 → 129.6 → 94.3 |  1856.8 → 126.4 → 96.0 |
| member     | 1484.7 → 140.1 → 111.3 | 1043.9 → 131.0 → 96.8 | 1229.5 → 130.8 → 101.9 |
| member-all |  779.2 → 211.4 → 182.4 | 230.2 → 159.2 → 124.5 |  507.3 → 170.0 → 126.3 |
| guest      |   359.9 → 123.9 → 94.7 |  382.7 → 136.6 → 93.4 |   369.9 → 138.3 → 98.3 |
| external   |   372.2 → 126.2 → 90.3 |  366.0 → 126.0 → 91.7 |   345.0 → 122.9 → 89.7 |
| link       |  340.0 → 172.0 → 129.1 | 346.3 → 172.5 → 128.1 |  347.7 → 181.9 → 126.6 |
| agent      |    (new) 139.5 → 105.6 |   (new) 135.2 → 103.9 |    (new) 136.5 → 105.3 |

### The 3.1 target: list ≤ 2 × the plain `EXISTS`

`list` = (a) through authz-orm's middleware, `exists` = (b) the r2 v1 term; `-sql` = the bare statements. p50 ratio
/ p99 ratio, task 4; a row passes at ≤ 2 for both. The last column is task 3's `list` ratios (bg0 / bg90).

| principal  | list bg0 (a / b ms)              | list-sql bg0       | list bg90          | list-sql bg90      | task 3 list      |
| ---------- | -------------------------------- | ------------------ | ------------------ | ------------------ | ---------------- |
| owner      | 1.85 / 1.99 pass (100.1 / 54.0)  | 1.31 / 1.40 pass   | 1.70 / 2.16 FAIL   | 1.36 / 1.32 pass   | FAIL / FAIL      |
| member     | 1.21 / 1.41 pass (111.3 / 92.2)  | 0.87 / 0.76 pass   | 1.10 / 1.20 pass   | 0.80 / 0.89 pass   | pass / pass      |
| member-all | 1.21 / 1.43 pass (182.4 / 150.6) | 1.26 / 1.24 pass   | 1.29 / 1.45 pass   | 1.06 / 0.93 pass   | pass / pass      |
| guest      | 8.45 / 9.02 FAIL (94.7 / 11.2)   | 7.92 / 9.18 FAIL   | 7.92 / 8.61 FAIL   | 7.95 / 7.29 FAIL   | 11.1 / 11.3 FAIL |
| external   | 7.28 / 7.57 FAIL (90.3 / 12.4)   | 6.99 / 8.27 FAIL   | 7.77 / 8.65 FAIL   | 8.23 / 10.79 FAIL  | 10.8 / 9.7 FAIL  |
| link       | 20.69 / 18.41 FAIL (129.1 / 6.2) | 21.97 / 20.24 FAIL | 17.72 / 21.07 FAIL | 23.97 / 27.99 FAIL | 24.8 / 27.8 FAIL |
| agent      | 1.15 / 1.19 pass (105.6 / 91.5)  | 0.87 / 1.06 pass   | 1.08 / 1.04 pass   | 0.87 / 1.07 pass   | pass / pass      |

**The 3.1 target (≤ 2 ×) is not met** for the three small principals (guest, external, link; 7 to 24 times) in
both runs, and for the owner at bg90 on the p99 ratio (2.16). The owner's bg0 list now passes (1.85 / 1.99). The
small lists cannot reach 2 × with this statement: its bare run costs 57 to 123 ms, while their reference runs in
6 to 13 ms.

### What the numbers say

A page's time, split (bg0, scratch probe `.authz-sdd/S1-t3-split.ts`, median of 30 after 3 warm-ups, ms; planning,
execution and the class sets from one `EXPLAIN (ANALYZE)`). Compile before is the same probe on task 3's code,
run just before the change (`.authz-sdd/S1-t4-split-before-bg0.txt`); the rest is after
(`S1-t4-split-after3-bg0.txt`).

| principal  | compile before → after | app page | statement on the driver | planning | execution | class sets (classes)          |
| ---------- | ---------------------: | -------: | ----------------------: | -------: | --------: | ----------------------------- |
| owner      |            69.5 → 26.1 |     87.9 |                    58.3 |     19.5 |      36.5 | 23.6 (63), 3.8 (10)           |
| member     |            67.1 → 35.2 |     90.6 |                    60.8 |     20.1 |      34.4 | 20.8 (68), 7.5 (21)           |
| member-all |            69.5 → 25.8 |    121.9 |                    92.5 |     21.0 |      56.2 | 25.6 (100), 25.8 (100)        |
| guest      |            68.1 → 24.6 |     82.7 |                    57.5 |     12.3 |      24.2 | 15.5 (60), 2.9 (8)            |
| external   |            68.1 → 22.8 |     79.4 |                    54.5 |     12.6 |      27.2 | 18.8 (63), 2.5 (7)            |
| link       |            90.8 → 36.1 |    112.1 |                    80.8 |     23.1 |      38.5 | 12.6 (59), 14.4 (59), 1.4 (2) |
| agent      |            67.4 → 25.7 |     91.1 |                    62.7 |     16.0 |      39.3 | 25.9 (68), 6.5 (21)           |

- **The compile in Node fell from 67 to 91 ms to 23 to 36 ms.** authz-rbac's fragments now keep nested fragments
  whole and check only their own text, so a 280 to 380 KB term is built once instead of being copied and scanned
  once per level of nesting (8f52ade6b; the statements are the same, byte for byte). A CPU profile of the
  member's compile (27 ms under the profiler; `.authz-sdd/S1-t4/agg-after3.txt`): authz-rbac 13 ms (building the
  fragments 4 ms, flattening and converting the term for authz-orm 3 ms, grouping and junctions 2 ms), authz-orm's
  native fragment checks 6 ms, identifier quoting in `orm-postgres` 3 ms, garbage collection and the rest 4 ms.
- **The statement on the driver is now the larger part: 55 to 93 ms.** Planning 12 to 23 ms per statement, every
  time (no plan cache in the driver); execution 24 to 56 ms, most of it the class sets (the `thresholdDb` term's
  ~60 classes, member-all 100 + 100, link a second unpruned term with 59); the driver adds 15 to 25 ms (sending
  5,000 values, reading rows).
- **Closest to the limits:** the agent (104 to 105 ms at bg0) and the member's middle page (102 ms) miss by a few
  ms; member-all and link miss by a quarter, and their statements alone (81 to 93 ms) leave too little for a
  compile.
- **Other tenants' rows:** at bg90 pages took -4 to +37 % against bg0 in this run, more than task 3's -2 to
  +10 %; the reruns (10 to 17 %) point to load rather than the data.

What is left, in the order the profile points to:

1. Planning, 12 to 23 ms, and the driver's share: prepared statements in `orm-postgres` (named statements, generic
   plans; out of this lane), or S1 §5.2 (fewer repeated CASEs and bound lists: a smaller statement to plan, send
   and compile).
2. The class sets, 15 to 51 ms: S1 §5.3 (hoist the list-level reads: the subjects' assignments, the rules visible
   to the row type, the config rules' attribute reads), mainly for the unpruned `thresholdDb` term and
   member-all.
3. The compile, 23 to 36 ms: caching the compiled term per residual and model would remove most of it; authz-orm's
   native checks (6 ms) and identifier quoting (3 ms) are outside authz-rbac.
4. Per-row work is not worth chasing (4 to 10 ms).

Either 1 or 2 could bring the agent and the member under 100 ms on this machine; member-all and link need
both.

Costs of the class form (also in `BASELINE.md`): each term reads and sorts the whole file table once per statement,
rows other filters exclude included; SQLite keeps the per-row form; a stored rule Postgres cannot read now fails
every list of the model (design S1 r2 I5), not only lists that reach it.
Paths without id modes keep the per-row form.

## Release gate 7 for 3.0: absolute limits (G7)

The state before S1 (per-row rule terms).

Run 2026-10-09 on branch `authz/G7-gate7` (base `authz-v3-refactor` 9b11af9f7), code of a0f8fb173 (before the
jit check), `--filter=postgres.jit-off`, no background tenants. Limits (the human's option (b) of 2026-10-09,
plan §12 item 7): the 1,000-file list p50 ≤ 1.5 s; a 50-row page p50 ≤ 100 ms and p99 ≤ 250 ms; Postgres with
`jit = off`, with and without other tenants.

**Verdict: the 3.0 limits FAIL on the page.** Every page, first and middle, of every principal misses the 100 ms
p50 limit, by 2.3 to 21 times, and the 250 ms p99 limit (lowest p99 346 ms). The list limit holds for five
principals of six, the member's only by 1 % (1,485 ms); the owner's list missed it in this run (2,056 ms) on a
loaded machine, where L4b's run measured 849 ms.

Same environment as below, but the machine was heavily loaded (other lanes' suites on the same machine and
Postgres server): `CREATE DATABASE` took 2.5 s and the run took 1 h 48 min. The references are slower than in
L4b's run for the owner and members (owner `exists` p50 317 ms here, 128 ms there), and the owner's and member's
p99 show stalls of seconds. The small principals' numbers are steadier. Not measured: the run with
`L4B_BENCH_BACKGROUND=90`, and a quiet rerun of the owner and member lists. The page fails without other tenants
already, and the Postgres server was down when this was written.

Order: `updated_at DESC, id ASC`, 50 rows, through the ORM's `orderByDescending`/`orderBy`/`take`/`skip`; index
`canvas_file_recent (updated_at DESC, id)`. Every page was checked to be its slice of the exact list before
timing. p50 and p99 in ms, median of 3 repeats (lists 30 iterations, pages 100).

| principal  | rows | middle offset | page-first p50 |     p99 | page-middle p50 |     p99 | exists-page-first p50 |   p99 | list p50 |     p99 | list ≤ 1.5 s | page ≤ 100 / 250 ms |
| ---------- | ---: | ------------: | -------------: | ------: | --------------: | ------: | --------------------: | ----: | -------: | ------: | ------------ | ------------------- |
| owner      |  100 |            50 |         2057.5 | 11151.8 |          1856.8 | 14750.8 |                 135.9 | 316.7 |   2056.1 | 11595.1 | FAIL         | FAIL                |
| member     |  172 |           100 |         1043.9 |  6961.0 |          1229.5 |  2797.9 |                 118.0 | 417.9 |   1484.7 |  7934.3 | PASS         | FAIL                |
| member-all |  760 |           400 |          230.2 |   345.8 |           507.3 |   797.8 |                  19.0 |  30.8 |    779.2 |  1140.5 | PASS         | FAIL                |
| guest      |   38 |     0 (first) |          382.7 |   627.5 |           369.9 |   566.5 |                  15.4 |  26.3 |    359.9 |   508.7 | PASS         | FAIL                |
| external   |   22 |     0 (first) |          366.0 |   551.2 |           345.0 |   517.8 |                  17.0 |  31.4 |    372.2 |   497.1 | PASS         | FAIL                |
| link       |   19 |     0 (first) |          346.3 |   505.5 |           347.7 |   472.5 |                   9.3 |  13.1 |    340.0 |   510.9 | PASS         | FAIL                |

What the numbers say, load aside:

- A page costs about what the whole list costs when the principal sees few rows (guest, external, link: 19 to 38
  of 1,000). To find 50 rows it may list, the database tests every row, and each test runs the per-row rule chain
  (about 0.25 ms, see "Why it failed before S1"). Their pages took 345 to 383 ms p50 here (3.4 to 3.8 times the
  limit), their lists 340 to 372 ms; L4b measured the same lists at 394 to 523 ms. No page was measured on a quiet
  machine, but nothing suggested a quiet machine would bring these pages near 100 ms.
- Where the principal sees most rows (member-all, 760), the first page is cheaper than the list (230 ms against
  779 ms) but still over the limit; the middle page at offset 400 costs about two thirds of the list (if Postgres
  walks `canvas_file_recent`, it tests about 600 rows; the query plan was not checked).
- The plain `EXISTS` page stays under 100 ms for the four principals whose numbers the load spared.

G7 concluded that passing the page limit needs the set-based rewrite described under "Why it failed before S1"
(work the rules out once per scope node), not tuning: the cost was per row tested, and a page of a sparse list
tested every row. S1 made that rewrite; its results are at the top of this file.

## Release gate 7, now the 3.1 target: list ≤ 2 × the plain `EXISTS` (L4b)

Run 2026-10-09 on branch `authz/L4b-rules-sql`.

**Verdict: the 3.1 target (≤ 2 × the plain `EXISTS`, the r3 gate 7) FAILS** in every setting measured. With
`jit = off` (the setting a host needs, see below) the list takes 2.4 to 60 times the plain `EXISTS` (p50, all
runs), 0.2 to 1.2 s for 1,000 files; with the server default `jit = on` it takes 4 s to 100 s. Every list was
checked exact (the rows single checks allow) before it was timed, so the cost is that of the rule terms, not of
a wrong plan shape. Passing needs a different SQL shape (below); the index change of this task makes the lists
independent of how many other tenants share the authz tables, but does not change the verdict.

### Environment

Windows 11 (10.0.26200), Node 24.14.1, Intel i7-12700KF (20 threads); PostgreSQL 16.6 (Debian, Docker Desktop on
the same machine), server defaults: `jit` on, `jit_above_cost` 100000, `jit_inline_above_cost` and
`jit_optimize_above_cost` 500000, `work_mem` 4 MB, `shared_buffers` 128 MB; SQLite through `orm-sqlite`
(`:memory:`). The machine ran other work too (a Storybook dev server, Docker): repeated runs vary by up to ±40 %
(compare the two reference columns between runs); the ratios, not single numbers, carry the result.

Data (seed 7): 1,000 files in 50 projects of 10 orgs; 1,299 assignments, 350 stored rules (50 file restrictions,
300 branch thresholds), 101 rule subjects, 25 scope attribute rows. With `L4B_BENCH_BACKGROUND=90`: 12,773
assignments, 3,500 stored rules, 1,001 rule subjects, 250 attribute rows, the same 1,000 files. Indexes present:
`authz_assignment_scope`, `authz_assignment_uq`, `authz_rule_scope`, `authz_rule_subject_pkey`,
`authz_scope_attribute_pkey` (the migrations').

Rows per principal (list / reference): owner 100 / 100, member 172 / 181, member-all 760 / 800, guest 38 / 40,
external 22 / 43, link 19 / 20.

### Postgres, jit off, final code (08162ef29)

p50 and p99 in ms, median of 3 repeats of 30 iterations (5 warm-up). `list` = (a) through authz-orm's middleware,
`exists` = (b) the r2 v1 term compiled by authz-orm; `-sql` = the bare statements.

| principal  | op       |  a p50 | b p50 | a/b p50 |  a p99 | b p99 | a/b p99 | gate |
| ---------- | -------- | -----: | ----: | ------: | -----: | ----: | ------: | ---- |
| owner      | list     |  849.2 | 128.0 |    6.64 | 1067.6 | 179.3 |    5.95 | FAIL |
| owner      | list-sql |  644.7 | 104.1 |    6.19 |  864.0 | 155.0 |    5.57 | FAIL |
| member     | list     | 1183.4 | 228.9 |    5.17 | 2406.2 | 294.5 |    8.17 | FAIL |
| member     | list-sql |  652.8 | 200.8 |    3.25 |  918.5 | 307.1 |    2.99 | FAIL |
| member-all | list     |  751.3 | 237.9 |    3.16 | 1279.0 | 370.0 |    3.46 | FAIL |
| member-all | list-sql |  481.8 |  82.5 |    5.84 |  707.6 | 132.4 |    5.34 | FAIL |
| guest      | list     |  393.6 |  15.5 |   25.43 |  554.1 |  20.0 |   27.70 | FAIL |
| guest      | list-sql |  272.4 |  10.7 |   25.39 |  542.4 |  16.4 |   33.10 | FAIL |
| external   | list     |  523.2 |  24.4 |   21.42 |  784.6 |  40.9 |   19.19 | FAIL |
| external   | list-sql |  328.5 |  10.6 |   30.90 |  493.5 |  19.2 |   25.74 | FAIL |
| link       | list     |  522.4 |  16.9 |   30.95 |  809.9 |  47.7 |   16.97 | FAIL |
| link       | list-sql |  306.2 |  5.12 |   59.84 |  467.9 |  8.12 |   57.61 | FAIL |

The same before the index change (85436182f), an earlier and quieter run: ratios 2.41 to 47.98 (p50), 3.06 to
50.55 (p99), all FAIL (owner list 470.8 / 71.5 ms, member-all 1023.6 / 424.1, guest 518.8 / 27.8, link 400.2 / 8.34).

### Postgres, jit off, 90 background tenants

| principal  | op       | before: a p50 | b p50 |    a/b | after: a p50 | b p50 | a/b p50 | a/b p99 | gate |
| ---------- | -------- | ------------: | ----: | -----: | -----------: | ----: | ------: | ------: | ---- |
| owner      | list     |         955.9 |  88.1 |  10.85 |        489.6 |  82.3 |    5.95 |    4.45 | FAIL |
| owner      | list-sql |         920.5 |  92.8 |   9.92 |        340.0 |  65.1 |    5.22 |    5.94 | FAIL |
| member     | list     |        1207.2 | 160.8 |   7.51 |        527.0 | 150.9 |    3.49 |    2.54 | FAIL |
| member     | list-sql |        1147.7 | 161.9 |   7.09 |        396.0 | 124.6 |    3.18 |    3.25 | FAIL |
| member-all | list     |        3292.2 | 369.7 |   8.90 |        723.0 | 258.4 |    2.80 |    2.70 | FAIL |
| member-all | list-sql |        3673.5 | 341.6 |  10.75 |        491.8 | 146.5 |    3.36 |    2.95 | FAIL |
| guest      | list     |         939.8 |  22.6 |  41.55 |        505.2 |  21.0 |   24.07 |   13.76 | FAIL |
| guest      | list-sql |        1007.9 |  10.0 | 100.32 |        302.2 |  14.6 |   20.64 |   18.93 | FAIL |
| external   | list     |         796.7 |  20.1 |  39.73 |        359.0 |  21.9 |   16.41 |   15.05 | FAIL |
| external   | list-sql |         827.5 |  9.82 |  84.23 |        282.4 |  10.4 |   27.12 |   35.83 | FAIL |
| link       | list     |         860.4 |  15.3 |  56.24 |        441.0 |  15.6 |   28.22 |   25.39 | FAIL |
| link       | list-sql |         800.0 |  5.92 | 135.23 |        215.9 |  6.85 |   31.52 |   21.40 | FAIL |

EXPLAIN ANALYZE of the same statements, median of 5 after 2 warm-ups, execution in ms (planning: 16 to 37 ms for
a list, under 1 ms for the reference, the same before and after; scratch probe, not part of the bench). Without
background tenants two interleaved runs each:

| principal  | list bg0 before | list bg0 after | list bg90 before | list bg90 after | reference bg0 before / after | reference bg90 before / after |
| ---------- | --------------: | -------------: | ---------------: | --------------: | ---------------------------: | ----------------------------: |
| owner      |    343.1, 174.1 |   213.9, 224.4 |            594.8 |           227.5 |      46.6, 52.5 / 41.3, 56.7 |                   54.6 / 65.9 |
| member     |    275.8, 232.7 |   213.6, 263.4 |            804.1 |           249.6 |     78.3, 81.0 / 83.1, 100.4 |                 110.3 / 116.8 |
| member-all |    526.1, 431.1 |   400.6, 476.8 |           1967.8 |           629.3 |   207.3, 201.7 / 89.7, 107.5 |                 343.6 / 122.5 |
| guest      |    155.9, 164.1 |   180.0, 174.6 |            801.0 |           222.0 |          6.3, 6.4 / 6.1, 7.8 |                     8.1 / 9.3 |
| external   |    197.6, 159.9 |   188.2, 210.6 |            661.2 |           183.8 |         7.3, 7.1 / 10.1, 8.5 |                     8.0 / 8.6 |
| link       |    131.8, 173.4 |   153.2, 171.1 |            462.2 |           168.0 |          2.6, 5.2 / 3.0, 2.7 |                     4.2 / 9.7 |

Without background tenants the change is within the noise for the lists; with them it removes the growth (before:
2 to 4 times slower than without them; after: the same). The member-all reference got faster too: the v1 term reads
the path with the same blocks.

### Postgres, jit on (server default)

Before the index change (85436182f); 10 iterations, 1 warm-up, 1 repeat. JIT compiles the list statement on every
run (the guest plan costs about 400,000 for 1,000 rows, past `jit_above_cost`; the larger ones also pass the inline
and optimize thresholds).

| principal  | op       |    a p50 | b p50 | a/b p50 |    a p99 |  b p99 | a/b p99 | gate |
| ---------- | -------- | -------: | ----: | ------: | -------: | -----: | ------: | ---- |
| owner      | list     |   4015.3 |  56.7 |   70.81 |   4832.2 |  107.7 |   44.89 | FAIL |
| owner      | list-sql |   4802.1 |  56.8 |   84.48 |   5528.5 |   68.2 |   81.12 | FAIL |
| member     | list     |   5180.0 | 120.6 |   42.96 |   5832.7 |  150.3 |   38.80 | FAIL |
| member     | list-sql |   6167.9 | 150.7 |   40.92 |   6830.4 |  231.7 |   29.49 | FAIL |
| member-all | list     | 100035.5 | 302.9 |  330.29 | 196731.8 | 4621.0 |   42.57 | FAIL |
| member-all | list-sql |  92117.8 | 518.0 |  177.85 | 155611.8 |  697.1 |  223.24 | FAIL |
| guest      | list     |   4821.2 |  15.5 |  310.14 |   8052.8 |   18.0 |  448.62 | FAIL |
| guest      | list-sql |   3812.6 |  12.1 |  316.12 |   5965.7 |   14.0 |  427.13 | FAIL |
| external   | list     |   5460.3 |  16.7 |  327.00 |   7665.4 |   41.5 |  184.61 | FAIL |
| external   | list-sql |   5198.2 |  12.8 |  407.27 |   6441.0 |   19.0 |  339.32 | FAIL |
| link       | list     |  60976.6 |  14.2 | 4300.18 |  88992.0 |   15.6 | 5700.45 | FAIL |
| link       | list-sql |  89957.5 |  9.96 | 9035.68 | 141721.6 |   15.3 | 9254.02 | FAIL |

After the index change (08162ef29), guest only: list 5640.1 / 19.9 ms (283.88), p99 8210.3 / 27.8 (295.00); list-sql
6060.8 / 19.2 (315.29), p99 9768.7 / 25.6 (381.86): JIT still dominates.

### SQLite (informational)

Final code; 3 iterations, 1 warm-up, 1 repeat (each list takes seconds). The gate is a Postgres gate; these show what
SQLite pays for the same lists.

| principal  | op       |   a p50 | b p50 |  a/b p50 |   a p99 | b p99 |  a/b p99 |
| ---------- | -------- | ------: | ----: | -------: | ------: | ----: | -------: |
| owner      | list     | 10810.5 |  19.5 |   555.12 | 11423.8 |  22.4 |   508.90 |
| owner      | list-sql |  9911.9 |  5.07 |  1954.05 | 11098.1 |  6.08 |  1825.44 |
| member     | list     | 11737.3 |  29.0 |   405.24 | 14391.0 |  35.1 |   410.42 |
| member     | list-sql | 10577.4 |  7.35 |  1439.77 | 12207.2 |  8.87 |  1376.05 |
| member-all | list     | 14618.0 | 105.3 |   138.76 | 17343.9 | 142.9 |   121.37 |
| member-all | list-sql | 17331.5 |  22.2 |   780.42 | 20014.4 |  26.4 |   757.42 |
| guest      | list     |  9541.8 |  10.4 |   915.60 | 10452.8 |  14.4 |   725.05 |
| guest      | list-sql |  9442.4 |  2.74 |  3441.75 | 10067.6 |  2.94 |  3428.42 |
| external   | list     |  9672.5 |  12.1 |   796.70 | 11012.0 |  13.7 |   801.03 |
| external   | list-sql |  9070.1 |  3.53 |  2568.55 |  9860.8 |  4.29 |  2298.51 |
| link       | list     | 17124.9 |  7.40 |  2313.37 | 18109.0 |  15.0 |  1205.18 |
| link       | list-sql | 20748.8 |  1.87 | 11124.15 | 23382.7 |  2.08 | 11255.20 |

### Why it failed before S1 (EXPLAIN (ANALYZE, BUFFERS), guest, jit off)

The state of L4b's code. S1 replaced the per-row terms on Postgres (top of this file); SQLite keeps them.

- **Row by row.** The list is one correlated sub-select per term per file row. Per row, the route term works out
  a WITH chain: the subjects' assignments on the row's path (`authz_s0`), the stored rules on the path
  (`authz_dj` … `authz_dx`, `authz_dy`), the bound rules' scope attribute reads (`authz_gb`: for each attribute
  the config caps read, the org node's `exists` probe, the value, and the rows above and below its path), then
  `authz_gd`, `authz_s1`, `authz_s2` and the faults (`authz_dz`, `authz_dc`); about 0.25 ms per row against 9 µs
  for the reference's one index probe. The `{ db: true }` threshold term repeats the whole chain for every row the
  route term lets through (member-all: 760 rows at about 0.5 ms).
- **Statement size.** 325 to 396 KB of SQL with 8,273 to 9,110 bound values per list (235 SELECTs, two WITH
  chains). Planning takes 16 to 54 ms every time (the driver plans each statement afresh); for the small lists that
  alone is more than twice the whole reference.
- **Index use (fixed in 08162ef29).** The stored rules of a path were read by a sequential scan of `authz_rule`
  per row: Postgres equality in `COLLATE "C"` cannot use the default-collation index, and one arm of the path OR
  had no `scope_type` equality. With 10 times the authz rows the lists took 2 to 4 times longer; now the scan is a
  bitmap OR of `authz_rule_scope` probes and the time no longer grows with other tenants' rows.
- **JIT.** The estimated cost grows with the rows and the size of the predicate, so JIT compiles the statement on
  every list (seconds, up to 100 s when inlining and optimizing start).

What would pass: a set-based shape that works the rules out once per scope node (project, org) instead of once per
file row, e.g. the per-path parts as a derived table over the distinct `(project_id, org_id)` of the rows (or a
LATERAL keyed by the scope columns, which Postgres 14+ can memoize), one WITH chain shared by the route and
threshold terms, and the constants as a few array bindings so the statement shrinks (or a prepared statement so the
plan is reused). That is a redesign of `RbacRulesSql`'s term, with the exactness properties rerun, not a change
this task could make safely. (S1 did it, as classes of rows rather than scope nodes: see the top of this file.)

### Settings for a host

- **`jit = off` for the authz connection is required on Postgres**: `ALTER ROLE <app role> SET jit = off` (or
  `ALTER DATABASE <db> SET jit = off`). A high `jit_above_cost` instead would have to exceed the plans' cost,
  which grows with the rows listed (about 400 per row here), so it is no stable alternative.
- authz-orm enforces this: it runs `SHOW jit` once per Postgres connection and fails the boot (and every scoped
  query) with `AuthzConfigError` while jit is on, unless `authz.orm.allowJit` is true. `PGOPTIONS='-c jit=off'` in
  the process environment also works: node-postgres reads it as the connection's `options`.
- `SET LOCAL jit = off` around the list is **not possible through authz-orm**: its native compilers only add a
  WHERE fragment to the model's query, and its middleware neither owns the statement's connection nor opens a
  transaction (`PostgresOrmDriver` takes a pooled client per statement outside a transaction, so a `SET` from the
  middleware would land on another connection, and `SET LOCAL` needs the list's own transaction). The driver passes
  no connection `options` (`-c jit=off`) to `pg.Pool` either; only `search_path` is set per connection. An app
  that lists inside its own transaction may run `SET LOCAL jit = off` first; that is app code.
- SQLite lists with stored rules take seconds even for small tables (the row-correlated WITH tables are worked
  out again at each reference); use SQLite for tests and small data only.
