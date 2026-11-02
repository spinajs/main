# Local asset server

Headless Chromium refuses `file://` resources for a page loaded with `setContent()`. `LocalAssetServer` starts a short-lived Express static server for each render, so templates and raw HTML can load images, fonts and CSS from disk over `http://127.0.0.1:<port>`. Replace it to serve more than one directory or to add headers.

## How it works

1. `PuppeteerRenderer.assetServer` builds `new LocalAssetServer(this.Log, () => this.Options?.static?.portRange)` on first access.
2. `renderContentToFile()` calls `assetServer.serve(basePath)` at the start of each render. `basePath` is the template's directory for `renderToFile()`, and `assetBasePath` or the output file's directory for `renderHtmlToFile()`. A custom caller of `renderContentToFile()` without `assetBasePath` serves `process.cwd()`.
3. `serve()` reads the port range:
   - No range, or `[]`: one attempt on port `0`, which the OS assigns.
   - A range `[min, max]`: a random port in it, with up to 10 attempts. Only `EADDRINUSE` triggers a retry; any other error is thrown at once.
4. Each attempt builds an Express app with `cors()` and `express.static(basePath)` and listens on `127.0.0.1`. An attempt that does not start within 10 s rejects with `Server startup timeout`.
5. The render uses `server.address().port` for `__http_template_port__`, `__http_template_address__` and the injected `<base href>`.
6. In the render's `finally`, `assetServer.close(server)` closes it. A close that takes over 5 s, or fails, is logged as a warning and `closeAllConnections()` force-closes the sockets.

After 10 failed attempts `serve()` logs an error and throws the last `EADDRINUSE`; the render fails in the `starting` phase.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `<key>.static.portRange` | `number[]` | `[3000, 4000]` for `templates.pdf` and `templates.image` | `[min, max]`, both inclusive; unset or `[]` for an OS port | Port range for the server; only the last two elements are read |

`<key>` is the renderer's config path. A `portRange` in your config files replaces the shipped one; package configs concatenate among themselves, so the server reads the last two elements. You can also set it at runtime:

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

async function usePdfPortsAbove9000(): Promise<void> {
  const config = await DI.resolve(Configuration);

  // replaces the merged array; read at every render, so it applies to the next one
  config.set('templates.pdf.static.portRange', [9000, 9100]);
}

void usePdfPortsAbove9000();
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `LocalAssetServer` | Not in DI; one per renderer instance, built by the protected `assetServer` getter; one `http.Server` per render | `LocalAssetServer` | none shipped | Subclass it and override the renderer's `assetServer` getter |

`LocalAssetServer` public API:

| Member | Effect |
| --- | --- |
| `constructor(log: Log, portRange: () => number[] \| undefined)` | `portRange` is read on every `serve()` |
| `serve(basePath: string): Promise<http.Server>` | Starts a server for `basePath` on loopback |
| `close(server: http.Server): Promise<void>` | Closes it, forcing connections after 5 s; never throws |

### Serve shared brand assets next to each template

Every template references the same fonts and logos, kept in one folder. Instead of copying them next to each template, serve that folder under `/brand` on the same server.

```ts sample
import express from 'express';
import * as http from 'http';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log } from '@spinajs/log';
import { TemplateRenderer } from '@spinajs/templates';
import { LocalAssetServer } from '@spinajs/templates-puppeteer';
import { PdfRenderer } from '@spinajs/templates-pdf';

export class BrandAssetServer extends LocalAssetServer {
  constructor(log: Log, private readonly brandDir: () => string) {
    super(log, () => undefined);
  }

  public serve(basePath: string): Promise<http.Server> {
    const app = express();
    app.use('/brand', express.static(this.brandDir()));
    app.use(express.static(basePath));

    return new Promise((resolve, reject) => {
      // loopback and an OS-assigned port, as the default server does without a range
      const server = app.listen(0, '127.0.0.1');
      server.once('listening', () => resolve(server));
      server.once('error', reject);
    });
  }
}

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class BrandedPdfRenderer extends PdfRenderer {
  @Config('templates.pdf.brandDir', { defaultValue: 'assets/brand' })
  protected BrandDir: string;

  private brandServer?: BrandAssetServer;

  protected get assetServer(): LocalAssetServer {
    return (this.brandServer ??= new BrandAssetServer(this.Log, () => this.BrandDir));
  }
}
```

In a template:

```pug
link(rel='stylesheet' href=__http_template_address__ + '/brand/fonts.css')
img(src=__http_template_address__ + '/brand/logo.svg')
```

Register `BrandedPdfRenderer` in place of `PdfRenderer` as shown in [Extend a shipped renderer](03-custom-renderers.md#extend-a-shipped-renderer-block-remote-requests). The inherited `close()` still closes your server.

## Important behaviour

- The server binds to `127.0.0.1` only; the served directory is never exposed to the network.
- `cors()` allows every origin, and `express.static` serves every file under the base path except dot-files. Any script in the rendered page can read them while the render runs. Do not point `assetBasePath` at a directory with secrets.
- One server per render: concurrent renders each get their own port.
- `__http_template_address__` is `http://127.0.0.1:<port>`, the address the server binds, so it does not depend on how `localhost` resolves.
- With a configured range, a random pick can collide with a port your app or another render uses; each collision costs a retry. An OS-assigned port never collides.

## Best practices

- Keep templates and their assets in a dedicated folder, so the server exposes nothing else.
- For `renderHtmlToFile()`, pass `assetBasePath` explicitly. The default, the output file's directory, rarely holds the assets.
- Use no port range unless a firewall or a sandbox needs fixed ports.

## Related

- [Rendering to files](01-rendering-to-files.md): `__http_template_address__` and `<base href>` injection.
- [Browser pool](04-browser-pool.md): the remote-browser case, where this loopback server is unreachable.
- [Custom Puppeteer renderers](03-custom-renderers.md): registering the renderer that owns your server.
