# Render worker

The render worker is the child process `RenderPdfJob` forks. It bootstraps configuration and DI, turns the request into HTML, renders the PDF to a temp file with `PdfRenderer`, uploads it to the output provider and exits. `renderPdfToProvider()` is the exported core of that work, usable from your own worker or a script.

## How it works

1. `render-worker.js` waits for one `IRenderRequest` on `process.on('message')`.
2. It calls `renderPdfToProvider(req, onProgress)`, which bootstraps the process:
   1. With `req.config` set, it registers a `WorkerConfiguration` (a `FrameworkConfiguration` whose `onLoad()` returns `req.config`) as `Configuration`.
   2. `DI.resolve(Configuration)` loads the configuration.
   3. `FsBootsrapper.bootstrap()` registers the `'__file_provider__'` factory and `DI.resolve(fsService)` creates every provider in `fs.providers`.
3. It resolves `Templates`, `PdfRenderer` with `[req.pdfOptions ?? {}]`, and the output provider with `getFs(req.output.provider)`.
4. It builds the HTML: `templates.render(req.input, req.model, req.lang)` when `req.template` is true, otherwise `req.input` as is.
5. `renderer.renderHtmlToFile(html, tmp, { assetBasePath, onProgress })` writes the PDF to `<os tmpdir>/spinajs-pdf-<pid>-<timestamp>-<n>.pdf` and reports progress.
6. `provider.upload(tmp, req.output.path)` copies the file to the output provider.
7. The temp file is deleted (also on failure) and `renderPdfToProvider()` returns `req.output`.
8. The worker sends `{ type: 'done', result }`, runs `DI.dispose()` (closes the pooled Chromium) and exits with `0`. On any error it sends `{ type: 'error', message }`, disposes and exits with `1`.

Importing the package's `render.js` imports `@spinajs/templates-pdf` and `@spinajs/fs`, which registers `PdfRenderer`, the Puppeteer pipeline, the Pug engine, `fsNative` and `fsTemp` in the worker's container.

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `renderPdfToProvider` | `(req: IRenderRequest, onProgress: (m: { type: 'progress'; percent: number; phase: string; message?: string }) => void) => Promise<IRenderOutput>` | Bootstrap, render, upload, clean up; returns `req.output` |
| `IRenderRequest` | interface | `input`, `template?`, `model?`, `lang?`, `output`, `pdfOptions?`, `assetBasePath?`, `config?` |
| `IRenderOutput` | interface | `{ provider: string; path: string }` |
| `WorkerMessage` | union type | The messages a worker sends to its parent; see [Job supervision](02-job-supervision.md#the-ipc-protocol) |

## Configuration

The worker has no keys of its own. It reads the app's configuration, or the inline `config` merged into it.

### Configuration modes

| Mode | When | What the worker loads |
| --- | --- | --- |
| Re-bootstrap | `config` not set | `FrameworkConfiguration` with the sources registered in the worker (config files under the inherited working directory) and the environment of the parent process |
| Inline | `config` set | The same sources, then `config` deep-merged on top by `FrameworkConfiguration.load()`; arrays are concatenated |

The inline mode does **not** skip the config files: they still load, and `config` overrides them key by key. Arrays are appended, so `fs.providers` from `config` are added to the file ones; `fsService` keeps the last entry per `name`, so an inline provider replaces a file provider of the same name.

The keys the worker uses:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.defaultProvider` | `string` | none | a provider name | Required by `fsService`; the worker fails without it |
| `fs.providers` | `IProviderConfiguration[]` | none | `{ service, name, ... }` | All are created in the worker; `output.provider` must be one of the names |
| `templates.pdf.args` | Puppeteer `LaunchOptions` | `{ headless: true }` | | Chromium launch options |
| `templates.pdf.executablePath` | `string` | none | path | Chromium binary, overrides `args.executablePath` |
| `templates.pdf.static.portRange` | `number[]` | `[3000, 4000]` | `[from, to]` | Ports for the local asset server |
| `templates.pdf.renderTimeout` | `number` (ms) | `30000` | | Page operation timeout |
| `templates.pdf.navigationTimeout` | `number` (ms) | `30000` | | Page navigation timeout |
| `templates.pdf.renderDurationWarning` | `number` (ms) | none | | Logs a warning when a render takes longer |
| `templates.pdf.debug.close` | `boolean` | `true` (close) | `false` | Keeps the page open for inspection and disables the page timeouts |

See [`@spinajs/templates-pdf`](../templates-pdf/README.md) and [`@spinajs/fs`](../fs/01-providers-and-configuration.md) for the full keys.

```ts
// config/pdf.ts, read by the worker as well as by the app
export default {
  fs: {
    defaultProvider: 'documents',
    providers: [{ service: 'fsNative', name: 'documents', basePath: '/var/app/documents' }],
  },
  templates: {
    pdf: {
      args: { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      renderTimeout: 60000,
      renderDurationWarning: 20000,
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Worker entry | file forked by `spawnWorker()` | `render-worker.js` | Your script calling `renderPdfToProvider()` | [Custom worker entry](06-custom-worker-entry.md) |
| `renderPdfToProvider` | exported function | used by the shipped worker | Call it from your worker, a CLI script or a test | Wrap it; it is not resolved from DI |
| Services it resolves | `Configuration`, `Templates`, `PdfRenderer`, `'__file_provider__'` | see [Worker services](07-worker-services.md) | | Register replacements in the worker before calling it |

## Important behaviour

- `assetBasePath` defaults to the temp file's directory, the OS temp directory, in both modes. Relative URLs (`<img src="logo.png">`) resolve only when you set `assetBasePath` to the folder that holds them.
- In template mode the template is compiled to an HTML string and then rendered like raw HTML. The model does **not** get the `__http_template_port__` and `__http_template_address__` values that `PdfRenderer.renderToFile()` adds; use relative URLs with `assetBasePath` instead.
- The template is compiled before the renderer starts, so the job shows no progress during compilation.
- Only engines registered in the worker can compile templates. The shipped worker has Pug (`.pug`); any other extension fails with an error from `Templates`.
- The worker creates **every** provider in `fs.providers`, not only the output one. A provider whose `service` class is not imported in the worker (eg. `fsS3` from `@spinajs/fs-s3`) fails the bootstrap with `Type fsS3 not registered`. Load such packages in a [custom worker entry](06-custom-worker-entry.md).
- `fork()` passes the parent's command-line arguments (`process.argv.slice(2)`), so `--app`, `--apppath` and `--env` reach the worker's `FrameworkConfiguration`.
- `renderPdfToProvider()` registers `WorkerConfiguration` as `Configuration` in the root container when `config` is set. In a process that already has its configuration, that registration wins for later resolves.
- `renderPdfToProvider()` does not dispose DI. The shipped worker disposes and exits; your own caller must call `DI.dispose()` to close Chromium.

## Best practices

- Always set `assetBasePath` for a document with images, fonts or stylesheets.
- Keep the worker's configuration in config files the app and the worker both load; use `config` only for values that differ per job.
- Run the worker from the same working directory as the app: `fork()` inherits it, and config files are found relative to it.

## Patterns and antipatterns

```ts
// Don't: put credentials into the payload; the message is persisted by the queue transport
await scheduleRenderPdf({ ...payload, config: { fs: { providers: [{ service: 'fsS3', name: 'documents', secretAccessKey: '...' }] } } });

// Do: keep credentials in configuration the worker loads itself, and name the provider
await scheduleRenderPdf({ ...payload, output: { provider: 'documents', path: 'invoices/1042.pdf' } });
```

## Examples

### Render a PDF from a maintenance script, without the queue

```ts sample
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { renderPdfToProvider } from '@spinajs/queue-templates-pdf';

class ReportScriptConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      fs: {
        defaultProvider: 'reports',
        providers: [{ service: 'fsNative', name: 'reports', basePath: '/var/app/reports' }],
      },
      templates: { pdf: { args: { headless: true }, renderDurationWarning: 30000 } },
    };
  }
}

async function renderYearEndReport(year: number): Promise<void> {
  DI.register(ReportScriptConfiguration).as(Configuration);

  try {
    const result = await renderPdfToProvider(
      {
        input: 'templates/reports/year-end.pug',
        template: true,
        model: { year },
        output: { provider: 'reports', path: `year-end-${year}.pdf` },
        assetBasePath: 'templates/reports',
        pdfOptions: { format: 'A4', landscape: true },
      },
      (m) => console.log(`${m.percent}% ${m.phase} ${m.message ?? ''}`),
    );

    console.log(`Written to ${result.provider}:${result.path}`);
  } finally {
    await DI.dispose();
  }
}
```

## Related

- [Job supervision](02-job-supervision.md): the parent side of the worker.
- [Worker services](07-worker-services.md): replacing what the worker resolves.
- [Custom worker entry](06-custom-worker-entry.md): your own worker script around `renderPdfToProvider()`.
- [`@spinajs/configuration`](../configuration/README.md): sources and `FrameworkConfiguration`.
