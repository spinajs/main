# spinajs doctor

`spinajs doctor` reads `app.manifest.json` (written by `spinajs build`) and reports problems that would
otherwise surface as a 500 at runtime or as a silent misconfiguration.

```bash
spinajs build
spinajs doctor                       # text, fails on errors
spinajs doctor --config              # also checks system.dirs and conditional registrations against the loaded configuration
spinajs doctor --format github       # GitHub Actions annotations
spinajs doctor --fail-on warning     # exit 1 on warnings too
spinajs doctor --manifest dist/app.manifest.json
```

## Rules

| Code | Severity | What it checks |
|---|---|---|
| DI001 | error | an injected token nothing registers |
| DI002 | error / warning | a dependency cycle between services (warning when an `optional` or `@LazyInject` edge breaks it) |
| DI003 | error / warning | an asynchronous service injected into a synchronous one, or `DI.resolve()` of an asynchronous service without `await` |
| HTTP001 | error | two routes with the same method and path, compared as Express does: case-insensitive, parameter names and trailing slashes ignored (`/users/:id` and `/Users/:userId` clash) |
| HTTP002 | error | a route with no `@Access`, `@Policy`, `@AllowAnonymous` or `@Public` on it or on its class |
| HTTP006 | warning | a route marked `@Public` that also has `@Access` or `@Policy` on it or on its class, or a controller marked `@Public` with a class-level one: the guard still runs, so the marker is wrong |
| HTTP003 | warning | a route answering at a path with `//`: a leading slash in the route path (`@Get('/x')` under `users` is `/users//x`) or an outer slash in `@BasePath` is kept as written. `@BasePath('/')` + `@Get('/')` is not reported: it answers at `/` |
| HTTP004 | warning | a route that an earlier parameterised route of the same controller and method shadows: `@Get(':id')` declared before `@Get('slash')` takes `/users/slash`. An earlier GET route also takes a later HEAD route it matches, the same path included, since Express answers HEAD with GET. Only routes of one controller are compared: across controllers the order is the DI registration order, which the manifest does not record |
| HTTP005 | warning | a whole-body `@Body() x: T` or `@AsModel() x: T` where `T` has a property `x`: a body carrying `x` binds `body.x` instead of the whole body |
| CFG001 | warning | a configuration path read in code whose module has no schema |
| CFG002 | error | a `system.dirs.*` entry that does not exist (`--config`) |
| CFG003 | info / warning | a registration whose config condition is unmet (`--config`), or one the compiler could not decide |
| BLD001 | error | a dependency fragment older than its build output, or missing |
| ORM001 | warning | a model loaded from the database by `@FromModel` (kind `FromDbModel`) that is not an `@AccessResource`. `@AsModel` (`AsDbModel`) builds the model from the request and is not reported |
| SCH003 | warning | an explicit `@Schema` that differs structurally from the schema derived from its class |
| SOCK001 | error | a socket controller bound to a contract (`@SocketController(prefix, { contract })`) has no `@Command` or `@OnEvent` for a name the contract declares, or the bound contract is not in the manifest |
| SOCK002 | warning | a handler payload that accepts less than the contract lets a client send |
| SOCK003 | warning | a handler result that returns more than the contract promises |
| SOCK004 | warning | the contract named in `@SocketController(prefix, { contract })` cannot be resolved: it is not a `defineContract()` variable of this package and no dependency with a manifest fragment exports it, so the controller is left unbound |
| SOCK005 | error | two `defineContract` declarations share one contract id |

### DI002 details

The rule reports one diagnostic per strongly connected component of the injection graph, and the message
carries a real cycle path found by breadth-first search: `Dependency cycle: A -> B -> A`.

- When a cycle survives with only hard edges (constructor injections and plain property injections), each
  strongly connected component of the hard graph is an error.
- When the cycle exists only because an `optional` or `@LazyInject` property closes it, the component is a
  single warning.

### CFG001 details

A config path is covered when it equals a declared module or starts with `<module>.`. Modules may be dotted
(`authn.oidc`), so the match is by prefix on whole segments, not on the first segment alone. The `system` and
`app` roots are filled by the configuration itself and are never reported. Each distinct path is reported once.

### SOCK001-SOCK005 details

A contract id is the literal argument of `defineContract('<id>')`, else `<package>:<VARIABLE>`. The rules compare
handlers with the contract by derived schema structure: payloads as requests (the handler must accept what the
contract allows), results as responses (the handler must not return more than promised). A side whose schema is
missing or `x-explicit: 'partial'` is skipped.

A contract imported from another package is resolved through that package's manifest fragment (`package.json#spinajs.manifest`),
by package and export name. When the dependency has no fragment, or its fragment does not list the export, SOCK004 is
reported and the controller is unbound in the manifest. Fix it with an explicit id, `defineContract('<id>')`, or export
the contract from a package that ships a manifest fragment. At runtime `system.manifest.mode: require` refuses to boot
such a controller ("contract of X is not in the manifest").

## Output formats

`--format` selects one of three renderings; `runDoctor` sorts diagnostics by severity, then file, line and code.

- `text` (default): one aligned line per diagnostic, then a summary line such as
  `2 error(s), 1 warning(s), 1 info`. The location column is blank for diagnostics without a source.
- `json`: a single line, `{"diagnostics":[...],"summary":{"error":0,"warning":0,"info":0}}`.
- `github`: workflow annotations, `::error file=<file>,line=<line>,col=<col>,title=<code>::<message>`.
  `warning` stays `::warning`, `info` becomes `::notice`; without a source the `file=` part is omitted.
  Special characters are escaped as GitHub requires (`%`, CR and LF in messages; also `:` and `,` in `file` and `title`).

## Exit code

`0` when nothing reaches the `--fail-on` severity (`error` by default), otherwise `1`. The command never
exits the process itself; the CLI entry does.

## Writing a rule

A rule is `{ code, describe, run(manifest, ctx) }` and must be pure: fs, env and config come through
`DoctorContext`. Add it to `DEFAULT_RULES` in `packages/compiler/src/doctor/rules/index.ts` and a fixture
test under `packages/compiler/test/doctor/`.
