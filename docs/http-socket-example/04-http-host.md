# HTTP host

`NotesHttpHost` supplies the node http server that socket.io attaches to. It replaces the default `HttpServerHost`, which takes the server of `@spinajs/http`, so the notes example runs without an HTTP framework.

An app on `@spinajs/http` needs no host of its own: the default `HttpServerHost` uses that app's server.

## How it works

1. Importing `server.js` runs `DI.register(NotesHttpHost).as(SocketHttpHost)`. `@spinajs/http-socket` is imported first and registers `HttpServerHost` with `@Injectable(SocketHttpHost)`, so `NotesHttpHost` is the last registration and wins.
2. `NotesHttpHost` creates `Http = createServer()` from `node:http` when it is constructed. Nothing listens yet.
3. `SocketServer.resolve()` injects `SocketHttpHost` and calls `server()`, which returns `Http`; socket.io attaches to it.
4. `startNotesServer` resolves the same singleton with `DI.resolve(SocketHttpHost)` and calls `Http.listen(port, '127.0.0.1')`.
5. `INotesServer.close()` disposes `SocketServer`, then calls `Http.closeAllConnections()` and `Http.close()`. Socket.io never closes the host's server: the host owns it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketHttpHost` | `SocketHttpHost` (abstract class), singleton; injected into `SocketServer` with `@Autoinject()` | `HttpServerHost` (`@spinajs/http-socket`), replaced here by `NotesHttpHost` | Any subclass returning a node `http.Server` or `https.Server` | Subclass `SocketHttpHost`, implement `server()`, `DI.register(MyHost).as(SocketHttpHost)` after importing `@spinajs/http-socket` and before resolving `SocketServer` |

`SocketHttpHost` has one abstract method:

```ts
public abstract server(): Promise<HttpNodeServer | HttpsNodeServer>;
```

### SocketHttpHost: custom implementation

Write a host when socket.io must attach to a server you create yourself: a TLS server, a server shared with another framework, or a test server on a random port. `server()` is called once, during `SocketServer.resolve()`, so it may also wait for the server to be ready. Keep the server on a public field so boot code can call `listen()` on it.

```ts sample
import { readFileSync } from 'node:fs';
import { createServer, Server as HttpsServer } from 'node:https';
import { DI } from '@spinajs/di';
import { SocketHttpHost, SocketServer } from '@spinajs/http-socket';

// Serves the socket on TLS with the certificate from the deploy directory.
class TlsSocketHost extends SocketHttpHost {
  public readonly Https: HttpsServer = createServer({
    key: readFileSync('/etc/notes/tls/key.pem'),
    cert: readFileSync('/etc/notes/tls/cert.pem'),
  });

  public async server(): Promise<HttpsServer> {
    return this.Https;
  }
}

DI.register(TlsSocketHost).as(SocketHttpHost);

async function startTls(): Promise<void> {
  const host = DI.resolve(SocketHttpHost) as TlsSocketHost;
  await DI.resolve(SocketServer);
  host.Https.listen(8443);
}

void startTls();
```

## Important behaviour

- The host owns the http server. `SocketServer.dispose()` closes the socket.io namespaces but leaves the http server open; close it yourself, as `INotesServer.close()` does.
- `NotesHttpHost` is a singleton, so `DI.resolve(SocketHttpHost)` returns the instance socket.io attached to. After `DI.clearCache()` the next resolve builds a new instance with a new, unbound `Http`.
- Register the host before the first `DI.resolve(SocketServer)`. A host registered later is never asked: `SocketServer` already holds the old one.

## Best practices

- On `@spinajs/http`, keep `HttpServerHost` and resolve `SocketServer` after `HttpServer`; write a host only when no `@spinajs/http` server exists.
- Expose the server as a typed public field (`Http`, `Https`) instead of awaiting `server()` again in boot code.

## Related

- [`@spinajs/http-socket`](../http-socket/README.md): `SocketHttpHost`, `HttpServerHost` and `SocketServer`.
- [Server startup](02-server-startup.md): where the host is resolved, listened on and closed.
