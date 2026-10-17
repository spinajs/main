# Custom worker entry

The shipped worker loads only `@spinajs/fs` and `@spinajs/templates-pdf`. Write your own worker script when renders need more in the child process: remote fs providers (`@spinajs/fs-s3`, `@spinajs/fs-ftp`), other template engines, a replaced `PdfRenderer`, or the command-line flags the app was started with. Fork it from a `RenderPdfJob` subclass.

## How it works

1. Your `RenderPdfJob` subclass overrides `spawnWorker()` and returns `fork(<your worker>.js, args, options)`.
2. `superviseChild()` sends the `IRenderRequest` over IPC, as for the shipped worker.
3. Your worker imports the packages it needs, which registers their services in its container, and registers any replacements.
4. It listens with `process.on('message')`, calls `renderPdfToProvider(req, onProgress)` and sends every progress message to the parent.
5. It sends `{ type: 'done', result }` or `{ type: 'error', message }`, calls `DI.dispose()` and exits.

A worker can do the render any way it likes; the parent only needs the `WorkerMessage` protocol:

| Rule | Why |
| --- | --- |
| Send exactly one `done` or `error` | The first one settles the job; later messages are ignored |
| Exit after it | The parent forks a new process per render; a worker left running holds Chromium and memory |
| Send `progress` with a `phase` | Each one is written to the job row |
| Finish within the job's `timeoutMs` | Otherwise the parent kills it with `SIGKILL` |
| Exit only after `done` or `error` | Any exit before that fails the job with `exited unexpectedly` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Worker process | `RenderPdfJob.spawnWorker()`, called once per render | `fork(<package lib>/render-worker.js)` with no arguments | Your script; another runtime that speaks IPC | Override `spawnWorker()` in a subclass registered as `RenderPdfJob` or consumed under its own name |
| Render core | `renderPdfToProvider()` | config bootstrap, compile, render, upload | Your own render code | Call it from your worker, or replace it entirely and keep the protocol |
| Worker container | the child's root `DI` container | services from `@spinajs/fs` and `@spinajs/templates-pdf` | Any package you import | Import packages and register replacements at the top of the worker; see [Worker services](07-worker-services.md) |

### Worker that writes to S3 and compiles Handlebars

```ts sample
// src/workers/pdf-worker.ts, compiled to dist/workers/pdf-worker.js
import '@spinajs/fs-s3';
import '@spinajs/templates-handlebars';
import { DI } from '@spinajs/di';
import { IRenderRequest, renderPdfToProvider, WorkerMessage } from '@spinajs/queue-templates-pdf';

function send(message: WorkerMessage): void {
  process.send?.(message);
}

process.on('message', async (req: IRenderRequest) => {
  try {
    const result = await renderPdfToProvider(req, (progress) => send(progress));
    send({ type: 'done', result });
    await DI.dispose();
    process.exit(0);
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    await DI.dispose().catch(() => undefined);
    process.exit(1);
  }
});
```

### Fork it with the app's command-line flags

`FrameworkConfiguration` reads `--app`, `--apppath` and `--env` from `process.argv`. Pass the parent's arguments on, so the worker loads the same configuration as the app.

```ts sample
import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { DI, NewInstance } from '@spinajs/di';
import { Job, QueueService } from '@spinajs/queue';
import { RenderPdfJob } from '@spinajs/queue-templates-pdf';

const PDF_WORKER = join(process.cwd(), 'dist', 'workers', 'pdf-worker.js');

@NewInstance()
@Job()
class AppRenderPdfJob extends RenderPdfJob {
  protected spawnWorker(): ChildProcess {
    return fork(PDF_WORKER, process.argv.slice(2), {
      env: { ...process.env, UV_THREADPOOL_SIZE: '8' },
      execArgv: ['--max-old-space-size=1024'],
    });
  }
}

DI.register(AppRenderPdfJob).as(RenderPdfJob);

async function startPdfConsumer(): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume(RenderPdfJob);
}
```

## Important behaviour

- `spawnWorker()` runs in the consumer for every render. Keep it cheap: no file checks or network calls.
- The worker's container starts empty. Only what the worker imports, and what `renderPdfToProvider()` imports, is registered.
- `fork()` inherits the parent's working directory, environment and `execArgv` unless you pass them. Passing `execArgv` replaces the inherited one, so add any loader flags the app needs (eg. for TypeScript) yourself.
- A worker that never sends `done` or `error` and never exits is killed by the parent's timer.
- An uncaught exception in your worker exits it; the parent reports `Render worker exited unexpectedly with code 1`, without the error text. Catch errors and send `error` instead.

## Best practices

- Start from the shipped worker's shape (the first sample) and add imports above it; keep the protocol handling as is.
- Import every package whose provider class appears in `fs.providers`, not only the output provider's: the worker creates all of them.
- Set `--max-old-space-size` in `execArgv` for large documents; the worker's memory is freed when it exits.

## Patterns and antipatterns

```ts
// Don't: let errors escape; the job only sees "exited unexpectedly with code 1"
process.on('message', async (req: IRenderRequest) => {
  send({ type: 'done', result: await renderPdfToProvider(req, send) });
  process.exit(0);
});

// Do: report the error text, dispose, then exit
process.on('message', async (req: IRenderRequest) => {
  let code = 0;
  try {
    send({ type: 'done', result: await renderPdfToProvider(req, send) });
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    code = 1;
  }
  await DI.dispose().catch(() => undefined);
  process.exit(code);
});
```

## Examples

### Worker that draws a "DRAFT" watermark on non-production renders

```ts sample
// src/workers/draft-pdf-worker.ts
import { DI, PerInstanceCheck } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { IRenderRequest, renderPdfToProvider, WorkerMessage } from '@spinajs/queue-templates-pdf';
import { Page } from 'puppeteer';

@PerInstanceCheck()
class DraftPdfRenderer extends PdfRenderer {
  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.addStyleTag({
      content: 'body::after { content: "DRAFT"; position: fixed; top: 40%; left: 15%; font-size: 140px; opacity: 0.12; transform: rotate(-30deg); }',
    });
    await super.performRender(page, filePath);
  }
}

if (process.env.APP_ENV !== 'production') {
  DI.register(DraftPdfRenderer).as(PdfRenderer);
}

function send(message: WorkerMessage): void {
  process.send?.(message);
}

process.on('message', async (req: IRenderRequest) => {
  try {
    send({ type: 'done', result: await renderPdfToProvider(req, send) });
    await DI.dispose();
    process.exit(0);
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    await DI.dispose().catch(() => undefined);
    process.exit(1);
  }
});
```

## Related

- [Worker services](07-worker-services.md): what to register in the worker and how each service is resolved.
- [Extending `RenderPdfJob`](05-extending-render-pdf-job.md): registering the subclass that forks your worker.
- [Job supervision](02-job-supervision.md#the-ipc-protocol): the message shapes.
- [`@spinajs/fs` custom providers](../fs/06-custom-providers.md): providers your worker may need to import.
