# Render progress

`IRenderOptions.onProgress` receives progress snapshots during a render. This package defines the contract (`RenderPhase`, `IRenderProgress`, `RenderProgressCallback`) and a CLI reporter; the puppeteer renderers (pdf, image) are the shipped engines that report.

## How it works

1. You pass `{ onProgress }` as the last argument of `Templates.renderToFile()` or `compileToFile()`.
2. `Templates` hands `options` to the renderer untouched.
3. A reporting renderer calls `onProgress(snapshot)` at each phase change and on resource events. Text engines (handlebars, pug, mjml, csv, xlsx) ignore the option and never call it.
4. The puppeteer renderers call the listener fire-and-forget: they never await it and swallow its errors and rejections. A slow or faulty listener cannot stall or break the render.
5. The last snapshot has the phase `Done` or `Failed`.

### `RenderPhase`

| Member | Value | Meaning |
| --- | --- | --- |
| `Starting` | `'starting'` | Local static server, pooled browser and page are being set up |
| `Preparing` | `'preparing'` | HTML is being built: template compiled or raw HTML injected |
| `Loading` | `'loading'` | Page content is loading: images, CSS, fonts |
| `Rendering` | `'rendering'` | The output is being produced (`page.pdf()`, screenshot) |
| `Done` | `'done'` | Render finished |
| `Failed` | `'failed'` | Render failed; `message` carries the reason |

### `IRenderProgress`

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | `RenderPhase` | Current phase |
| `percent` | `number` | Best-effort completion, `0` to `100`, weighted per phase |
| `resourcesLoaded` | `number` | Resources whose response completed since loading started |
| `resourcesPending` | `number` | Resources requested but not finished or failed |
| `resourcesFailed` | `number` | Resources that failed, eg. broken images |
| `elapsedMs` | `number` | Milliseconds since the render started |
| `filePath` | `string` | Output file being produced |
| `message` | `string?` | Short status line |
| `tasks` | `Record<string, { done, total }>?` | Page-reported task counts; see below |

Resource counters stay `0` for engines without a network phase.

### Page-reported tasks

A page rendered by a puppeteer engine can report its own work by logging `__spinajs_progress__:` followed by JSON:

```ts
// inside the page script, eg. while charts are drawn
console.log('__spinajs_progress__:{"task":"charts","done":2,"total":5}');
```

The last counts per task name appear in `tasks`. See the puppeteer renderer's [render progress](../templates-puppeteer/02-render-progress.md) for throttling and percent weights.

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `RenderProgressCallback` | `(progress: IRenderProgress) => void \| Promise<void>` | The listener type |
| `cliProgressReporter(write?, isTty?)` | returns `RenderProgressCallback` | On a TTY rewrites one live line and ends it with a newline on `Done` / `Failed`; otherwise prints one line per phase change |
| `formatProgressLine(p)` | returns `string` | `[██████··············]  30% loading   <message> 1.2s`: a 20-cell bar, percent, phase and elapsed seconds |

`write` defaults to `process.stdout.write`; `isTty` defaults to `process.stdout.isTTY`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RenderProgressCallback` | No token: passed per call in `IRenderOptions.onProgress` | none | `cliProgressReporter()` | Pass any function; wrap `formatProgressLine()` for your own output |
| Progress reporting in a renderer | Your `TemplateRenderer` subclass reads `options?.onProgress` in `render()` / `renderToFile()` | puppeteer renderers report | text engines do not | Call the listener at each phase; see the sample below |

### Progress reporting in a renderer: report phases from your own engine

A renderer reports by calling `options?.onProgress` itself. Follow the shipped contract: do not await the listener and do not let its errors escape.

```ts sample
import { writeFile } from 'fs/promises';
import { Injectable } from '@spinajs/di';
import { ensureParentDir, IRenderOptions, IRenderProgress, RenderPhase, TemplateRenderer } from '@spinajs/templates';

interface ISitemapModel {
  baseUrl: string;
  paths: string[];
}

@Injectable(TemplateRenderer)
export class SitemapRenderer extends TemplateRenderer {
  public get Type() {
    return 'sitemap';
  }

  public get Extension() {
    return '.sitemap';
  }

  public async render(_template: string, model: ISitemapModel): Promise<string> {
    const urls = model.paths.map((p) => `  <url><loc>${model.baseUrl}${p}</loc></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  }

  public async renderToFile(template: string, model: ISitemapModel, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    const started = Date.now();
    const report = (phase: RenderPhase, percent: number, message?: string) => {
      const snapshot: IRenderProgress = { phase, percent, resourcesLoaded: 0, resourcesPending: 0, resourcesFailed: 0, elapsedMs: Date.now() - started, filePath, message };
      try {
        void Promise.resolve(options?.onProgress?.(snapshot)).catch(() => undefined);
      } catch {
        // a faulty listener must not break the render
      }
    };

    try {
      report(RenderPhase.Preparing, 10, `${model.paths.length} urls`);
      const xml = await this.render(template, model);
      report(RenderPhase.Rendering, 80);
      ensureParentDir(filePath);
      await writeFile(filePath, xml, 'utf-8');
      report(RenderPhase.Done, 100);
    } catch (err) {
      report(RenderPhase.Failed, 100, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
```

## Important behaviour

- `Templates.render()` and `compile()` pass `options` too, but the reporting engines only render to files; their `render()` throws `NotSupported`.
- `cliProgressReporter()` keeps the last phase in a closure. Create one per render.
- In non-TTY mode (CI, piped output) a phase is printed once, so the percent inside a phase is not shown.

## Best practices

- Use `cliProgressReporter()` in one-shot commands and your own `onProgress` in services; the reporter writes to stdout.
- Keep the listener cheap: push the snapshot to a queue or a job record and return.

## Patterns and antipatterns

```ts
// Don't: the listener's rejection is swallowed, so the job record silently stops updating
onProgress: async (p) => await jobs.update(jobId, { percent: p.percent }),

// Do: handle the failure inside the listener
onProgress: (p) => void jobs.update(jobId, { percent: p.percent }).catch((err) => log.warn({ error: err }, 'progress update failed')),
```

## Examples

### Print PDF progress in a CI log

```ts sample
import '@spinajs/templates-pdf';
import { DI } from '@spinajs/di';
import { cliProgressReporter, Templates } from '@spinajs/templates';

async function buildReport() {
  const templates = await DI.resolve(Templates);

  // invoice.pdf is rendered from views/invoice.pug
  await templates.renderToFile('./views/invoice.pdf', { invoiceNo: 'FV/2026/10/17' }, './out/invoice.pdf', 'en', {
    onProgress: cliProgressReporter((line) => void process.stderr.write(line), false),
  });
}

void buildReport();
```

## Related

- [Rendering templates](01-rendering-templates.md): where `IRenderOptions` is passed.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): the reporting renderer base.
- [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/04-progress-reporting.md): progress of queued PDF jobs.
- [CLI command and helpers](09-cli-command-and-helpers.md): `cliProgressReporter()` in a command.
