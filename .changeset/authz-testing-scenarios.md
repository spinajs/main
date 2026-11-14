---
"@spinajs/authz-testing": minor
---

Scenario runner: `readScenario(path)` reads an OpenFGA `.fga.yaml` test file (model, tuples, `check` and `list_objects` assertions on relations) or a native `.authz.yaml` one (a policy IR, column values, assertions on permissions); `runScenario(scenario, engineFor)` runs every test on a fresh engine and returns the mismatches; `irScenarioEngine` runs them on the IR evaluator. The ReBAC model passes the same `.fga.yaml` file.
