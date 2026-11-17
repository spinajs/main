# Transactional outbox

The outbox is being built up over several releases of 4.x. What works so far: the `queue.outbox` configuration is validated at boot, and with `queue.outbox.enabled` set to `true` the `queue_outbox` table is created on every database that `queue.outbox.connections` names. Nothing writes to the table or publishes from it yet; `emit()` still sends straight to the broker.

## Configuration

The outbox is off by default. Every key under `queue.outbox`, with its default from `OUTBOX_DEFAULTS`:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.outbox.enabled` | `boolean` | `false` | Turns the outbox on: the `queue_outbox` table is created on every connection in `connections`. |
| `queue.outbox.relay` | `boolean` | `true` | Whether this process runs the relay that publishes outbox rows; emit-only replicas set `false`. |
| `queue.outbox.connections` | `string[]` | `['default']` | The ORM connections that hold the business transactions whose messages go through the outbox. At least one. |
| `queue.outbox.mode` | `'when-in-transaction'` \| `'always'` | `'when-in-transaction'` | When an emit goes through the outbox: only inside a transaction, or always. |
| `queue.outbox.tick` | `number` (ms) | `1000` | Time between two relay passes; at least `10`. |
| `queue.outbox.batchSize` | `number` | `100` | Rows one relay pass reads at most; `1` to `1000`. |
| `queue.outbox.claimTtl` | `number` (ms) | `30000` | How long a relay's claim on a row holds; at least `1000`. |
| `queue.outbox.maxPublishMs` | `number` (ms) | `10000` | How long one publish is expected to take at most; a pass stops before a row its claim can no longer cover. An estimate, not a timeout. Must be below `claimTtl`. |
| `queue.outbox.maxAge` | duration | `'24h'` | A row whose publish still fails once it is this old (counted from its creation) becomes `dead`; younger rows are retried. Above zero. |
| `queue.outbox.backoff.backoff` | `'fixed'` \| `'exponential'` | `'exponential'` | How the wait between two failed publishes of a row grows. |
| `queue.outbox.backoff.delay` | duration | `'1s'` | The first wait after a failed publish. |
| `queue.outbox.backoff.maxDelay` | duration | `'5m'` | The longest wait of an exponential backoff. |
| `queue.outbox.retention` | duration | `'7d'` | How long a published row is kept before it is deleted. |

```ts
// config/queue.ts
export default {
  db: { DefaultConnection: 'orders' },
  queue: {
    outbox: {
      enabled: true,
      connections: ['orders', 'billing'],
      maxAge: '12h',
      backoff: { backoff: 'exponential', delay: '2s', maxDelay: '10m' },
    },
  },
};
```

`connections` names ORM connections as `db.Connections`, `db.DefaultConnection` (as `default`) and `db.Aliases` know them. `default` and aliases are resolved first, so two names of one database (`default` and the connection it points at, or an alias and its target) give one table, created once. `connections` has its default only in code, never in a shipped configuration file, because configuration arrays from several sources are concatenated.

The schema checks every value at boot. Beyond that, the values of a disabled outbox are not checked: an empty `connections` list or `maxPublishMs` above `claimTtl` fails the boot only once `enabled` is `true`.

A duration (`maxAge`, `retention`, `backoff.delay`, `backoff.maxDelay`) is a whole number of milliseconds or a string with a unit: `500ms`, `10s`, `5m`, `2h`, `30d`, `1w`. A numeric string such as `'86400000'` is read as milliseconds. Anything else (`null`, `true`, an empty string, `1.5`, a word) fails the boot. Zero: `maxAge` must be above zero; `retention: 0` keeps no published row, each is deleted by the first purge after it was published; `backoff.delay: 0` retries on the next pass.

**Unknown keys under `queue.outbox` are dropped by the configuration validator, without an error or a log line.** A misspelt key therefore has no effect: check the spelling against the table above when a setting seems to be ignored.

Outbox times are database time, which `@spinajs/durable` reads from the ORM connection `default`: an app that enables the outbox sets `db.DefaultConnection`.
