# Configuration source

`NotesConfiguration` replaces the `Configuration` service to set the example's settings in code: the logger targets and the `http.socket` keys that differ from the `@spinajs/http-socket` defaults. Use the same pattern when an app keeps its socket settings next to its boot code instead of in config files.

## How it works

1. `startNotesServer` runs `DI.register(NotesConfiguration).as(Configuration)` and then `DI.resolve(Configuration)`.
2. `FrameworkConfiguration` loads its configuration sources, including the `http.socket` defaults that `@spinajs/http-socket` ships.
3. It calls `NotesConfiguration.onLoad()` and deep-merges the returned object over the loaded values.
4. It validates the result against the registered schemas, including the `http.socket` schema `@spinajs/http-socket` registers at import. A bad value rejects the resolve.
5. `SocketServer` and `SocketHub` read `http.socket` through `@Config('http.socket')`.

## Configuration

Keys that `NotesConfiguration.onLoad()` sets. Every other `http.socket` key keeps its `@spinajs/http-socket` default; see [`@spinajs/http-socket`](../http-socket/README.md).

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.targets` | `array` | `[{ name: 'Empty', type: 'BlackHoleTarget' }]`; with `verbose`: `[{ name: 'Console', type: 'ConsoleTarget' }]` | `@spinajs/log` targets | Where logs go |
| `logger.rules` | `array` | `[{ name: '*', level: 'trace', target: 'Empty' }]`; with `verbose`: `level: 'info'`, `target: 'Console'` | `@spinajs/log` rules | Which logs reach the target |
| `http.socket.auth.required` | `boolean` | `true` (package default `false`) | `true`, `false` | `true` refuses a handshake no principal source signs in; `false` runs it as `UNATTENDED` |
| `http.socket.auth.revalidateMs` | `number` | `60000` | Positive ms | How often the guard re-checks every live connection's principal |
| `http.socket.streams.maxCredits` | `number` | `16` (package default `64`) | Positive integer | Largest credit window a stream request may ask for |
| `http.socket.*` | any | none | Any `http.socket` key | Keys from `INotesServerOptions.socket`, spread over the three above |

```ts
// what onLoad() returns for startNotesServer({ verbose: true })
{
  logger: {
    targets: [{ name: 'Console', type: 'ConsoleTarget' }],
    rules: [{ name: '*', level: 'info', target: 'Console' }],
  },
  http: {
    socket: {
      auth: { required: true, revalidateMs: 60_000 },
      streams: { maxCredits: 16 },
    },
  },
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Configuration` | `Configuration`, singleton; `startNotesServer` registers `NotesConfiguration` before its first resolve | `NotesConfiguration` | `FrameworkConfiguration` (`@spinajs/configuration`); config files in the app | Subclass `FrameworkConfiguration` and override the protected `onLoad()`; register with `DI.register(MyConfig).as(Configuration)` before the first `DI.resolve(Configuration)` |

### Configuration: custom implementation

Override `onLoad()` to return a plain object; it is merged over every loaded source. Keep the rest of `FrameworkConfiguration` as it is: sources, protocols and validation still run. Register the class before anything resolves `Configuration`, and call `DI.setESMModuleSupport()` first in an ES module app.

`startNotesServer` registers `NotesConfiguration` itself, so a custom configuration needs its own boot function, shown below for a chat server.

```ts sample
import { createServer, Server as NodeHttpServer } from 'node:http';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SocketHttpHost, SocketServer } from '@spinajs/http-socket';

class ChatConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      http: {
        socket: {
          path: '/chat',
          auth: { required: true, revalidateMs: 30_000 },
          maxPayloadBytes: 64 * 1024,
          rate: { perSecond: 10, burst: 20 },
        },
      },
    };
  }
}

class ChatHttpHost extends SocketHttpHost {
  public readonly Http: NodeHttpServer = createServer();

  public async server(): Promise<NodeHttpServer> {
    return this.Http;
  }
}

async function startChat(port: number): Promise<SocketServer> {
  DI.setESMModuleSupport();
  DI.register(ChatConfiguration).as(Configuration);
  DI.register(ChatHttpHost).as(SocketHttpHost);

  const config = await DI.resolve(Configuration);
  console.log(config.get<string>('http.socket.path'));
  // /chat

  const host = DI.resolve(SocketHttpHost) as ChatHttpHost;
  const server = await DI.resolve(SocketServer);
  host.Http.listen(port);
  return server;
}

void startChat(4200);
```

## Important behaviour

- `INotesServerOptions.socket` is merged two levels deep into `http.socket`: `socket: { auth: { revalidateMs: 5000 } }` keeps the example's `auth.required: true`. Set `auth: { required: false }` explicitly to allow anonymous handshakes.
- The merge into the loaded configuration is deep: keys `onLoad()` leaves out keep their source values.
- A stream request with `credits` above `http.socket.streams.maxCredits` (16 here) is refused with `invalid_argument`. The client default window, `DEFAULT_STREAM_CREDITS`, is 8.
- With `verbose` off, the rule level is `trace` into a `BlackHoleTarget`: every log entry is built and dropped.

## Best practices

- Return only the keys you change from `onLoad()`; the package defaults fill the rest and stay in one place.
- Keep `auth.required: true` for any server where an anonymous connection must not run commands.

## Patterns and antipatterns

```ts
// Keeps the example's auth.required: true
await startNotesServer({ socket: { auth: { revalidateMs: 5_000 } } });

// Anonymous handshakes need an explicit opt-out
await startNotesServer({ socket: { auth: { required: false } } });
```

## Related

- [`@spinajs/configuration`](../configuration/README.md): `FrameworkConfiguration`, sources and schema validation.
- [Server startup](02-server-startup.md): where `NotesConfiguration` is registered.
- [`@spinajs/http-socket`](../http-socket/README.md): every `http.socket` key and its default.
