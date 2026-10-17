# `@spinajs/queue-orm-transport`

A planned `@spinajs/queue` transport that keeps queue messages in database tables through `@spinajs/orm`, for tests and small projects without a message broker.

It does **not** work today. The transport class in `src/index.ts` is commented out, so the package entry exports nothing (`export {}`). Installing or importing it registers no service, no model and no migration.

## Status

| Part | In the source | Reachable by a user |
| --- | --- | --- |
| Transport class `QueueOrmTransport` | Commented out in `src/index.ts` | No |
| Models `Event`, `Queue`, `Subscriber` | `src/models/` | No: not exported, and `package.json` `exports` blocks deep imports |
| Migration `OrmEventTransportInitial_2022_06_28_01_13_00` | `src/migrations/` | No: not exported, so `Orm` never discovers it |
| Package config `queueOrmTransport` | `src/config/queueOrmTransport.ts` | Loaded by `@spinajs/configuration`, but it is an empty object |

To keep queue messages in a database today, write your own `QueueClient`. [Database-backed transport](02-database-backed-transport.md) shows a complete one.

## Install

```sh
npm install @spinajs/queue-orm-transport
```

## Features

| Feature | What it does |
| --- | --- |
| [Event transport schema](01-event-transport-schema.md) | The tables, models and migration the package ships in source; none of them are active. |
| [Database-backed transport](02-database-backed-transport.md) | How to build the transport this package plans, as a custom `QueueClient` registered in DI. |

## Related packages

- [`@spinajs/queue`](../queue/README.md): defines `QueueClient`, the base class every transport extends, and `QueueService`, which resolves transports from `queue.connections`.
- [`@spinajs/orm`](../orm/README.md): models, migrations and connections a database transport is built on.
- [`@spinajs/orm-sqlite`](../orm-sqlite/README.md): the driver the package's own test configuration uses (`orm-driver-sqlite`, in-memory file).
