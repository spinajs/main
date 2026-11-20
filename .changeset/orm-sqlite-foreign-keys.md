---
"@spinajs/orm-sqlite": minor
---

The `ForeignKeys: true` connection option turns `PRAGMA foreign_keys` on for the writer before anything uses it, on connect and on a health-check reconnect, and reads it back; a build that ignores the pragma, or a failing pragma, fails the connect and closes the writer. Default `false`.
