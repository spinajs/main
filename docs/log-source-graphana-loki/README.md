# `@spinajs/log-source-graphana-loki`

A `@spinajs/log` target that batches log entries and pushes them to Grafana Loki over HTTP (`POST /loki/api/v1/push`), with retry, a bounded buffer and a drop hook for fallbacks.

It does **not** query Loki, create Loki tenants or ship a Promtail-style file tailer. It only pushes entries your loggers write. The package and DI names use the spelling `Graphana`.

## Install

```sh
npm install @spinajs/log-source-graphana-loki
```

Import the package once (for its side effect) so its target class registers in DI under `GraphanaLogTarget`.

## Features

| Feature | What it does |
| --- | --- |
| [Loki target](01-loki-target.md) | The `GraphanaLogTarget` log target: config, labels, stream grouping, the push request. |
| [Delivery, retry and buffering](02-delivery-and-retry.md) | Batching, retry with backoff and `Retry-After`, the buffer cap, drop hook and flushing. |
| [Extending the Loki target](03-extending-the-loki-target.md) | Subclass or replace `GraphanaLokiLogTarget`: custom HTTP client, retry policy, payload, instance identity. |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Log } from '@spinajs/log';
import '@spinajs/log-source-graphana-loki';

class AppConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'Loki',
            type: 'GraphanaLogTarget',
            options: {
              host: 'http://loki:3100',
              labels: { app: 'billing-api' },
            },
          },
        ],
        rules: [{ name: '*', level: 'info', target: 'Loki' }],
      },
    };
  }
}

async function main() {
  DI.register(AppConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  const log = DI.resolve(Log, ['billing']);
  log.info({ invoiceId: 'INV-1042' }, 'Invoice ${invoiceId} paid');

  // Push what is buffered now instead of waiting for the 3 s tick.
  await log.flush();
}

void main();
```

## Related packages

- [`@spinajs/log`](../log/README.md): the logger, rules, wrapper targets (`FallbackGroupTarget`) and the `LogTarget` contract this target implements.
- [`@spinajs/log-common`](../log-common/README.md): `LogTarget`, `BatchQueue` and the layout `format()` used to render each line.
- [`@spinajs/util`](../util/README.md): `ResiliencePipelineBuilder`, the retry engine behind every push.
- [`@spinajs/di`](../di/04-lifetimes.md#iinstancecheck-one-instance-per-option-set): the `@PerInstanceCheck()` lifetime the target uses.
- [`@spinajs/log-otlp`](../log-otlp/README.md): the OTLP target with the same batching and retry model.
