# Extending `RenderPdfJob`

Subclass `RenderPdfJob` to change what every render does without touching callers: add request defaults, alert on failures, inject services, fork another worker. Register the subclass as `RenderPdfJob` to take over all render messages, or give it its own name to run beside the default job.

## How it works

1. `QueueService.consume(RenderPdfJob)` subscribes to messages named `RenderPdfJob`.
2. For each delivery it calls `DI.resolve(RenderPdfJob)`. The container returns the class last registered under `RenderPdfJob`, or `RenderPdfJob` itself.
3. The instance is hydrated with the message (`Object.assign`) and its `execute()` runs, which calls the overridable members below.
4. A subclass with its own `@Job()` name is consumed and emitted on its own: `consume(ContractPdfJob)`, `ContractPdfJob.emit(...)`, routing key `queue.routing.ContractPdfJob`.

## Overridable members

| Member | Visibility | Called | Default | Override to |
| --- | --- | --- | --- | --- |
| `buildRequest(): IRenderRequest` | protected | once per `execute()`, after the worker is forked | copies `input`, `template`, `model`, `lang`, `output`, `pdfOptions`, `assetBasePath`, `config` | add defaults, rewrite paths, inject per-tenant config |
| `spawnWorker(): ChildProcess` | protected | once per `execute()` | `fork()` of the shipped `render-worker.js` | fork your own worker, pass arguments, env or `execArgv`; see [Custom worker entry](06-custom-worker-entry.md) |
| `superviseChild(child, progress): Promise<IRenderOutput>` | protected | once per `execute()` | timer, progress relay, settle-once | wrap the `progress` callback or the result |
| `execute(progress): Promise<unknown>` | public | by the queue | `superviseChild(spawnWorker(), progress)` | run code before or after the whole render, eg. mark a record as ready |
| `onFailed(err, ctx): Promise<void>` | public, from `QueueJob` | by the queue after each failed attempt | no-op | alert, clean up; `ctx.isFinal` marks the last attempt |
| `Log` | protected | | logger `RenderPdfJob` | use it in your overrides |

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Job(opts?)` | class | `{ runAs?: 'initiator' \| 'system' }` | Marks the class as a job. `RenderPdfJob` uses `@Job()` with no `runAs`. A subclass needs its own `@Job()` for its own `runAs`: the options are read from the message class's **own** metadata |
| `@NewInstance()` | class | none | A fresh instance per delivery; see [Important behaviour](#important-behaviour) |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| The job class | `RenderPdfJob`; resolved per delivery; `@NewInstance()`, a subclass needs its own `@NewInstance()` | `RenderPdfJob` | Your subclass | Replace: `DI.register(MyJob).as(RenderPdfJob)` before `consume()`. Run beside it: own `@Job()` class, `consume(MyJob)`, `MyJob.emit()` |

### Add defaults to every request

Override `buildRequest()`, call `super.buildRequest()` and fill what the caller left out. Register the subclass as `RenderPdfJob` so messages from `scheduleRenderPdf()` use it.

```ts sample
import { join } from 'path';
import { DI, NewInstance } from '@spinajs/di';
import { Job, QueueService } from '@spinajs/queue';
import { IRenderRequest, RenderPdfJob } from '@spinajs/queue-templates-pdf';

const BRAND_ASSETS = join(process.cwd(), 'templates', 'brand');

@NewInstance()
@Job()
class BrandedRenderPdfJob extends RenderPdfJob {
  protected buildRequest(): IRenderRequest {
    const request = super.buildRequest();

    return {
      ...request,
      assetBasePath: request.assetBasePath ?? BRAND_ASSETS,
      pdfOptions: {
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '18mm', left: '15mm', right: '15mm' },
        ...request.pdfOptions,
      },
    };
  }
}

DI.register(BrandedRenderPdfJob).as(RenderPdfJob);

async function startPdfConsumer(): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume(RenderPdfJob);
}
```

### Alert on the final failed attempt

`onFailed()` runs after every failed attempt; `ctx.isFinal` is `true` when the job is marked `dead`. Errors thrown from it are logged and never replace the render error.

```ts sample
import { Autoinject, DI, NewInstance, Singleton } from '@spinajs/di';
import { IJobFailureContext, Job } from '@spinajs/queue';
import { RenderPdfJob } from '@spinajs/queue-templates-pdf';

@Singleton()
class OpsChannel {
  public async post(text: string): Promise<void> {
    await fetch('https://hooks.example.com/ops-alerts', { method: 'POST', body: JSON.stringify({ text }) });
  }
}

@NewInstance()
@Job()
class AlertingRenderPdfJob extends RenderPdfJob {
  @Autoinject()
  protected Ops: OpsChannel;

  public async onFailed(err: unknown, ctx: IJobFailureContext): Promise<void> {
    if (!ctx.isFinal) {
      return;
    }

    const reason = err instanceof Error ? err.message : String(err);
    await this.Ops.post(`PDF ${this.output.provider}:${this.output.path} failed after ${ctx.attempt} attempts: ${reason}`);
  }
}

DI.register(AlertingRenderPdfJob).as(RenderPdfJob);
```

### Run a second job type beside the default

A subclass with its own name gets its own routing, its own consumer and its own defaults, and leaves `RenderPdfJob` as it is.

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { Job, QueueService } from '@spinajs/queue';
import { IRenderRequest, RenderPdfJob } from '@spinajs/queue-templates-pdf';

@NewInstance()
@Job({ runAs: 'initiator' })
class ContractPdfJob extends RenderPdfJob {
  protected buildRequest(): IRenderRequest {
    return { ...super.buildRequest(), pdfOptions: { format: 'A4', printBackground: true, displayHeaderFooter: true } };
  }
}

async function startContractConsumer(): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume(ContractPdfJob);
}

async function renderContract(contractNo: string): Promise<string | undefined> {
  return ContractPdfJob.emit({
    input: 'templates/contracts/contract.pug',
    template: true,
    model: { contractNo },
    output: { provider: 'contracts', path: `${contractNo}.pdf` },
    assetBasePath: 'templates/contracts',
    timeoutMs: 3 * 60_000,
  });
}
```

## Important behaviour

- `RenderPdfJob` is `@NewInstance()`, so every delivery gets its own object. `hydrate()` only assigns the fields present in the message, so a subclass registered without `@NewInstance()` becomes a singleton and keeps the previous job's `template`, `config`, `assetBasePath` and `timeoutMs`. Put `@NewInstance()` on your subclass.
- Repeat `@NewInstance()` on every subclass: a subclass with its own `@Autoinject` or `@Inject` gets the singleton default, not its parent's lifetime.
- `scheduleRenderPdf()` always emits `RenderPdfJob`. A subclass under its own name needs `MySubclass.emit()`; a message named `ContractPdfJob` is never handled by `consume(RenderPdfJob)`.
- Register the replacement before `consume()`. A registration added later applies from the next delivery, since the class is resolved per delivery.
- The queue stores the `Name` from the message, so a replacement registered as `RenderPdfJob` still shows `RenderPdfJob` in `queue_jobs.Name`.
- `buildRequest()` runs in the consumer; the request it returns crosses the IPC channel as JSON.

## Best practices

- Prefer `buildRequest()` over changing payloads at every call site: defaults in one place, callers stay small.
- Use a named subclass when a document kind needs its own routing, retries or `runAs`; use a replacement when every render needs the change.
- Keep `onFailed()` short and non-throwing; it runs inside the consumer.

## Patterns and antipatterns

```ts
// Don't: subclass without @NewInstance(); deliveries share one instance and stale fields leak into the next render
@Job()
class BrandedRenderPdfJob extends RenderPdfJob {}

// Do
@NewInstance()
@Job()
class BrandedRenderPdfJob extends RenderPdfJob {}
```

```ts
// Don't: override execute() and forget the supervision; the worker is never forked or never killed
public async execute() { return this.buildRequest(); }

// Do: wrap super.execute()
public async execute(progress: JobProgressCallback) {
  const result = await super.execute(progress);
  await this.Invoices.markPdfReady(this.model);
  return result;
}
```

## Examples

### Mark an invoice ready when its PDF is uploaded

```ts sample
import { Autoinject, DI, NewInstance, Singleton } from '@spinajs/di';
import { Job, JobProgressCallback } from '@spinajs/queue';
import { IRenderOutput, RenderPdfJob } from '@spinajs/queue-templates-pdf';

@Singleton()
class InvoiceRegistry {
  protected ready = new Map<string, IRenderOutput>();

  public async markPdfReady(invoiceNo: string, output: IRenderOutput): Promise<void> {
    this.ready.set(invoiceNo, output);
  }
}

@NewInstance()
@Job()
class InvoicePdfJob extends RenderPdfJob {
  @Autoinject()
  protected Invoices: InvoiceRegistry;

  public async execute(progress: JobProgressCallback): Promise<unknown> {
    const output = (await super.execute(progress)) as IRenderOutput;
    const { invoiceNo } = this.model as { invoiceNo: string };

    await this.Invoices.markPdfReady(invoiceNo, output);
    return output;
  }
}

DI.register(InvoicePdfJob).as(RenderPdfJob);
```

## Related

- [Job supervision](02-job-supervision.md): what `execute()`, `spawnWorker()` and `superviseChild()` do.
- [Custom worker entry](06-custom-worker-entry.md): overriding `spawnWorker()`.
- [`@spinajs/di` lifetimes](../di/04-lifetimes.md): `@NewInstance()` and inherited lifetimes.
- [`@spinajs/queue`](../queue/README.md): `@Job`, `onFailed()`, routing and retries.
