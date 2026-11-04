# @spinajs/client

Typed HTTP client for SpinaJS applications.

```ts
import { createClient, ProblemError } from '@spinajs/client/runtime';

const client = createClient<{ users: Users }>(definition, {
  baseUrl: 'https://api.example.com',
  headers: async () => ({ authorization: `Bearer ${await token()}` }),
  onProblem: (p) => console.warn(p.title),
});

try {
  await client.users.get(7);
} catch (e) {
  if (e instanceof ProblemError) console.error(e.status, e.problem.title);
}
```

## Options

`createClient(definition, options)` and the generated `createAppClient(options)` take the same `ClientOptions`:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `string` | required | Prefix of every request. Trailing slashes are removed. `http.controllers.route.prefix` is not added for you: include it here. |
| `fetch` | `typeof fetch` | `globalThis.fetch`, looked up on every call | Any fetch-compatible function: a test double, `undici`, a wrapper that adds tracing or retries. |
| `headers` | `() => Record<string, string> \| Promise<Record<string, string>>` | none | Called before every request, so a token can be read fresh. Names are lower-cased; a header argument of the route replaces an option header of the same name. |
| `credentials` | `RequestCredentials` | not set | Passed to `fetch`. In a browser, `include` sends the cookies the browser holds for the API origin. |
| `onProblem` | `(problem: ProblemDetails) => void` | none | Called with the problem document of a non-2xx reply, just before `ProblemError` is thrown. For logging or a global 401 handler; it does not swallow the error. |

Every request sends `accept: application/json, application/problem+json`. A 2xx reply is parsed as JSON when its `content-type` contains `json`, else returned as text.

`ProblemError` has `status` (the HTTP status), `problem` (`ProblemDetails`: `type`, `title`, `status`, optional `detail`, `instance`, `code`, `errors`) and a message of the form `404 Not Found: no such user`. `ProblemDetails` is a structural copy of the type in `@spinajs/http`, so a browser bundle does not need the server package.

## Route definitions

A route definition lists how each positional argument travels in `args`, one entry per argument: `{ in, name?, shape, multiple? }`, the manifest's `wire` binding of the route parameter.

| `shape` | Sent as |
| --- | --- |
| `value` | the argument as one string under `name`, in the query, a `{name}` path segment, a header or a cookie |
| `json` | `JSON.stringify(argument)` under `name` |
| `whole` | the argument's own keys: flat query keys, path segments, headers or form parts; in the body, the argument is the body |
| `field` | `{ [name]: argument }`, merged with the other `field` arguments into one JSON body |

A `multipart` argument is a form part (a `Blob` or `File` is sent as a file); with `multiple`, each array item is one part under `name`. A `whole` multipart argument (`@Form()`) sends its keys as form fields, nested objects and arrays as `a[b]` and `a[0]` keys, because the server reads them back with `qs` (which turns an array of more than 20 items into an object). A body argument cannot travel with multipart arguments: the server reads no body from a multipart request, so the runtime throws `TypeError` for that combination. An `undefined` or `null` argument sends nothing, except a missing path argument, which throws `TypeError`.

A `whole` body argument that is a `Blob` is sent as is; anything else is JSON. `@RawBody()` and `@FromXml()` arguments therefore arrive as JSON unless you pass a `Blob` holding the exact bytes or the XML text.

The route `path` is a template: `{name}` takes one segment, `{*name}` an array of segments joined with `/`, `[...]` is an optional group left out when a placeholder inside it has no value, and `\` escapes the next character. Each segment is percent-encoded. A segment value of `''`, `.` or `..` throws `TypeError` before any request is made, because URL parsing would resolve it into a different path (`/users/../avatar` is `/avatar`).

Header arguments and the names and values from `options.headers` must be valid HTTP: a CR, LF or a character beyond Latin-1 throws `TypeError` (encode such values yourself). Header names are lower-cased, so an argument header replaces an option header of the same name. Cookie arguments go into the `Cookie` header, which browsers drop from `fetch` without an error: they work from Node and other server runtimes only. In a browser, set `credentials: 'include'` and let the browser send its own cookies.

A reply that is not 2xx rejects with `ProblemError`. Its `problem` holds only the RFC 9457 members (`type`, `title`, `status`, `detail`, `instance`) and the `code` and `errors` extensions the server declares, each only when it has the right type; anything else in the body, such as `stack`, is dropped. Missing members default to `about:blank`, the status text and the status code. A body that is not JSON, or does not parse, becomes the `detail`.

Query strings are flat, as Express 5's default `simple` parser (`node:querystring`) reads them: an array repeats its key (`c=1&c=2`), and an object value throws `TypeError` because the parser does not nest brackets. Objects travel as `json` or `whole` arguments instead.

A hand-written definition without `args` keeps the positional slots `params`, `query`, `body`: a `{ name: value }` object for the path, one for the query, then the body, each present only when the route declares it. Replies with status 204, or routes marked `void`, resolve to `undefined`.

## Generating the client

`spinajs generate:client` reads `app.manifest.json` and writes a typed client (default `src/generated/client.ts`):

```sh
spinajs generate:client --manifest app.manifest.json --out src/generated/client.ts
```

```ts
import { createAppClient } from './generated/client.js';

const client = createAppClient({ baseUrl: 'https://api.example.com' });
const user = await client.users.get(7);
```

The file holds one DTO type per named schema, one interface per controller (`UsersClient`), an `AppClient` that keys them by controller name (`users`), and the route table for `createClient`.

- Each route calls its manifest `fullPath`, the path the server answers at. A bare `@Get()` on `list()` under `@BasePath('users')` is `/users/list`. `fullPath` leaves out `http.controllers.route.prefix`, so a configured prefix belongs in `baseUrl`.
- Express 5 path syntax is kept: an optional group `{/:id}` makes its arguments optional and is left out when they are `undefined`, and a wildcard `*path` takes a `string[]`. Syntax Express 5 refuses (`:id(\d+)`, `?`, `+`) fails generation with an error naming the route. Any other path argument is required, even when the controller parameter is optional, because the URL cannot be built without it.
- A route with a `@Body()` next to a file or form argument fails generation: the handler would receive `null` for the body. Send those values with `@FormField()`.
- A method takes one argument per route parameter the client sends, in the controller's order and with the parameter's name and type: `list(@Query() query: ListQuery)` becomes `list(query: ListQuery)`, sent as `?query=<json>`. Arguments the server injects (`@FromDI`, `@Req`, `@Ip`, ...) are left out. A file parameter is `Blob | File`, or an array of them for `@Files`. An optional argument before a required one is typed `T | undefined`. Arguments are positional: swapping two controller parameters of the same type swaps them at existing call sites after regeneration, without a compile error.
- A path placeholder that no parameter reads still takes an argument (`string | number`, or `string[]` for a wildcard), because the server needs the segment.
- Routes a controller inherits are methods of that controller's client, with its path and the types it binds, so a subclass whose routes all come from its base gets a full client. A controller replaced with an unconditional `DI.register(Sub).as(Base)` is left out, because the runtime mounts only the subclass.
- A parameter without a `wire` binding (a manifest from an older compiler) fails generation with an error naming the route and the parameter. Rebuild the manifest.

Generate with `models: true` (`generateClientFiles`; the CLI flag comes with FG-2) to convert replies and arguments into `Date`, `DateTime`, `Decimal` and your own classes; see [Client models](models.md).

Socket controllers become `defineContract` constants (`chatContract`) from `@spinajs/http-socket-common`; pass `--no-socket` to leave them out and `--module <path>` to import the runtime from somewhere other than `@spinajs/client/runtime`.

The same generator is available as `generateClient({ manifest, moduleName?, includeSocket? })`, which resolves to the file contents. Output is deterministic for a given manifest. Types the analyzer could not derive (a dependency's model, a partly evaluated `@Schema`) are typed as open objects or `unknown`.

Install `@spinajs/client` next to `@spinajs/cli` to use the command.

## Extending generated types

The generated file is build output: it starts with `Do not edit`, and the next `spinajs generate:client` overwrites it. Put your code in files next to it.

Generated DTOs are `interface`s (`UserDto`, `CreateUserDto`), because the client receives plain JSON: no class, no methods, and a date is the string the server sent. Add behaviour in one of these ways.

**(a) A class merged with the DTO interface.** The interface supplies the fields, the class the behaviour:

```ts sample
import { fromClass } from '@spinajs/client/runtime';

// In the app this comes from './generated/client.js'.
interface UserDto {
  id: number;
  email: string;
  name?: string;
}

export interface User extends UserDto {}
export class User {
  static from(dto: UserDto): User {
    return fromClass(User).decode({ ...dto });
  }

  get label(): string {
    return this.name ?? this.email;
  }
}
```

Do not write `Object.assign(new User(), dto)` here. A JSON reply with a `"__proto__"` key makes `Object.assign` run the `__proto__` setter and replace the instance's prototype with the reply's object. `fromClass` defines the keys instead of assigning them, and skips `__proto__`, `constructor` and `prototype`. Nested plain objects keep such keys as own data properties, which is harmless until a hand-written copy loop assigns them.

**(b) A wrapper around the client.** The app gets models, and every route you did not wrap passes through, because the spread keeps the generated methods:

```ts
import { createAppClient } from './generated/client.js';
import { User } from './user.js';

const raw = createAppClient({ baseUrl: 'https://api.example.com' });

export const api = {
  ...raw,
  users: {
    ...raw.users,
    get: async (id: number) => User.from(await raw.users.get(id)),
  },
};
```

A route added on the server and regenerated shows up on `api.users` with its generated types, until you wrap it.

**(c) Plain functions.** `export const label = (user: UserDto) => user.name ?? user.email;` needs no class and works on what the client returns.

**(d) Registered models.** With `--models` the client builds the instances itself: dates arrive as `Date` or luxon `DateTime`, decimals as `Decimal`, and a DTO as your class, nested relations included. The same objects can be sent back. `createAppClient({ formats, models })` replaces the wrapper of (b) for replies; see [Client models](models.md).

```ts
const api = createAppClient({
  baseUrl: 'https://api.example.com',
  formats: { 'date-time': dateCodec },
  models: { UserDto: fromClass(User) },
});

const user = await api.users.get(7); // User
```

Regenerate in CI and compile, so a server change that breaks a wrapper fails the build instead of production:

```sh
spinajs build
spinajs generate:client --out src/generated/client.ts
git diff --exit-code src/generated/client.ts   # only when the file is committed
tsc --noEmit
```
