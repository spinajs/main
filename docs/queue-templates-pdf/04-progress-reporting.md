# Progress reporting

A render reports a percent (0 to 100), a phase and a message. The worker sends them over IPC, the supervisor writes them to the job's `queue_jobs` row, and [`@spinajs/queue-http-progress`](../queue-http-progress/README.md) serves them at `GET jobs/v1/:jobId/status`. A page can drive the percent itself with console lines.

## How it works

1. `PdfRenderer.renderHtmlToFile()` creates a `RenderProgressReporter` (`@spinajs/templates-puppeteer`) with the worker's `onProgress` callback.
2. The reporter emits a snapshot on every phase change, on finished and failed page requests, on page progress lines, and every 750 ms during `loading` and `rendering`. Non-phase emissions are throttled to one per 150 ms.
3. `renderPdfToProvider()` maps each snapshot to `{ type: 'progress', percent, phase, message }` and the worker sends it to the parent.
4. `RenderPdfJob` calls the queue's `progress(percent, { phase, message })` without awaiting it.
5. The queue's progress callback sets `Phase` and `Message` on the job row and writes the row. A call with a phase is never throttled.
6. When the job succeeds the queue sets `Progress = 100` and `Status = 'success'`.

## Phases and percent bands

| Phase | Percent | Default message | Starts when |
| --- | --- | --- | --- |
| `starting` | 0 | `Starting renderer` | The renderer begins: asset server, pooled browser, new page |
| `preparing` | 10 | `Preparing HTML` | The page is set up, before the content is set |
| `loading` | 15 to 80 | `Loading resources (<n> done, <n> pending, <n> failed)`, or `<task> <done>/<total>, ...` | `page.setContent()` starts; images, fonts and stylesheets load |
| `rendering` | 80 | `Generating output` | `page.pdf()` runs |
| `done` | 100 | `Done` | The PDF file is written |
| `failed` | the last percent | the error message | The render threw |

- The percent never goes down.
- In `loading`, without page progress lines, the percent is `loaded / (loaded + pending)` of the band, capped at half of it (15 to 48).
- With page progress lines, the percent is the exact `sum(done) / sum(total)` across all tasks, mapped onto 15 to 80.
- The renderer's `done` comes before the upload. The job row reaches `success` only after the upload and the worker's `done` message.
- Nothing is reported while the worker starts, bootstraps configuration or compiles the template.

## Job row fields

| Column | Written by | Meaning |
| --- | --- | --- |
| `Progress` | each progress call, throttled; `100` on success | Last percent |
| `Phase` | each progress call | Last phase, eg. `loading` |
| `Message` | each progress call with a message | Last message |
| `Status` | the queue | `created`, `executing`, `success`, `retrying`, `dead` |
| `Result` | the queue, on success | The `IRenderOutput`: `{ provider, path }` |
| `LastError` | the queue, on failure | The worker's error message, or the timeout or exit message |

See the [`queue_jobs` table](../queue-http-progress/01-job-status-route.md#queue_jobs) and the [status response](../queue-http-progress/01-job-status-route.md#response-ijobstatusresponse).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.progress.minDelta` | `number` | `5` | percent points | Throttle for percent-only writes; render progress always carries a phase, so it is written on each call |
| `queue.progress.minInterval` | `number` (ms) | `1000` | ms | See `minDelta` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Page progress protocol | console lines `__spinajs_progress__:<json>` read by `RenderProgressReporter` | request counting | Your page's own task counts | Log protocol lines from a script in the page; see below |
| Progress relay | `RenderPdfJob.superviseChild()` | forwards every message | Your mapping | Override `superviseChild()` and wrap the `progress` callback; see [Extending `RenderPdfJob`](05-extending-render-pdf-job.md) |
| Progress source in the worker | the `onProgress` argument of `renderPdfToProvider()` | sends each message to the parent | Your worker | Send extra `progress` messages from a [custom worker entry](06-custom-worker-entry.md) |

### Report progress from the page

A page that builds content in a script (charts, a long table filled from data) knows its real progress better than the request count. Log one line per update:

```
__spinajs_progress__:{"task":"charts","done":3,"total":12}
```

- `task`: a non-empty string; several tasks are summed.
- `done`, `total`: finite numbers, `>= 0`; `done` above `total` counts as `total`.
- A malformed line is ignored. The message becomes `charts 3/12, ...`.

```ts sample
import { scheduleRenderPdf } from '@spinajs/queue-templates-pdf';

function salesReportHtml(regions: string[]): string {
  const sections = regions.map((r) => `<section data-region="${r}"></section>`).join('');

  return `<!doctype html><html><body>${sections}
<script>
  const sections = document.querySelectorAll('section[data-region]');
  sections.forEach((section, i) => {
    section.innerHTML = '<h2>' + section.dataset.region + '</h2><canvas width="600" height="300"></canvas>';
    console.log('__spinajs_progress__:' + JSON.stringify({ task: 'regions', done: i + 1, total: sections.length }));
  });
</script></body></html>`;
}

async function renderSalesReport(): Promise<string | undefined> {
  return scheduleRenderPdf({
    input: salesReportHtml(['North', 'South', 'East', 'West']),
    output: { provider: 'documents', path: 'reports/sales-q3.pdf' },
    pdfOptions: { format: 'A4', landscape: true },
  });
}
```

## Important behaviour

- Progress is best effort: a failed write of a progress row is logged and the render goes on.
- The `failed` phase keeps the last percent; the row then gets `Status = 'retrying'` or `'dead'` and `LastError`.
- Progress lines are read from the page console, so they need JavaScript in the page; Puppeteer runs page scripts by default.
- A render that stalls in `loading` keeps sending the same percent and message: the heartbeat repeats the last value, so the row's `Phase` stays `loading`.

## Best practices

- Poll the status endpoint every one to two seconds; the worker emits more often than that, and the row holds only the last value.
- Use page progress lines for script-built documents, so the bar reflects the work and not the number of requests.
- Show `message` next to the bar: it tells the user what is loading.

## Patterns and antipatterns

```ts
// Don't: treat percent 100 as "file is ready"; the renderer reaches 100 before the upload
if (status.progress === 100) download(status.result);

// Do: wait for the job status
if (status.status === 'success') download(status.result);
```

## Examples

### Poll a render from the browser

```ts sample
interface IPdfJobStatus {
  jobId: string;
  status: 'created' | 'executing' | 'success' | 'retrying' | 'dead' | 'error';
  progress: number;
  phase?: string;
  message?: string;
  error?: string;
  result?: { provider: string; path: string };
}

async function waitForPdf(jobId: string, onUpdate: (s: IPdfJobStatus) => void): Promise<IPdfJobStatus> {
  for (;;) {
    const response = await fetch(`/jobs/v1/${jobId}/status`, { credentials: 'include' });

    if (response.status !== 404) {
      const body = (await response.json()) as IPdfJobStatus;
      onUpdate(body);

      if (body.status === 'success' || body.status === 'dead') {
        return body;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
```

A 404 right after scheduling means the consumer has not created the row yet, or the caller may not read the job.

## Related

- [Job supervision](02-job-supervision.md): where progress messages are relayed.
- [`@spinajs/queue-http-progress`](../queue-http-progress/README.md): the status endpoint and its access rule (`job:read`).
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): `RenderProgressReporter` and the progress protocol.
