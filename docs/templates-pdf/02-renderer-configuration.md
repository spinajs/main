# Renderer configuration

`PdfRenderer` reads its settings from `templates.pdf`, typed `IPuppeteerRendererOptions` (exported by `@spinajs/templates-puppeteer`). The keys control how Chromium is launched, which ports the asset server uses, and how long a render may take.

## How it works

1. `@spinajs/configuration` loads the package config file `lib/<mjs|cjs>/config/pdf.js` and merges it with your app's config.
2. `PdfRenderer.Options` is injected with `@Config('templates.pdf')` when the renderer is built.
3. The values are read lazily, per render:
   - `BrowserPool.acquire()` launches Chromium with `args`, overridden by `executablePath`, on the first render of each renderer instance.
   - `LocalAssetServer.serve()` reads `static.portRange` on every render.
   - `configurePageTimeouts()`, `armRenderWatchdog()` and `warnIfSlow()` read the timeouts on every render.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `templates.pdf.args` | `LaunchOptions` (Puppeteer) | `{ headless: true }` | Any Puppeteer launch options | Passed to `puppeteer.launch()` for the pooled browser |
| `templates.pdf.executablePath` | `string` | not set | Absolute path to a Chrome / Chromium binary | Overrides `args.executablePath`; use it where Puppeteer cannot download Chromium |
| `templates.pdf.static.portRange` | `number[]` | `[3000, 4000]` | `[min, max]`, or `[]` | Port range of the per-render asset server. A random port is tried up to 10 times on `EADDRINUSE`. An empty array uses an OS-assigned port |
| `templates.pdf.navigationTimeout` | `number` (ms) | `30000` | `> 0` | `page.setDefaultNavigationTimeout()` |
| `templates.pdf.renderTimeout` | `number` (ms) | `30000` | `> 0` | `page.setDefaultTimeout()` and the watchdog that closes the page of a render running longer |
| `templates.pdf.renderDurationWarning` | `number` (ms) | not set | `> 0` | A render longer than this logs a `warn`. Not set means no warning |
| `templates.pdf.debug.close` | `boolean` | `true` (not set) | `false` | `false` keeps each rendered page open and disables both timeouts, for inspection with `headless: false` |
| `templates.pdf.options` | `object` | `{}` | none | Default `PDFOptions` for every render. Options the renderer is resolved with override these keys |
| `system.dirs.cli` | `string[]` | appends `node_modules/@spinajs/templates-pdf/lib/<mjs\|cjs>/cli` under `WORKSPACE_ROOT_PATH ?? cwd`, and the same path one directory up | Directory paths | Makes the [`render-pdf` command](05-render-pdf-command.md) discoverable |

```ts
// config/production.ts
export default {
  templates: {
    pdf: {
      // Debian image with chromium from apt, no bundled download
      executablePath: '/usr/bin/chromium',
      args: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
      static: { portRange: [] },
      navigationTimeout: 20000,
      renderTimeout: 60000,
      renderDurationWarning: 10000,
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Renderer options | Config key `templates.pdf`, injected into `PdfRenderer.Options` with `@Config` | The package config file | Any config source of `@spinajs/configuration` | Set the keys in your config; a subclass can bind `Options` to another key with its own `@Config(...)` |
| Pooled browser | `BrowserPool` (from `@spinajs/templates-puppeteer`), one per renderer instance, built lazily; not in DI | `puppeteer.launch(args + executablePath)` | none | Change launch options in config; override `armRenderWatchdog()` / `configurePageTimeouts()` for timing; see [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md#hooks-you-can-override) |
| Asset server | `LocalAssetServer`, one per renderer instance, built lazily; not in DI | Express static on `127.0.0.1` | none | Configure `static.portRange` |

### Renderer options: read a different config key

A subclass declares its own `Options` property, so one app can run two PDF setups, eg. a fast in-process renderer and a slow one for large reports.

```ts sample
import { Config } from '@spinajs/configuration';
import { DI, PerInstanceCheck } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { IPuppeteerRendererOptions } from '@spinajs/templates-puppeteer';

// reads templates.pdfReports: { renderTimeout: 300000, args: { headless: true, protocolTimeout: 300000 } }
@PerInstanceCheck()
export class ReportPdfRenderer extends PdfRenderer {
  @Config('templates.pdfReports')
  protected Options: IPuppeteerRendererOptions;
}

export async function printAnnualReport(html: string): Promise<void> {
  const renderer = await DI.resolve(ReportPdfRenderer, [{ format: 'A4', printBackground: true }]);
  try {
    await renderer.renderHtmlToFile(html, './storage/reports/annual-2026.pdf', { assetBasePath: './templates/reports' });
  } finally {
    await renderer.dispose();
  }
}
```

`ReportPdfRenderer` is not registered under `TemplateRenderer`, so `Templates` keeps using `PdfRenderer` for `.pdf` paths.

## Important behaviour

- Launch options are read when a renderer instance launches its browser. A config change after the first render of that instance has no effect until `dispose()`.
- The watchdog closes only the page, not the browser. The render then fails with Puppeteer's error for a closed page, and progress reports phase `failed`.
- With `debug.close: false` the page stays open after the render and no timeout fires: a hung render hangs forever. Never ship it.
- A port range is a random pick, retried up to 10 times. Many parallel renders in a narrow range can still fail with `EADDRINUSE`; an empty range cannot collide.
- `renderDurationWarning` has no shipped default, so slow renders are not reported until you set it.
- `args.headless: false` opens a visible window; combine it with `debug.close: false` to inspect the page.

## Best practices

- In containers set `executablePath` and pass `--no-sandbox` and `--disable-dev-shm-usage` in `args.args`; the default `/dev/shm` is too small for large documents.
- Raise `renderTimeout` for documents with hundreds of images, and keep `navigationTimeout` short to fail fast on unreachable remote assets.
- Use `static.portRange: []` unless a firewall forces a fixed range.

## Related

- [Rendering PDFs](01-rendering-pdfs.md): where each key takes effect in the flow.
- [`@spinajs/configuration`](../configuration/README.md): config files, environments and `@Config`.
- [`@spinajs/templates-image`](../templates-image/README.md): the same keys under `templates.image`.
