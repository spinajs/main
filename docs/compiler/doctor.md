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
| SOCK006 | warning | a `$data` pointer in a contract payload schema names no property, or an optional one: Ajv then skips the rule without an error |
| WF001 | error | two `@Workflow` classes declare the same name and version |
| WF002 | warning | a workflow waits for a signal with a `permission`, but no `SignalAuthorizer` other than `DenyAllSignalAuthorizer` is registered: every such signal is rejected |
| WF003 | info | a workflow has more than three registered versions; remove the ones no instance runs on |
| SQL001 | error | an `sql` template that does not parse in the dialect of its connection |
| SQL002 | error | an `sql` template reads a table no model maps |
| SQL003 | error / warning | an `sql` template reads a column no model declares: an error when the table's model is `columns: 'exhaustive'`, a warning on a partial model (the column may exist unmanaged) |
| SQL004 | error | an unqualified column that more than one table of the query has |
| SQL005 | error | the row declared as `sql<R>` differs from the row the query returns (names, types, nullability) |
| SQL006 | error | an INSERT whose VALUES row has more or fewer values than its column list |
| SQL010 | info | a dynamic `sql` statement (it interpolates a fragment or `sql.raw`), which is not checked |
| SQL011 | warning | a connection with `sql` templates has no dialect, or names one no installed driver declares; its templates are checked with the generic mysql grammar and driver-dependent columns are typed `unknown` |

The HTTP rules read the routes a controller inherits from its entry, as the runtime serves them. A report on an inherited route names the base (`AppUploads.create (inherited from @spinajs/upload:UploadController)`) and points at the subclass, the code the app can change. A subclass of a guard-less base, such as `UploadController`, fails HTTP002 unless the subclass has `@Access`, `@Policy`, `@AllowAnonymous` or `@Public`. HTTP001 skips a controller a subclass replaces with an unconditional `DI.register(Sub).as(Base)`, as the runtime mounts only the subclass.

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

### SOCK001-SOCK006 details

A contract id is the literal argument of `defineContract('<id>')`, kept as written across packages, else `<package>:<VARIABLE>`. The rules compare
handlers with the contract by derived schema structure: payloads as requests (the handler must accept what the
contract allows), results as responses (the handler must not return more than promised). A side whose schema is
missing or `x-explicit: 'partial'` is skipped.

A contract imported from another package is resolved through that package's manifest fragment (`package.json#spinajs.manifest`),
by package and export name. When the dependency has no fragment, or its fragment does not list the export, SOCK004 is
reported and the controller is unbound in the manifest. Fix it with an explicit id, `defineContract('<id>')`, or export
the contract from a package that ships a manifest fragment. At runtime `system.manifest.mode: require` refuses to boot
such a controller ("contract of X is not in the manifest").

### SQL001-SQL011 details

`spinajs build` records every `sql` template of `@spinajs/orm` (`sqlQueries` in the manifest). The SQL rules parse
each one with `node-sql-parser` in the dialect of its connection and check it against the models of the app manifest.

The dialect of a connection is set in the app's `package.json`:

```json
{ "spinajs": { "orm": { "dialects": { "default": "postgresql", "reports": "mysql" } } } }
```

Each ORM driver declares its dialect with `@SqlDialect` (`postgresql` for `@spinajs/orm-postgres`, `mysql`, `sqlite`,
`transactsql`), and `spinajs build` records it in the app manifest. A value is such a name or a driver token
(`orm-driver-postgres`). Without one, a connection takes the dialect of its driver with `--config`
(`db.Connections[].Driver`, through `db.Aliases` and `db.DefaultConnection`), else the only dialect installed; otherwise
SQL011 is reported once per connection. The dialect decides the grammar and how raw rows are typed: pg returns `COUNT`,
`bigint` and `numeric` as strings, mysql returns booleans and comparisons as `0`/`1`, sqlite returns dates as text.

Only DML is checked: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE` and `WITH`. A template that is not a whole
statement (`sql\`a = ${x}\`` built to be spliced in), and a DDL, `VALUES`, `MERGE`, `EXPLAIN` or `SHOW` template, is
recorded in the manifest but neither checked nor listed. Put `-- spinajs-sql-ignore` in a template to skip it.

A query passed to `executeSql(…, { connection })` resolves its tables against the models of that connection; when no
model is on it, or the template names no connection, against every model of the app whatever its connection.
Models mapped to one table contribute the union of their columns.

Known limits: identifier case is not modelled (names compare case-insensitively); raw rows are typed from the
column's family and the driver's profile, then from model properties of type `number`, `string`, `boolean`, `bigint`,
`Date` or string literal unions (anything else is `unknown`, since raw SQL bypasses value converters); a profile
describes the driver's default options, so an app that changes them (mysql `decimalNumbers`) declares its own; a
column of a CTE or subquery has no family, so `SUM`/`AVG` over it is `unknown`; when two installed drivers declare
one profile name, the one built last wins; for PostgreSQL and T-SQL the `?` rewrite skips `'…'`, `E'…'`, `$$…$$`,
quoted names and comments (and keeps the jsonb `?|` and `?&` operators) but not a tagged `$tag$…$tag$` string; and
the PostgreSQL grammar does not parse
`DELETE … USING`.

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
