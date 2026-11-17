# Simulation

`@spinajs/simulation` runs the loop-driven engines under a seeded scheduler. A seed fixes three things:

- **Time:** `SimClock` is the only `Clock` in the app. Timers fire only when the harness moves time, one at a time.
- **Randomness:** `SimRandom` (xoshiro128**, seeded through splitmix32) makes every random choice, both the harness's and the suites'. Fault rules draw from a second stream derived from the seed, so editing the rules does not reshuffle the harness.
- **Order:** exactly one piece of replica code runs at a time: a tick, a resumed pause, or the work one timer started.

## Replicas

A replica is a name plus an incarnation. The harness runs each tick inside an `AsyncLocalStorage` context that
names the replica. Timers, fault points and database statements read that context. A crash kills the incarnation:
its timers are dropped, its statements are rejected, and its pending COMMIT becomes a ROLLBACK. A restart
creates a new incarnation, and engines register it under the replica id `<name>.<incarnation>`.

All replicas share one sqlite file (`os.tmpdir()/spinajs-sim-<seed>-<random>/sim.sqlite`) through one driver,
whose handle runs statements one at a time in the order they were issued. A dead incarnation cannot begin a
transaction, and a transaction whose COMMIT became a ROLLBACK rejects with `SimCrash`. The file is deleted
when a seed passes. When a seed fails, the file is kept and the report and summary line name it, for the first
20 failing seeds of a process (`SIM_KEEP_DBS` changes the limit).

A suite that passes `template` to `boot()` gets a copy of the database as it was right after the first boot of
that template and the same aliases, so the boot itself must not write rows.

## Faults

Production code calls `FaultInjector.point(name)` at the points listed in `FaultPointName`. Outside a simulation
that is `NoFaults`, a no-op. A rule fires `always`, with a `probability`, or on the `nth` call. Its effect is one of:

- `crash`: the replica dies at that point.
- `delay`: the replica is frozen for `delayMs`, like a GC pause that lets its leases expire. Inside a database
  transaction the pause is deferred until the outermost transaction has ended, because a frozen transaction would
  hold the only sqlite writer; a transactional step gets no mid-step pause.
- `duplicate`: the suite delivers the last message a second time.

## Running

    npm run sim -- --suite <name> --seed <n>               # replay one seed
    npm run sim -- --suite <name> --seeds 8 --out sim-reports   # what each CI leg runs
    npm test -w @spinajs/simulation                        # 3 smoke seeds per suite plus a replay check; SIM_SEEDS=50 for more

A failing seed prints its report, which includes the replay command, and exits with 1. `--out` is resolved
against the directory `npm run sim` was started in. A seed whose database work never settles fails as
`stuck:database`.

Replicas interleave only between settle points, never inside one `tickOnce()`, so a compare-and-set guard that
is missing between a read and the write that depends on it is not found by the simulation.

## Suites

| Suite | Actors | Faults | Invariants |
|---|---|---|---|
| `scheduler` | 3 scheduler replicas ticking one 10 s schedule whose runs sleep 1–21 s and sometimes pause past the lease | crash or 35 s delay at `scheduler.lease-renew`, pause up to 90 s | each occurrence fired once; no finished outcome rewritten and no attempt handed to another owner (sqlite triggers log every such write), every effect under the lease holder; finished runs agree with their attempts; no run left unfinished; at least one run succeeded |
| `workflow` | 3 engine replicas, a signal sender, up to 8 order sagas (reserve → two-branch pick/pack fan-out → sleep → approval → charge → ship, 30 % told to fail) | crash at `workflow.after-step-fn`, `workflow.before-journal` and `workflow.after-journal`; 35 s delay after a step body and before a journal write (a stale owner's late write, refused by the epoch fence); extra signals; engine pause up to 90 s. Lease renewal is not exercised: `workflow.lease-renew` is never reached, since a paused replica's heartbeat does not fire and after the thaw the lease is already marked lost | step results never overwritten; every journal row holds the key its branch and call number must hold, and each fan-out row its own branch's result; no instance ends failed; compensations newest first, each with an effect (at least once); transactional effects match the journal exactly; one signal per wait, consumed with its journal row; every instance terminal, completed or compensated as its input and approval say |
