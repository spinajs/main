---
"@spinajs/compiler": minor
---

`spinajs doctor` checks the access of every entry point in the manifest `authz` section:

- `AUTHZ003` (error): a socket command or event with no `@SocketAccess` or `@SocketPolicy` on it or on its class, which the server denies (`no_policy`); a warning when `--config` reads `http.socket.access.default: 'allow'`.
- `AUTHZ004` (warning): a queue handler of the app with no `@Job({ access })` and no `@SystemTask(reason)`; `runAs: 'system'` alone does not count. An event handler can only carry `@SystemTask` on its event class.
- `AUTHZ009` (warning): a schedule or CLI command of the app, or a `runAs: 'system'` job with `access`, with no `@SystemTask(reason)`.
- `AUTHZ005` (warning, `--config`): a checked permission of a type the catalogue knows that is neither in `authz.permissions` (root or a domain) nor a model permission.
- `AUTHZ007` (warning): a literal resource extractor that yields a type its permission is not checked on (the permission's resource, or its configured `types`), or `fromModel` of a model that is no access resource.
- `AUTHZ008` (warning, `--config`): a route that checks a permission declared with `fields: true` and returns every field.

AUTHZ004, AUTHZ005, AUTHZ007, AUTHZ008 and AUTHZ009 report the app's own entry points only. A `// spinajs-authz-ignore AUTHZxxx: <reason>` comment on the entry's line, or on the line above, silences the finding.
