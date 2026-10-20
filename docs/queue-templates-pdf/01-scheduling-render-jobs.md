# Scheduling render jobs

`scheduleRenderPdf()` enqueues a `RenderPdfJob`: render a PDF now, after a delay, on a cron schedule or periodically. It returns the job id, which you hand to the status endpoint to follow the render.

## How it works

1. `scheduleRenderPdf(payload, options)` copies only the schedule options you set into a `Partial<IMessageOptions>`: `delay` to `ScheduleDelay`, `cron` to `ScheduleCron`, `period` to `SchedulePeriod`, `repeat` to `ScheduleRepeat`.
2. It calls `RenderPdfJob.emit(payload, scheduleOptions)`. `QueueJob.emit()` builds the message: `Persistent: true`, the payload fields, `Type: 'JOB'`, `CreatedAt: now`, `Name: 'RenderPdfJob'`, then the schedule options.
3. `QueueService.emit()` picks the connections from `queue.routing.RenderPdfJob` (or `queue.default`), generates a `JobId` (UUID v4) and sends the message to each connection.
4. It returns the `JobId`. It returns `undefined` only when no connection was used.
5. A consumer that called `QueueService.consume(RenderPdfJob)` receives the message, creates the `queue_jobs` row, hydrates a `RenderPdfJob` with the payload and runs [`execute()`](02-job-supervision.md).

The broker applies the schedule fields. Whether a transport supports `ScheduleCron`, `SchedulePeriod` and `ScheduleRepeat` depends on the transport; see [`@spinajs/queue`](../queue/README.md).

## Payload: `IRenderPdfJobPayload`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `input` | `string` | required | Template path (when `template: true`) or a raw HTML string |
| `template` | `boolean` | `undefined` (raw HTML) | `true`: `input` is a template, compiled by the engine that matches its extension |
| `model` | `unknown` | `undefined` | Model passed to the template (template mode only) |
| `lang` | `string` | `undefined` | Language passed to the template (template mode only); the engine falls back to the ambient, then the default language |
| `output.provider` | `string` | required | Name of an `@spinajs/fs` provider configured in `fs.providers` |
| `output.path` | `string` | required | Destination path, relative to that provider's base |
| `pdfOptions` | `Record<string, unknown>` | `{}` | Puppeteer `page.pdf()` options: `format`, `landscape`, `margin`, `printBackground`, `scale` |
| `assetBasePath` | `string` | the OS temp directory | Directory served over the renderer's local HTTP server, so relative URLs (`img/logo.png`) resolve |
| `config` | `unknown` | `undefined` | Inline configuration merged into the worker's configuration; see [Render worker](03-render-worker.md#configuration-modes) |
| `timeoutMs` | `number` | `120000` | Time after which the supervisor kills the worker and fails the job |

`RenderPdfJob.emit()` takes `Partial<RenderPdfJob>`, so it also accepts queue fields `scheduleRenderPdf()` does not: `RetryCount`, `Priority`, `Persistent`, `JobId`.

## Schedule options: `IScheduleRenderPdfOptions`

| Option | Type | Message field | Meaning |
| --- | --- | --- | --- |
| `delay` | `number` (ms) | `ScheduleDelay` | Wait before the broker delivers the message |
| `cron` | `string` | `ScheduleCron` | Cron entry for a recurring render, eg. `0 6 * * *` |
| `period` | `number` (ms) | `SchedulePeriod` | Time between repeats, used with `repeat` |
| `repeat` | `number` | `ScheduleRepeat` | Number of repeats |

## Configuration

This package has no configuration keys of its own. Scheduling uses the queue keys:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.routing.RenderPdfJob` | `string \| IMessageRoutingOption \| (string \| IMessageRoutingOption)[]` | none: `queue.default` | `{ connection, channel, deadLetterChannel }` | Connection and channel `RenderPdfJob` messages go to |
| `queue.default` | `string` | none | a connection name | Connection used when the job has no routing entry |

```ts
// config/queue.ts: send PDF renders to their own job connection
export default {
  queue: {
    default: 'jobs',
    routing: {
      RenderPdfJob: { connection: 'pdf-jobs', deadLetterChannel: '/queue/pdf-dead' },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `QueueService` | `QueueService`, singleton | `DefaultQueueService` (`@spinajs/queue`) | none shipped | See [`@spinajs/queue`](../queue/README.md) |
| The job class | `RenderPdfJob`, resolved by `consume()` | `RenderPdfJob` | Your subclass | `DI.register(MyJob).as(RenderPdfJob)`; see [Extending `RenderPdfJob`](05-extending-render-pdf-job.md) |

`scheduleRenderPdf()` always emits a message named `RenderPdfJob`. A subclass registered as `RenderPdfJob` receives those messages; a subclass consumed under its own name needs `MyJob.emit()` instead.

## Important behaviour

- Jobs are persistent by default (`Persistent: true`); pass `Persistent: false` to `RenderPdfJob.emit()` to opt out.
- The `JobId` exists before any consumer sees the job. The `queue_jobs` row is written by the consumer on first receipt, so a status request right after scheduling can answer 404 until then.
- The whole payload travels through the broker and is stored with the message. Keep `model` and `config` to what the render needs.
- `scheduleRenderPdf()` sends no `RetryCount`, so a failed render is not retried: the job row goes to `dead` on the first failure.
- With `queue.deduplicate` left at `true`, a redelivered message whose row is already `success` or `dead` is acknowledged without rendering again.

## Best practices

- Store the returned `JobId` with the business record (invoice, report) so a client can ask for the status later.
- Use `RenderPdfJob.emit({ ...payload, RetryCount: 2 })` when renders may fail on transient errors, eg. a remote image host.
- Route `RenderPdfJob` to its own connection when PDFs are slow, so they do not hold up short jobs.
- Make `output.path` unique per render (a number, a date, the job's business key). Two renders to one path overwrite each other.

## Patterns and antipatterns

```ts
// Don't: render in the HTTP request; Chromium blocks the API process and a crash takes it down
await pdfRenderer.renderHtmlToFile(html, '/tmp/invoice.pdf');

// Do: enqueue and return the job id at once
const jobId = await scheduleRenderPdf({ input: html, output: { provider: 'documents', path: 'invoices/1042.pdf' } });
```

## Examples

### Render a monthly statement for every customer at 06:00 on the 1st

```ts sample
import { scheduleRenderPdf } from '@spinajs/queue-templates-pdf';

async function scheduleMonthlyStatement(customerId: number): Promise<void> {
  await scheduleRenderPdf(
    {
      input: 'templates/statements/monthly.pug',
      template: true,
      model: { customerId },
      output: { provider: 'documents', path: `statements/${customerId}/latest.pdf` },
      pdfOptions: { format: 'A4', printBackground: true },
    },
    { cron: '0 6 1 * *' },
  );
}
```

### Retry a render twice and give it five minutes

```ts sample
import { RenderPdfJob } from '@spinajs/queue-templates-pdf';

async function renderCatalogue(season: string): Promise<string | undefined> {
  return RenderPdfJob.emit({
    input: 'templates/catalogue/catalogue.pug',
    template: true,
    model: { season },
    output: { provider: 'documents', path: `catalogues/${season}.pdf` },
    assetBasePath: 'templates/catalogue',
    timeoutMs: 5 * 60 * 1000,
    RetryCount: 2,
  });
}
```

### Send a reminder PDF in 15 minutes

```ts sample
import { scheduleRenderPdf } from '@spinajs/queue-templates-pdf';

async function scheduleReminder(orderNo: string, html: string): Promise<string | undefined> {
  return scheduleRenderPdf(
    { input: html, output: { provider: 'documents', path: `reminders/${orderNo}.pdf` } },
    { delay: 15 * 60 * 1000 },
  );
}
```

## Related

- [Job supervision](02-job-supervision.md): what runs when the consumer receives the message.
- [Progress reporting](04-progress-reporting.md): following the returned `JobId`.
- [`@spinajs/queue`](../queue/README.md): emit, consume, routing, retries and the `queue_jobs` row.
