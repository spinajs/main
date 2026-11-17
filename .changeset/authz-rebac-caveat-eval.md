---
"@spinajs/authz-rebac": minor
"@spinajs/authz-testing": patch
"@spinajs/authz-ir": patch
---

ReBAC evaluates conditional tuples (Bet 6 Z5b). A caveated tuple counts when its caveat holds for the request: the request `env` and principal with the tuple's context over them, through the domain's condition compiler. A caveat it cannot decide (a missing env value) makes the branch unknown. A check left unknown only by caveats is a no-permit with reason `caveat_unknown`, so it never vetoes another model; a `maxDepth` cut is still a model error. Votes that read env are not cached, and the type-level residual carries the caveat parameters it needs (`caveatInput`). `expand` lists conditional subjects and wraps arrows through conditional tuples. `listSubjects(object, name, type, { env })` returns `conditional` holders, and the `tuples.subjects` admin query takes `env` and marks them `conditional: true`. `rebacToIR` compiles caveats and conditional subject types, and the IR agreement test generates caveats. `voteTruth` of `@spinajs/authz-testing` reads a `caveat_unknown` no-permit as `unknown`. The IR evaluator of `@spinajs/authz-ir` ignores an `env.now` in a tuple's caveat context, as ReBAC does: the clock is the evaluation instant.
