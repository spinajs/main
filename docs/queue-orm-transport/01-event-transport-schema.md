# Event transport schema

The package ships one migration and three models for a database event queue. None of them is exported, so no application can run the migration or query the models. This page describes them so you can reuse the design or finish the package.

## How it works

The planned flow, read from the commented-out `QueueOrmTransport` in `src/index.ts`:

1. `QueueOrmTransport.resolve()` loads the `Subscriber` row named after the connection (`Options.name`) and inserts it when missing.
2. `QueueOrmTransport.dispatch()` inserts an `Event` row with the message JSON in `Value`, then links it to the subscriber through `Subscriber.Events.add()`, which writes a `Queue` junction row. It resolves `false` on any error.
3. `QueueOrmTransport.subscribe()` starts a `setInterval` timer (`queue.orm_transport.TickInterval`, default `1000` ms). Each tick passes every linked event to the callback and sets `Ack` on its `Queue` row. A callback error is logged as a warning.

None of these steps runs: the class is commented out and targets an older `QueueClient` contract (`dispatch()`, `subscribe(callback)`). The current contract is `emit()`, `subscribe(channel, callback)` and `unsubscribe()`; see [Database-backed transport](02-database-backed-transport.md).

## Configuration

The package config file `src/config/queueOrmTransport.ts` exports an empty object. `@spinajs/configuration` loads it from `node_modules/@spinajs/*/lib/config` like every package config, and it adds no key.

The commented-out transport reads one key:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.orm_transport.TickInterval` | `number` | `1000` | milliseconds | Poll interval of the planned `subscribe()` loop. Not read by any live code. |

The models and the migration bind to a connection named `orm-event-transport`. The package test configuration declares it like this:

```ts
db: {
  DefaultConnection: 'orm-event-transport',
  Connections: [
    {
      Driver: 'orm-driver-sqlite',
      Filename: ':memory:',
      Name: 'orm-event-transport',
      Migration: { Table: 'orm_migrations', OnStartup: true },
    },
  ],
},
```

## Schema

`OrmEventTransportInitial_2022_06_28_01_13_00` is decorated `@Migration('orm-event-transport')`. Its `down()` drops all four tables.

### `orm_event_transport__event`

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `int`, primary key, auto increment | Event key. |
| `Type` | `string`, not null | Message type, mapped by `Event.Type`. |
| `CreatedAt` | `dateTime`, default now | Insert time. |
| `Value` | `text` | Message body as JSON. |

### `orm_event_transport__subscribers`

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `int`, primary key, auto increment | Subscriber key. |
| `Name` | `string(32)`, not null, unique | Connection name of the consumer. |
| `LastAck` | `dateTime`, not null, default now | Last acknowledgement time. No model property maps it. |

### `orm_event_transport__queue`

Junction table between subscribers and events. Its primary key is the pair of both key columns.

| Column | Type | Meaning |
| --- | --- | --- |
| `orm_event_transport__subscribers_Id` | `int`, not null, primary key | Subscriber key. |
| `orm_event_transport__event_Id` | `int`, not null, primary key | Event key. |
| `Ack` | `dateTime` | Acknowledgement time; `NULL` while pending. |

### `orm_event_transport__job`

No model maps this table and no planned code writes it.

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `int`, primary key, auto increment | Job key. |
| `Type` | `string`, not null | Job type. |
| `Value` | `text`, not null | Job body. |
| `Result` | `text` | Job result. |
| `CreatedAt` | `dateTime`, not null, default now | Insert time. |
| `FinishedAt` | `dateTime` | Finish time; `NULL` until the job finishes. |

### Models

All three are `ModelBase` subclasses decorated `@Connection('orm-event-transport')`.

| Model | Table | Properties |
| --- | --- | --- |
| `Event` | `orm_event_transport__event` | `@Primary() Id`, `Type`, `@CreatedAt() CreatedAt: DateTime`, `@Json() Value` |
| `Subscriber` | `orm_event_transport__subscribers` | `@Primary() Id`, `Name`, `@HasManyToMany(Queue, Event) Events: ManyToManyRelationList<Event, Subscriber>` |
| `Queue` | `orm_event_transport__queue` | `@BelongsTo('Event') Event: SingleRelation<Event>`, `@BelongsTo('Subscriber') Subscriber: SingleRelation<Subscriber>`, `Ack: DateTime \| null` |

## Services and extension points

The package registers nothing in DI: no `@Injectable`, no `DI.register()` call, no exported class. There is nothing to replace or extend through the container. The extension point a database queue uses is `QueueClient` from `@spinajs/queue`, covered in [Database-backed transport](02-database-backed-transport.md).

## Important behaviour

- The migration never runs. `Orm` finds migrations through `system.dirs.migrations` or through classes registered by an `import`; this package provides neither. See [Migrations](../orm/10-migrations.md).
- The `Queue` model declares no `@Primary()` property, so the ORM cannot update or delete one `Queue` row by key, although the table has one.
- `package.json` lists no dependency on `@spinajs/queue`; only the commented-out transport needs it.

## Best practices

- Do not depend on this package for message delivery: emitted messages go nowhere. Configure a working transport in `queue.connections`, such as `@spinajs/queue-stomp-transport`, or a custom `QueueClient`.
- When you reuse this schema, map the junction key columns on the `Queue` model with `@Primary()` so single rows can be acknowledged through the ORM.

## Related

- [Database-backed transport](02-database-backed-transport.md): a working replacement built on the current `QueueClient` contract.
- [Migrations](../orm/10-migrations.md): how `Orm` discovers and runs migrations.
- [Relations](../orm/06-relations.md): `@HasManyToMany`, `@BelongsTo` and `ManyToManyRelationList`, as the models use them.
