# @spinajs/queue-templates-pdf

A SpinaJS queue job that renders a PDF template in an **isolated worker process**
and reports render progress (percent + phase + message) back to the queue.

All heavy, crash-prone work — Chromium, template compilation, upload — runs in a
forked worker. The job in the queue consumer only supervises it, so a hung or
crashing render can never take down the worker, and memory is reclaimed per render.

## Installation

```bash
npm install @spinajs/queue-templates-pdf
```

Requires a configured queue (transport + DB for the job model) and at least one
`@spinajs/fs` provider for the output.

## Usage

```ts
import { scheduleRenderPdf } from '@spinajs/queue-templates-pdf';

// render now
await scheduleRenderPdf({
  input: 'invoices/invoice.pug', // a template (template: true) or raw HTML
  template: true,
  model: { total: 42 },
  lang: 'en',
  output: { provider: 's3', path: 'invoices/2026/1.pdf' }, // any @spinajs/fs provider
  pdfOptions: { format: 'A4', printBackground: true },
});

// render in 5 minutes
await scheduleRenderPdf(payload, { delay: 5 * 60 * 1000 });

// recurring: every day at 06:00
await scheduleRenderPdf(payload, { cron: '0 6 * * *' });
```

The job must be consumed by a queue worker:

```ts
import { RenderPdfJob } from '@spinajs/queue-templates-pdf';
const queue = await DI.resolve(QueueService);
await queue.consume(RenderPdfJob);
```

## Output

`output: { provider, path }` names a configured `@spinajs/fs` provider (local,
temp, S3, ...) and a path relative to it. The worker renders to a local temp file
and uploads it to that provider, so the same job works for local disk or object
storage without change.

## Progress

The worker streams progress; the supervisor forwards it to the queue job model:

- **percent** 0–100 (phase-weighted),
- **phase** — `starting` → `preparing` → `loading` → `rendering` → `done` (or `failed`),
- **message** — e.g. `Loading resources (12 done, 3 pending)`.

With `@spinajs/queue-http-progress` this is exposed at:

```
GET jobs/v1/:jobId/status
-> { jobId, progress, phase, message, status, createdAt }
```

`scheduleRenderPdf` (and `RenderPdfJob.emit`) return the generated `jobId`, so you
can hand it straight to the status endpoint:

```ts
const jobId = await scheduleRenderPdf(payload);
// later: GET jobs/v1/${jobId}/status
```

## Worker configuration

The worker re-bootstraps the app configuration by default (it runs in the app's
config environment: same config sources / cwd, so it resolves the same
`templates.pdf` launch args and fs providers). For environments where that is not
possible, pass an inline `config` object in the payload and the worker will
bootstrap from it instead.

## How it works

```
scheduleRenderPdf ─► RenderPdfJob (queue consumer)
                       │  fork()
                       ▼
                     render-worker (separate process)
                       ├─ bootstrap config/DI
                       ├─ Templates.render (template mode) ─► HTML
                       ├─ PdfRenderer.renderHtmlToFile ──── onProgress ─┐
                       └─ fs provider.upload(tmp → output.path)         │
                       ▲                                                │
   progress(percent, {phase, message}) ◄── IPC ◄─────────────────────-─┘
   (persisted to the job model, exposed over HTTP)
```
