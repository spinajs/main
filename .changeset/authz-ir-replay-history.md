---
"@spinajs/authz-ir": minor
---

Relationship state at an instant, for decision replay. `stateAt(t, key)` undoes a key's changes after `t` from its current state, and answers a gap instead of a state when the changelog cannot vouch for it: coverage that starts after `t` minus the ambiguity window, a change inside the window `[t - beforeMs, t + afterMs]`, changes whose before- and after-images do not link, or a current state that differs from the last logged change. Instants inside images compare at the stored precision (`sameImage`).

The evaluator treats a partial read (`TupleSourceGap`, thrown by a `TupleSource` with the subjects it could establish) as Kleene `unknown`: the known subjects still decide, otherwise the stored relation or tuple-to-userset is `unknown`, with the gap in the explain tree; a ceiling over resources whose ancestor walk is partial is `unknown` instead of `deny`. A `TupleSource` that never throws `TupleSourceGap` behaves as before. New: `readSubjects`, `coverageGap`.
