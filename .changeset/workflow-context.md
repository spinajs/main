---
"@spinajs/workflow": minor
---

The workflow context journals `ctx.step` results under `step:<name>#<occurrence>`, replays them, fails loudly with `NonDeterminismError` when the code diverges from the journal, and runs `transactional` steps in one transaction with their journal row.
