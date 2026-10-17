# `@spinajs/queue-templates-pdf`

A queue job, `RenderPdfJob`, that renders a PDF from a template or raw HTML in a forked worker process, uploads it to an `@spinajs/fs` provider and reports progress (percent, phase, message) to the queue job row.

The job in the queue consumer only supervises the worker. Chromium, template compilation and the upload run in the child process, so a crash or hang there never takes the consumer down, and the worker's memory is freed after every render.

It does **not** configure a queue, a template engine or a file provider: it uses the ones your app configures. It does **not** expose HTTP routes; [`@spinajs/queue-http-progress`](../queue-http-progress/README.md) serves the job status.

## Install

```sh
npm install @spinajs/queue-templates-pdf
```

It needs a configured queue (a transport and the `queue_jobs` table, see [`@spinajs/queue`](../queue/README.md)), an `fs` section with at least one provider (see [`@spinajs/fs`](../fs/README.md)) and a Chromium that Puppeteer can launch (see [`@spinajs/templates-pdf`](../templates-pdf/README.md)).

## Features

| Feature | What it does |
| --- | --- |
| [Scheduling render jobs](01-scheduling-render-jobs.md) | `scheduleRenderPdf()` and `RenderPdfJob.emit()`: render now, later, on a cron or periodically; the payload fields; consuming the job |
| [Job supervision](02-job-supervision.md) | `RenderPdfJob.execute()`: forks the worker, relays progress, enforces the timeout, maps worker failures to job failures |
| [Render worker](03-render-worker.md) | The child process and `renderPdfToProvider()`: config bootstrap, template or raw HTML render, upload to the output provider |
| [Progress reporting](04-progress-reporting.md) | Phases and percent bands, the IPC progress messages, the job row and the in-page task protocol |
| [Extending `RenderPdfJob`](05-extending-render-pdf-job.md) | Subclass the job and register it in DI: request defaults, failure alerts, a per-delivery instance |
| [Custom worker entry](06-custom-worker-entry.md) | Fork your own worker script: load extra fs providers and template engines, forward CLI flags, speak the `WorkerMessage` protocol |
| [Worker services](07-worker-services.md) | The DI services the worker resolves (`PdfRenderer`, `Templates`, fs providers, `Configuration`) and how to replace each |

## Extension points at a glance

| Extension point | DI token and lifetime | Default | Page |
| --- | --- | --- | --- |
| The job class | `RenderPdfJob`, resolved by `QueueService.consume()` per delivery; singleton unless the class says otherwise | `RenderPdfJob` | [Extending `RenderPdfJob`](05-extending-render-pdf-job.md) |
| Worker process | `RenderPdfJob.spawnWorker()` (protected) | `fork()` of the shipped `render-worker.js` | [Custom worker entry](06-custom-worker-entry.md) |
| Worker request | `RenderPdfJob.buildRequest()` (protected) | the job's payload fields | [Extending `RenderPdfJob`](05-extending-render-pdf-job.md#add-defaults-to-every-request) |
| Render core | `renderPdfToProvider()` (function) | used by the shipped worker | [Render worker](03-render-worker.md) |
| PDF renderer | `PdfRenderer`, `PerInstanceCheck` per `pdfOptions`, resolved in the worker | `PdfRenderer` (`@spinajs/templates-pdf`) | [Worker services](07-worker-services.md#pdfrenderer-custom-implementation) |
| Output provider | `'__file_provider__'` factory, by `output.provider` name | providers from `fs.providers` | [Worker services](07-worker-services.md#output-provider-any-fs-backend) |
| Template engine | `TemplateRenderer`, chosen by file extension | Pug (`@spinajs/templates-pug`) | [Worker services](07-worker-services.md#template-engines-beyond-pug) |
| Worker configuration | `Configuration`, singleton | `FrameworkConfiguration`, or an inline `config` from the payload | [Worker services](07-worker-services.md#worker-configuration) |
| Page-driven progress | console lines `__spinajs_progress__:{...}` from the page | resource counting | [Progress reporting](04-progress-reporting.md#report-progress-from-the-page) |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';
import { RenderPdfJob, scheduleRenderPdf } from '@spinajs/queue-templates-pdf';

// In the consumer process: execute RenderPdfJob messages.
async function startPdfConsumer(): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume(RenderPdfJob);
}

// Anywhere in the app: enqueue a render and keep the id for the status endpoint.
async function issueInvoicePdf(invoiceNo: string, total: number): Promise<string | undefined> {
  return scheduleRenderPdf({
    input: 'templates/invoices/invoice.pug',
    template: true,
    model: { invoiceNo, total },
    lang: 'en',
    output: { provider: 'documents', path: `invoices/${invoiceNo}.pdf` },
    assetBasePath: 'templates/invoices',
    pdfOptions: { format: 'A4', printBackground: true },
  });
}
```

## Related packages

- [`@spinajs/queue`](../queue/README.md): `QueueJob`, `QueueService.consume()`, the job row and its progress throttling.
- [`@spinajs/queue-http-progress`](../queue-http-progress/README.md): `GET jobs/v1/:jobId/status`, the read side of the progress this job writes.
- [`@spinajs/templates-pdf`](../templates-pdf/README.md): `PdfRenderer`, the `templates.pdf` config the worker reads.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): the render pipeline, phases and the in-page progress protocol.
- [`@spinajs/templates`](../templates/README.md): `Templates.render()`, which compiles the template in template mode.
- [`@spinajs/fs`](../fs/README.md): the output providers the PDF is uploaded to.
- [`@spinajs/configuration`](../configuration/README.md): how the worker loads its configuration.
