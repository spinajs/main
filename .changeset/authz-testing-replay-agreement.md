---
"@spinajs/authz-testing": minor
---

`replayAgreement({ fixture, runs, captureInputs })`, the replay conformance property (P4): over random scenarios a fixture opens on a real stack, every decision the engine logged replays `faithful` after the writes that follow it, with the replayed outcome equal to the recorded one and the evidence `inputs-hash` when inputs are captured, `outcome` when not. `AUTHZ_REPLAY_AGREEMENT_RUNS` sets the default number of runs (200). A failure names the record and its replay report; fast-check adds the scenario and the seed. `replayDisagreement(record, report, captureInputs)` is the check of one record.
