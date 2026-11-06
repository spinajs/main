---
"@spinajs/compiler": minor
---

`spinajs doctor` checks every `sql` template against the app's models: SQL001 (parse), SQL002 (unknown table), SQL003 (undeclared column), SQL004 (ambiguous column), SQL005 (declared `sql<R>` row differs), SQL006 (INSERT VALUES length), SQL010 (dynamic, unchecked) and SQL011 (no dialect). The dialect per connection comes from `package.json#spinajs.orm.dialects` of the app, or from the configured driver with `--config`.
