# Render progress

A render can take seconds when the HTML pulls in many images, fonts or stylesheets. Pass `onProgress` to see what it is doing: the phase, a best-effort percent, live resource counters and elapsed time. A page can report its own task progress through console lines, and `RenderProgressReporter` brings the same reporting to your own Puppeteer code.

## How it works

1. `renderToFile()` or `renderHtmlToFile()` receives `options.onProgress`. `renderContentToFile()` creates `new RenderProgressReporter(filePath, onProgress)`.
2. `reporter.phase()` is called at each milestone: `starting`, `preparing`, `loading`, `rendering`, then `done` or `failed`. Each call emits at once, bypassing the throttle.
3. `reporter.attach(page)` subscribes to the page's `request`, `requestfinished`, `requestfailed` and `console` events. Each finished or failed request, and each progress console line, emits a snapshot, throttled to one per 150 ms.
4. During `loading` and `rendering` a heartbeat re-emits every 750 ms, so the elapsed time keeps moving while one slow resource loads.
5. `reporter.dispose()` stops the heartbeat and detaches the page listeners, in the render's `finally`.

The callback receives an `IRenderProgress` (`@spinajs/templates`):

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | `RenderPhase` | Current phase |
| `percent` | `number` | 0 to 100, never goes down |
| `resourcesLoaded` | `number` | Requests that finished |
| `resourcesPending` | `number` | Requests started but not finished or failed |
| `resourcesFailed` | `number` | Requests that failed, eg. a broken image |
| `elapsedMs` | `number` | Time since the reporter was created |
| `filePath` | `string` | Output file |
| `message` | `string` | Status line, see the table below |
| `tasks` | `Record<string, { done, total }>` | Last counts per task from the page protocol; `undefined` when the page reported none |

## Phases and percent

| Phase | Percent | Default message | Emitted when |
| --- | --- | --- | --- |
| `starting` | 0 | `Starting renderer` | Before the asset server starts |
| `preparing` | 10 | `Preparing HTML` | The page is open, before the template compiles |
| `loading` | 15 to 80 | `Loading resources (<n> done, <n> pending, <n> failed)`, or `<task> <done>/<total>, ...` | Right before `page.setContent()` |
| `rendering` | 80 | `Generating output` | Before `performRender()` |
| `done` | 100 | `Done` | The file is written |
| `failed` | the last percent | the error message | Any step threw |

- Before any page task line arrives, `loading` uses `loaded / (loaded + pending)`, capped at half of the band: 15 to 48.
- Once a task line arrives, `loading` uses `sum(min(done, total)) / sum(total)` over all tasks, mapped onto 15 to 80.
- `rendering` stays at 80 until `done`: `page.pdf()` and `page.screenshot()` report nothing.

## Page progress protocol

A page that builds content in a script knows its progress better than the request count. It reports it by logging a line with the prefix `PAGE_PROGRESS_PREFIX` (`__spinajs_progress__:`) followed by JSON:

```
__spinajs_progress__:{"task":"charts","done":3,"total":12}
```

`parseProgressLine(text)` reads it and returns `{ task, done, total }`, or `null` when:

- the prefix is missing or the JSON does not parse;
- `task` is not a non-empty string;
- `done` or `total` is not a finite number `>= 0`.

A `null` line is ignored. Several tasks are summed. A later line for the same task replaces its counts.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Progress listener | `IRenderOptions.onProgress`, per call | none | `cliProgressReporter()` from `@spinajs/templates`, the `@spinajs/queue-templates-pdf` worker | Pass any `RenderProgressCallback` |
| Page progress protocol | Console lines read by `RenderProgressReporter` | Request counting | Your page's task counts | Log `__spinajs_progress__:` lines from a script in the page |
| `RenderProgressReporter` | Not in DI; `new` per render in `renderContentToFile()` | `RenderProgressReporter` | none | Use it in your own Puppeteer code; to change it inside `PuppeteerRenderer`, override `renderContentToFile()` |

`RenderProgressReporter` public API:

| Member | Effect |
| --- | --- |
| `constructor(filePath: string, callback?: RenderProgressCallback)` | Without a callback the reporter is inert: no listeners, no timers |
| `attach(page: Page)` | Subscribes to the page's request and console events; call once after `newPage()` |
| `phase(phase: RenderPhase, message?: string)` | Moves to a phase and emits at once; starts or stops the heartbeat |
| `dispose()` | Stops the heartbeat, detaches the page; safe to call twice |

### Report progress from your own Puppeteer script

You drive Puppeteer yourself, eg. a crawler that prints pages, and want the same snapshots as the renderers.

```ts sample
import puppeteer from 'puppeteer';
import { RenderPhase } from '@spinajs/templates';
import { RenderProgressReporter } from '@spinajs/templates-puppeteer';

async function printDashboard(url: string, out: string): Promise<void> {
  const progress = new RenderProgressReporter(out, (p) => {
    console.log(`${p.phase} ${p.percent}% ${p.message ?? ''}`);
  });

  progress.phase(RenderPhase.Starting);
  const browser = await puppeteer.launch({ headless: true });

  try {
    const page = await browser.newPage();
    progress.attach(page);

    progress.phase(RenderPhase.Loading);
    await page.goto(url, { waitUntil: 'networkidle0' });

    progress.phase(RenderPhase.Rendering);
    await page.pdf({ path: out, format: 'A4' });

    progress.phase(RenderPhase.Done);
  } catch (err) {
    progress.phase(RenderPhase.Failed, (err as Error).message);
    throw err;
  } finally {
    progress.dispose();
    await browser.close();
  }
}

void printDashboard('https://intranet.example.com/dashboard', 'out/dashboard.pdf');
```

## Important behaviour

- The callback is fire-and-forget: it is never awaited, and a thrown error or rejected promise is swallowed. An async listener cannot stall the render and a broken one cannot fail it. Synchronous work in the listener still runs on the render's event loop.
- `percent` never goes down. A `failed` snapshot keeps the last percent.
- `elapsedMs` counts from the reporter's creation, ie. from the start of `renderContentToFile()`.
- Resource counters count every request the page makes, including requests to remote hosts and failed ones.
- The heartbeat timer is `unref()`-ed: it never keeps the process alive.
- Without `onProgress` nothing is attached and nothing is allocated per event.
- Progress starts after the renderer is resolved. Browser launch is inside `starting`; template compile is inside `preparing`.

## Best practices

- Forward only what your channel needs. A queue job needs `percent`; a CLI needs `message`.
- Emit page task lines from the code that does the slow work (chart drawing, table filling), and send a final line with `done === total`.
- Keep `onProgress` synchronous and cheap. It runs on page events; heavy work there competes with the render.

## Patterns and antipatterns

```ts
// Don't: awaiting inside the listener does not slow the render, but each write races the next
onProgress: async (p) => {
  await db.update('jobs', { progress: p.percent });
},

// Do: hand the value to something that throttles and orders writes
onProgress: (p) => void jobProgress(p.percent),
```

## Examples

### Show a live progress line while rendering a PDF

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { cliProgressReporter } from '@spinajs/templates';
import { PdfRenderer } from '@spinajs/templates-pdf';

async function renderCatalogue(): Promise<void> {
  await DI.resolve(Configuration);
  const renderer = await DI.resolve(PdfRenderer, [{ format: 'A4', printBackground: true }]);

  try {
    await renderer.renderToFile('templates/catalogue.pdf', { season: 'Autumn 2026' }, 'out/catalogue.pdf', 'en', {
      onProgress: cliProgressReporter(),
    });
  } finally {
    await renderer.dispose();
  }
}

void renderCatalogue();
```

### Report chart drawing progress from the page

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { IRenderProgress } from '@spinajs/templates';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { PAGE_PROGRESS_PREFIX } from '@spinajs/templates-puppeteer';

function salesReportHtml(regions: string[]): string {
  const sections = regions.map((r) => `<section data-region="${r}"></section>`).join('');

  return `<!doctype html><html><head></head><body>${sections}
<script>
  const sections = document.querySelectorAll('section[data-region]');
  sections.forEach((section, i) => {
    section.textContent = 'Chart for ' + section.dataset.region;
    console.log('${PAGE_PROGRESS_PREFIX}' + JSON.stringify({ task: 'charts', done: i + 1, total: sections.length }));
  });
</script></body></html>`;
}

async function renderSalesReport(): Promise<void> {
  await DI.resolve(Configuration);
  const renderer = await DI.resolve(PdfRenderer, [{ format: 'A4' }]);

  try {
    await renderer.renderHtmlToFile(salesReportHtml(['north', 'south', 'east', 'west']), 'out/sales.pdf', {
      onProgress: (p: IRenderProgress) => console.log(p.percent, p.tasks?.charts),
    });
  } finally {
    await renderer.dispose();
  }
}

void renderSalesReport();
```

## Related

- [Rendering to files](01-rendering-to-files.md): where each phase starts.
- [`@spinajs/templates`](../templates/README.md): `IRenderProgress`, `RenderPhase`, `RenderProgressCallback`, `cliProgressReporter()`.
- [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/04-progress-reporting.md): turns these snapshots into job progress.
