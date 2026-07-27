# DTO relations

`@Relation` marks a DTO field as a **reference to a database entity**. On an incoming request the
field's value is looked up, and the field is replaced with the resolved model instance — so the
route body arrives with real entities rather than bare ids you then have to fetch.

## Declaring one

```ts sample
import { Schema } from '@spinajs/validation';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Relation } from '@spinajs/orm-http';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Uuid: string;

  public Email: string;
}

@Schema({
  type: 'object',
  $id: 'app.CampaignDTO',
  properties: {
    Name: { type: 'string' },
    author: { type: 'string' },
  },
})
export class CampaignDTO {
  public Name?: string;

  /** Incoming: a Uuid string. Delivered to the route: a User instance. */
  @Relation(() => User, { by: 'Uuid' })
  public author?: string | User;

  constructor(data: Partial<CampaignDTO>) {
    Object.assign(this, data);
  }
}
```

The target is a **thunk** — `() => User`, not `User` — so the DTO can reference a model without
an import cycle and without needing the class to exist at decoration time.

`IRelationOptions.by` names the column to look up on. It defaults to the target's primary key.

## Using it

```ts sample
import { BaseController, BasePath, Post, Ok, Body } from '@spinajs/http';
import { Schema } from '@spinajs/validation';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Relation } from '@spinajs/orm-http';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Uuid: string;
}

@Schema({
  type: 'object',
  $id: 'app.CreateCampaign',
  properties: {
    Name: { type: 'string' },
    author: { type: 'string' },
  },
  required: ['Name', 'author'],
})
export class CreateCampaign {
  public Name: string;

  @Relation(() => User, { by: 'Uuid' })
  public author: User;

  constructor(data: Partial<CreateCampaign>) {
    Object.assign(this, data);
  }
}

@BasePath('campaigns')
export class CampaignController extends BaseController {
  /**
   * POST /campaigns  { "Name": "Spring", "author": "3f2a..." }
   *
   * `dto.author` is already a User row — no lookup here, and a bad Uuid
   * became a 404 before this method ran.
   */
  @Post()
  public create(@Body() dto: CreateCampaign) {
    return new Ok({ Name: dto.Name, AuthorId: dto.author.Id });
  }
}
```

## How resolution works

`RelationResolverHydrator` is registered as the DTO's `custom:arg_hydrator` by the decorator
itself — **unless one is already set**, so an explicit `@Hydrator(...)` on the class wins.

For each declared relation field, in parallel:

1. `undefined` or `null` → skipped. An optional field is simply absent; a *required* one was
   already rejected upstream by `@Schema` validation.
2. Otherwise `target.where({ [by]: value }).firstOrThrow(new OrmNotFoundException(...))`.
3. The field is overwritten with the resolved model.

A miss produces `OrmNotFoundException` with the message
`<Model> referenced by '<field>' not found`, which `OrmNotFound` renders as `404`.

## `@Schema` is mandatory

A DTO using `@Relation` **must** declare a `@Schema`, enforced once per class at first hydration:

```
DTO X uses @Relation but has no @Schema. All DTOs with @Relation must declare a @Schema.
```

The reason is the null-skipping rule above: resolution treats an absent field as optional, so
required-ness has to be expressed — and enforced — by the schema. Without one, a missing required
reference would slip through as `undefined`.

The check result is memoised in a `WeakSet`, so it costs nothing after the first request.

## Composite keys

A DTO relation field carries one value, so a target with a composite primary key must name a
single lookup column via `by`:

```
model X has a composite primary key (A, B); set `by` on the relation to select a single lookup column
```

## Inheritance

Relation descriptors are stored through `getInheritedDescriptor`, so a subclass inherits its
parent's `@Relation` fields. The documented pattern is to inherit the relations and ship a
stricter schema:

```ts sample
import { Schema } from '@spinajs/validation';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Relation } from '@spinajs/orm-http';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Uuid: string;
}

@Schema({
  type: 'object',
  $id: 'app.CampaignBase',
  properties: {
    Name: { type: 'string' },
    author: { type: 'string' },
  },
})
export class CampaignDTO {
  public Name?: string;

  @Relation(() => User, { by: 'Uuid' })
  public author?: User;

  constructor(data: Partial<CampaignDTO>) {
    Object.assign(this, data);
  }
}

/** Same relation, inherited; only the schema changes. */
@Schema({
  type: 'object',
  $id: 'app.CampaignStrict',
  properties: {
    Name: { type: 'string' },
    author: { type: 'string' },
  },
  required: ['author'],
})
export class StrictCampaignDTO extends CampaignDTO {}
```

## Storing a resolved relation on a model

The ORM's `DbPropertyHydrator` translates a `ModelBase` arriving on a foreign-key column into its
primary key, and `OneToOneRelationHydrator` accepts a model instance under a relation name. So a
resolved DTO relation can be handed straight to `hydrate`:

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Uuid: string;
}

@Connection('default')
@Model('campaigns')
export class Campaign extends ModelBase<Campaign> {
  @Primary()
  public Id: number;

  public author_id: number;

  public Name: string;

  @BelongsTo(User, 'author_id', 'Id')
  public Author: SingleRelation<User>;
}

export async function persist(name: string, author: User) {
  const campaign = new Campaign({ Name: name });

  // Either works: the FK column receives the model's key,
  campaign.hydrate({ author_id: author } as unknown as Partial<Campaign>);
  // or the relation receives the model itself.
  campaign.Author.attach(author);

  await campaign.insert();
  return campaign;
}
```

## The metadata key

Descriptors live on the DTO prototype under `Symbol.for('orm-http:relations')`, exported as
`RELATION_SYMBOL`. It is a **global** symbol deliberately, so `@spinajs/http-swagger` can read it
to document the endpoint without importing this package.

```ts sample
import { RELATION_SYMBOL, IDtoRelations } from '@spinajs/orm-http';
import 'reflect-metadata';

export function relationsOf(ctor: any): IDtoRelations | undefined {
  return Reflect.getMetadata(RELATION_SYMBOL, ctor.prototype) as IDtoRelations | undefined;
}
```

Each entry is an `IDtoRelationDescriptor`: `{ field, target, by? }`.

## When to use which

| Situation | Approach |
| --- | --- |
| A route parameter identifying the resource | `@FromModel()` |
| A body field referencing another entity | `@Relation()` on the DTO |
| A body that *is* the entity | `@AsModel()` or `@Body()` typed as the model |
