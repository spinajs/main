# Release gate 7: canvas `file:read` list and 50-row pages over 1,000 files (results)

How the bench works and how to run it: `BASELINE.md`.

## Release gate 7 for 3.0 after S1 (class-wise rule terms)

Run 2026-10-10 on branch `authz/S1-set-based-sql` (base `authz-v3-refactor` fb17360ea, A4 merged), code of
eb90efd3c: the rule list terms worked out once per class of rows (6a11bef83, 986552ae1), route pruning and
attribute lookups as columns (6c24d7b3e), and the agent principal in the bench. `--filter=postgres.jit-off`, once
without and once with `L4B_BENCH_BACKGROUND=90`. Limits as in G7 (plan §12 item 7): list p50 ≤ 1.5 s; a 50-row
page p50 ≤ 100 ms and p99 ≤ 250 ms.

**Verdict: the 3.0 limits still FAIL, on the page p50.**

| limit             | bg0                                                                | bg90                           |
| ----------------- | ------------------------------------------------------------------ | ------------------------------ |
| list p50 ≤ 1.5 s  | PASS, 7 of 7 (124 to 211 ms)                                       | PASS, 7 of 7 (132 to 225 ms)   |
| page p50 ≤ 100 ms | FAIL, 14 of 14 (123 to 182 ms)                                     | FAIL, 14 of 14 (132 to 184 ms) |
| page p99 ≤ 250 ms | PASS 12 of 14; FAIL member-all and link middle pages (264, 279 ms) | PASS, 14 of 14 (177 to 243 ms) |

Against G7's run every list and page p50 drops by 1.4 to 16 times, and the p99 by up to 89 times. Other tenants'
rows change little: at p50, bg90 is within -2 to +10 % of bg0. A page now costs about what its list costs, 120 to
185 ms, and more than half of that goes to compiling the statement in Node before it reaches Postgres (see "What
the numbers say").

### Environment

Windows 11 (10.0.26200), Node 24.14.1, Intel i7-12700KF (20 threads); PostgreSQL 16.6 (Debian, Docker Desktop on
the same machine), `work_mem` 4 MB, `shared_buffers` 128 MB, the bench database with `jit = off`. Data (seed 7):
as in L4b (1,299 assignments, 350 stored rules, 25 attribute rows; ×10 with 90 background tenants), 1,000 files.

Load: other lanes' processes kept the CPU 30 to 50 % busy; the bg0 run took 17 min, the bg90 run 18 min (G7's run
took 1 h 48 min). The first bg90 try stopped at its first scenario on `connect ETIMEDOUT` to the shared Postgres
server (load; nothing timed); the rerun went through without an error. No run shows second-long stalls (largest
p99 279 ms), so no principal was rerun. Outputs: `.authz-sdd/S1-bench-bg0.txt`, `S1-bench-bg90.txt`.

Rows per principal (list / reference): owner 100 / 100, member 172 / 181, member-all 760 / 800, guest 38 / 40,
external 22 / 43, link 19 / 20; the agent lists 95. Every list was checked against 1,000 single checks, and every
page against its slice of the list, before it was timed.

### The 3.0 limits, no background tenants (bg0)

p50 and p99 in ms, median of 3 repeats (lists 30 iterations, pages 100).

| principal  | rows | middle offset | list p50 | page-first p50 |   p99 | page-middle p50 |   p99 | list ≤ 1.5 s | page ≤ 100 / 250 ms |
| ---------- | ---: | ------------: | -------: | -------------: | ----: | --------------: | ----: | ------------ | ------------------- |
| owner      |  100 |            50 |    139.7 |          129.6 | 190.9 |           126.4 | 164.9 | PASS         | FAIL (p50)          |
| member     |  172 |           100 |    140.1 |          131.0 | 181.6 |           130.8 | 176.7 | PASS         | FAIL (p50)          |
| member-all |  760 |           400 |    211.4 |          159.2 | 213.4 |           170.0 | 263.6 | PASS         | FAIL (p50, p99)     |
| guest      |   38 |     0 (first) |    123.9 |          136.6 | 204.8 |           138.3 | 210.8 | PASS         | FAIL (p50)          |
| external   |   22 |     0 (first) |    126.2 |          126.0 | 169.8 |           122.9 | 164.2 | PASS         | FAIL (p50)          |
| link       |   19 |     0 (first) |    172.0 |          172.5 | 233.9 |           181.9 | 279.1 | PASS         | FAIL (p50, p99)     |
| agent      |   95 |            50 |    139.5 |          135.2 | 183.2 |           136.5 | 186.6 | PASS         | FAIL (p50)          |

### The 3.0 limits, 90 background tenants (bg90)

| principal  | list p50 | page-first p50 |   p99 | page-middle p50 |   p99 | list ≤ 1.5 s | page ≤ 100 / 250 ms |
| ---------- | -------: | -------------: | ----: | --------------: | ----: | ------------ | ------------------- |
| owner      |    146.4 |          134.6 | 184.4 |           135.4 | 185.8 | PASS         | FAIL (p50)          |
| member     |    152.8 |          141.9 | 182.8 |           143.6 | 189.5 | PASS         | FAIL (p50)          |
| member-all |    224.8 |          170.0 | 227.9 |           169.9 | 231.4 | PASS         | FAIL (p50)          |
| guest      |    131.8 |          133.6 | 177.1 |           132.5 | 176.7 | PASS         | FAIL (p50)          |
| external   |    136.2 |          133.2 | 179.8 |           132.0 | 183.0 | PASS         | FAIL (p50)          |
| link       |    181.3 |          184.1 | 243.2 |           182.9 | 239.7 | PASS         | FAIL (p50)          |
| agent      |    154.0 |          145.7 | 193.3 |           149.1 | 203.8 | PASS         | FAIL (p50)          |

### Before → after (bg0, against G7)

G7's run (below) was on a heavily loaded machine; L4b measured the same lists at 394 to 1,183 ms on a quieter one.
The agent is new in this run.

| principal  | list p50 before → after | page-first p50 / p99 before → after | page-middle p50 / p99 before → after |
| ---------- | ----------------------: | ----------------------------------: | -----------------------------------: |
| owner      |          2056.1 → 139.7 |    2057.5 / 11151.8 → 129.6 / 190.9 |     1856.8 / 14750.8 → 126.4 / 164.9 |
| member     |          1484.7 → 140.1 |     1043.9 / 6961.0 → 131.0 / 181.6 |      1229.5 / 2797.9 → 130.8 / 176.7 |
| member-all |           779.2 → 211.4 |       230.2 / 345.8 → 159.2 / 213.4 |        507.3 / 797.8 → 170.0 / 263.6 |
| guest      |           359.9 → 123.9 |       382.7 / 627.5 → 136.6 / 204.8 |        369.9 / 566.5 → 138.3 / 210.8 |
| external   |           372.2 → 126.2 |       366.0 / 551.2 → 126.0 / 169.8 |        345.0 / 517.8 → 122.9 / 164.2 |
| link       |           340.0 → 172.0 |       346.3 / 505.5 → 172.5 / 233.9 |        347.7 / 472.5 → 181.9 / 279.1 |

### The 3.1 target: list ≤ 2 × the plain `EXISTS`

`list` = (a) through authz-orm's middleware, `exists` = (b) the r2 v1 term; `-sql` = the bare statements. p50 ratio
/ p99 ratio; a row passes at ≤ 2 for both.

| principal  | list bg0 (a / b ms)               | list-sql bg0       | list bg90          | list-sql bg90      |
| ---------- | --------------------------------- | ------------------ | ------------------ | ------------------ |
| owner      | 2.73 / 3.17 FAIL (139.7 / 51.1)   | 1.33 / 1.52 pass   | 2.30 / 2.94 FAIL   | 1.23 / 1.16 pass   |
| member     | 1.59 / 1.65 pass (140.1 / 88.0)   | 0.79 / 0.88 pass   | 1.38 / 1.34 pass   | 0.75 / 0.89 pass   |
| member-all | 1.66 / 1.65 pass (211.4 / 127.3)  | 1.24 / 1.44 pass   | 1.48 / 1.46 pass   | 1.12 / 1.29 pass   |
| guest      | 11.12 / 11.77 FAIL (123.9 / 11.1) | 7.07 / 6.60 FAIL   | 11.30 / 11.20 FAIL | 8.21 / 8.47 FAIL   |
| external   | 10.80 / 12.11 FAIL (126.2 / 11.7) | 6.91 / 8.29 FAIL   | 9.73 / 9.50 FAIL   | 7.95 / 8.14 FAIL   |
| link       | 24.77 / 24.81 FAIL (172.0 / 6.95) | 22.67 / 27.04 FAIL | 27.84 / 25.47 FAIL | 19.69 / 20.17 FAIL |
| agent      | 1.58 / 1.44 pass (139.5 / 88.0)   | 0.84 / 0.96 pass   | 1.38 / 1.50 pass   | 0.80 / 0.90 pass   |

**Verdict: the 3.1 target still FAILS** for the owner list and for the three small principals (guest, external,
link; 6.9 to 28 times), in both runs. It passes where the plain `EXISTS` is itself slow (member, member-all,
agent: 88 to 152 ms). The bare list statement costs 54 to 101 ms whatever the list (planning, the class sets, the
driver) and the compile adds 67 to 95 ms (below), while the small principals' reference runs in 3.5 to 14 ms. The
small lists cannot reach 2 × with this statement; they need a cheaper compile (authz-rbac) and prepared
statements in `orm-postgres` (a driver change, out of this lane), and likely the S1 design's §5.2 and §5.3 on top.

### What the numbers say

A page's time, split (bg0, scratch probe `.authz-sdd/S1-t3-split.ts`, median of 30 after 3 warm-ups, ms; planning,
execution and the class sets from one `EXPLAIN (ANALYZE)`; `.authz-sdd/S1-t3-split-bg0-3.txt`):

| principal  | app page | compile in Node | statement on the driver | planning | execution | class sets (classes)          |
| ---------- | -------: | --------------: | ----------------------: | -------: | --------: | ----------------------------- |
| owner      |    130.5 |            69.6 |                    62.5 |     14.2 |      27.2 | 17.6 (63), 3.1 (10)           |
| member     |    135.6 |            74.4 |                    63.0 |     12.6 |      27.1 | 17.1 (68), 5.9 (21)           |
| member-all |    163.1 |            71.1 |                    89.6 |     20.3 |      74.1 | 38.8 (100), 30.1 (100)        |
| guest      |    123.7 |            66.9 |                    54.7 |     12.6 |      24.3 | 14.8 (60), 3.0 (8)            |
| external   |    121.2 |            68.4 |                    57.7 |     13.9 |      28.4 | 18.5 (63), 2.3 (7)            |
| link       |    175.4 |            94.9 |                    82.4 |     19.7 |      37.1 | 12.9 (59), 12.8 (59), 1.4 (2) |
| agent      |    136.1 |            71.3 |                    62.7 |     15.3 |      31.5 | 18.5 (68), 6.2 (21)           |

- **Compile in Node is now the largest part: 67 to 95 ms of every page and list.** authz-orm's middleware
  compiles the residual into one 280 to 380 KB statement with 5,000 to 6,600 bound values on every query (the
  `filter` itself comes from the cache, under 0.1 ms). A CPU profile of the member's compile (79 ms) puts 60 ms in
  authz-rbac's fragment layer (`compile/sql.ts`): `rsql` copies every nested fragment's parts into the new one and
  `assertText` scans all of its text again at each level, so the same text is copied and checked once per level of
  nesting (`assertText` alone: 25 ms). authz-orm (6 ms), identifier quoting in `orm-postgres` (4 ms) and garbage
  collection (4 ms) take most of the rest (`.authz-sdd/S1-t3-split/compile-member-agg.txt`). Even if the SQL were
  free, the compile alone would use two thirds of the 100 ms page budget.
- **Planning: 12 to 20 ms per statement**, every time (no plan cache in the driver).
- **Execution: 24 to 74 ms, most of it the class sets.** Postgres works each set out once per statement, at 0.2
  to 0.4 ms per class. The stored rules' threshold term (`thresholdDb`, never pruned) keeps about 60 classes for
  every principal (member-all 100); the pruned route term 2 to 21 (member-all 100; link has a second unpruned term
  with 59). The per-row part (hash probes of the key, the agent's ABAC leaves) is the rest, 4 to 10 ms. The driver
  adds about 15 to 25 ms on top of planning and execution (sending 5,000 values, reading rows).
- **The agent's ABAC leaves cost little:** its statement is 12 KB and 250 values longer than the member's, its
  execution within a few ms of the member's, and its pages 4 to 6 ms slower (bg0 and bg90).
- **Closest to the limits:** external (page p50 123 to 133 ms), owner and guest (126 to 138 ms) miss the p50 by a
  quarter to a third; member-all and link miss it by 60 to 85 % and are the ones near or over the p99 (231 to 279
  ms for their middle pages). The class form reads the authz tables by index, so other tenants' rows cost little.

What is left, in the order the profile points to:

1. The compile in Node, which neither §5.2 nor §5.3 of the S1 design (`.authz-sdd/S1-design.md`) covers: check
   each fragment's own text once and keep nested fragments as parts instead of copying them at every level; or
   cache the compiled term per residual and model. The fragment layer takes up to 60 ms of every list and page
   today (an estimate from the profile; the gain is not measured).
2. Planning, 12 to 20 ms: prepared statements in `orm-postgres` (named statements, generic plans; out of this
   lane), or S1 §5.2 (fewer repeated CASEs and bound lists, so a smaller statement to plan, send and compile).
3. The class sets, 15 to 70 ms: S1 §5.3 (hoist the list-level reads: the subjects' assignments, the rules visible
   to the row type, the config rules' attribute reads, so each class reads pre-filtered tables), mainly for the
   unpruned `thresholdDb` term's ~60 classes and member-all's 200.
4. Per-row work is no longer worth chasing (4 to 10 ms).

No single item brings a page under 100 ms p50 on this machine: 1 is needed, and 2 or 3 on top of it.

Costs of the class form (also in `BASELINE.md`): each term reads and sorts the whole file table once per statement,
rows other filters exclude included; SQLite keeps the per-row form; a stored rule Postgres cannot read now fails
every list of the model (design S1 r2 I5), not only lists that reach it.

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
