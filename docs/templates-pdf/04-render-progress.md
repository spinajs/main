# Render progress

Pass `onProgress` to any render call to receive throttled `IRenderProgress` snapshots: phase, percent, resource counters and page-declared task counts. Use it for progress bars, job status rows and CI logs.

## How it works

1. `renderContentToFile()` creates a `RenderProgressReporter` for the output file. Without a callback the reporter does nothing.
2. `RenderProgressReporter.attach(page)` counts the page's `request`, `requestfinished` and `requestfailed` events and reads its `console` lines.
3. Each phase change (`starting`, `preparing`, `loading`, `rendering`, `done`, `failed`) emits a snapshot immediately.
4. Resource events and in-page task lines emit at most every 150 ms. During `loading` and `rendering` a heartbeat re-emits every 750 ms.
5. The callback is called fire-and-forget: it is never awaited, and a thrown error or rejected promise is swallowed.
6. `dispose()` stops the heartbeat and detaches the listeners when the render ends.

| Phase | Percent band | Default `message` |
| --- | --- | --- |
| `starting` | 0 | `Starting renderer` |
| `preparing` | 10 | `Preparing HTML` (template compile happens here) |
| `loading` | 15 to 80 | `Loading resources (N done, M pending, K failed)`, or `<task> done/total, ...` |
| `rendering` | 80 | `Generating output` (`page.pdf()`) |
| `done` | 100 | `Done` |
| `failed` | last percent | The error message |

In `loading`, the percent comes from page-declared tasks when any arrived, else from `loaded / (loaded + pending)` capped at half the band (48 %). The percent never goes down.

## Configuration

None. Progress is per call: `IRenderOptions.onProgress` for `renderToFile()` and `Templates`, `options.onProgress` for `renderHtmlToFile()`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Progress callback | `RenderProgressCallback`, per call | none | `cliProgressReporter()` from `@spinajs/templates` | Pass your own function |
| In-page task protocol | Console lines starting with `__spinajs_progress__:` (`PAGE_PROGRESS_PREFIX`) | none | none | Log `__spinajs_progress__:{"task":"<name>","done":N,"total":M}` from page scripts |

### In-page task protocol: exact progress for script-driven pages

The request ratio cannot know how many images a script will still request. A page script that declares its own work makes the `loading` percent exact. Lines that are not valid JSON, have an empty `task`, or a negative or non-numeric `done` / `total` are ignored. Several tasks add up.

```ts sample
import { DI } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { IRenderProgress } from '@spinajs/templates';

// a gallery page that loads its photos from script and reports each one
function catalogueHtml(photos: string[]): string {
  return `<!doctype html><html><body><div id="grid"></div>
<script>
  const photos = ${JSON.stringify(photos)};
  let done = 0;
  const report = () => console.log('__spinajs_progress__:' + JSON.stringify({ task: 'photos', done, total: photos.length }));
  report();
  for (const src of photos) {
    const img = new Image();
    img.onload = img.onerror = () => { done++; report(); };
    img.src = src;
    document.getElementById('grid').appendChild(img);
  }
</script></body></html>`;
}

export async function printCatalogue(photos: string[]): Promise<void> {
  const renderer = await DI.resolve(PdfRenderer, [{ format: 'A4', printBackground: true }]);
  try {
    await renderer.renderHtmlToFile(catalogueHtml(photos), './storage/catalogue.pdf', {
      assetBasePath: './storage/photos',
      onProgress: (p: IRenderProgress) => {
        const photosTask = p.tasks?.photos;
        console.log(`${p.percent}% ${p.phase} ${photosTask ? `${photosTask.done}/${photosTask.total}` : p.message ?? ''}`);
      },
    });
  } finally {
    await renderer.dispose();
  }
}
```

## Important behaviour

- `setContent()` waits for the page's `load` event. Images a script adds after `load` may still be missing from the PDF; report them with the protocol and wait for them in the page, or override `performRender()` to wait (see [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md)).
- Snapshots are throttled; do not count callback calls to count resources. Read `resourcesLoaded`, `resourcesPending` and `resourcesFailed`.
- A slow callback cannot slow the render, and its errors are lost. Log inside the callback if you need them.
- `failed` keeps the last percent and carries the error message in `message`.
- The heartbeat timer is `unref()`-ed and never keeps the process alive.

## Best practices

- Write the progress to your job row or socket from the callback without awaiting; the renderer does not wait anyway.
- Use `tasks` for anything a page script controls (lazy images, charts drawn after data fetch); the request counters cannot see work that has not started.

## Examples

### Show a progress bar in a console script

```ts sample
import { DI } from '@spinajs/di';
import { Templates, cliProgressReporter } from '@spinajs/templates';
import '@spinajs/templates-pdf';

export async function printPriceList(): Promise<void> {
  const templates = await DI.resolve(Templates);

  // TTY: one live line; piped / CI: one line per phase
  await templates.renderToFile('./templates/price-list/price-list.pdf', { season: '2026/27' }, './out/price-list.pdf', 'en', {
    onProgress: cliProgressReporter(),
  });

  await DI.dispose();
}
```

## Related

- [Rendering PDFs](01-rendering-pdfs.md): the steps each phase covers.
- [`@spinajs/queue-templates-pdf` progress reporting](../queue-templates-pdf/04-progress-reporting.md): the same snapshots relayed to a queue job row.
- [`@spinajs/templates`](../templates/README.md): `IRenderProgress`, `RenderPhase`, `IRenderOptions` and `cliProgressReporter()`.
