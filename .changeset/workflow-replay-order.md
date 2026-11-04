---
"@spinajs/workflow": minor
---

A workflow replay hands recorded step results back in the order the original run received them (`Meta.order` on each step row), so concurrent branches that repeat a step name each get their own result again instead of trading them. A replay that waits for a recorded step the code no longer asks for fails with `NonDeterminismError` instead of hanging.
