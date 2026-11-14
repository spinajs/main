# @spinajs/simulation

Deterministic simulation of the SpinaJS durable engines (scheduler, outbox relay, idempotency, workflow).
A seed fixes the virtual clock, every random choice and the order in which replicas run, so a failing seed
replays exactly. Private in 4.x; see `docs/simulation/README.md`.

    npm run sim -- --suite outbox --seed 42
    npm run sim -- --all --seeds 200 --out sim-reports
