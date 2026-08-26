# ORM unified dirty tracking — design

Date: 2026-08-25
Status: approved design, awaiting implementation plan
Packages: `@spinajs/orm` (core change), `@spinajs/orm-sqlite` (tests), `@spinajs/rbac-http-token` (unchanged consumer), yourscreen-backend `common` / `features` / `backend` (consumer)

## 1. Problem

`ModelBase` answers "what changed on this model" with three mechanisms that disagree with each other:

| Mechanism | State | Written by | Read by |
|---|---|---|---|
| Dirty flag + list | `__is_dirty__`, `__dirty_props__` | Proxy `set` trap (`model.ts:26-38`), `markDirty()`, `SingleRelation.attach()`, `metadata.ts:127` | `toSql(onlyDirty)`, `relationDirtyColumns()`, `Relation._update()` gate |
| Snapshot | `__snapshot__` | `builders.ts:149`, `update()`, `subject-executor.ts` | `changedColumns()`, `classify()`, subject-builder relation diffs |
| Persisted? | implicit: `Snapshot === null` | — | `subject-builder.ts:339` |

Defects that follow from that split:

1. `__dirty_props__` is imprecise: a column written `A → B → A` is dirty; comparison is `!==`, so a `DateTime` re-created from the same ISO string is dirty.
2. The Proxy trap is blind to in-place mutation (`group.field_rules.push(x)`): no `set` fires, nothing is dirty. Only the snapshot diff catches it.
3. `insert()` and `refresh()` reset `IsDirty` but never re-baseline. `insert()` then `update()` on one instance emits a full-row UPDATE; `refresh()` leaves the baseline stale.
4. `Snapshot === null` means both "no baseline" and "not persisted". Defect 3 makes the overload visible.
5. `relationDirtyColumns()` is `protected` and `__dirty_props__` is private, so a foreign key re-pointed through `attach()` is invisible to any code outside the class.
6. `IsDirty` and `changedColumns()` give different answers for the same edit; `update()` already trusts only the latter (`model.ts:743`).
7. `IsDirty = false` is a public reset that does not refresh the baseline — the model claims clean while the snapshot says dirty.
8. `insert()` runs its reset before the query executes (`query.values()` returns the thenable builder; the caller awaits it).

The motivating consumer, yourscreen-backend entity history, worked around all of this with `_dto_changes()` — a hand-rolled JSON-shape diff of a DTO against the live model, which must be called before `hydrate()` and reads the old value off the live entity (wrong for a JSON column mutated in place).

## 2. Goals and non-goals

Goals:

- One mechanism: the snapshot is the only state; every answer is derived from it on demand.
- Every persist path and every read path ends by re-baselining. Nothing else touches the snapshot.
- A public `changeSet()` that yields old and new values, so a consumer can record history without a private diff of its own.
- Delete the Proxy.
- yourscreen-backend records entity history from `changeSet()`, drops `_dto_changes` and its own `IChangeValue`.

Non-goals:

- Memoising the diff. Without a write observer there is no invalidation signal; a cache would go stale on in-place mutation, which is the bug class being removed.
- Fixing the pre-existing inconsistency between `populate()` (joins on `Relation.PrimaryKey`) and `toSql()` (writes `Value.PrimaryKeyValue`) for `@BelongsTo` on a non-primary-key column. The diff follows `toSql()` because the diff decides what is written. Consequence for such a relation only: `populate()` leaves `Value.PrimaryKeyValue` unequal to the foreign-key baseline, so the owner reports that key as changed after a read — the write `toSql()` would already perform on any update, now visible in the diff. For the normal case (join column is the target's primary key) `populate()` stays a pure read: the loaded target's key equals the baseline, and `relation-populate.test.ts` keeps asserting that.
- Changing relation-membership baselines (`snapshotRelation`, `IRelationDelta`). They stay as they are.
- A backwards-compatibility shim. Decision: clean cut, one change, tests rewritten.

## 3. ORM design

### 3.1 State and public API

One private field on `ModelBase`:

```ts
/**
 * Diff baseline: a value copy of every persisted column, taken when the row was last
 * read from or written to the database. `null` means the row has never been in the
 * database, which is what classifies it as an INSERT.
 */
private __snapshot__: IModelSnapshot | null = null;
```

Deleted: `__is_dirty__`, `__dirty_props__`, `MODEL_PROXY_HANDLER`, the `new Proxy(this, ...)` return in the constructor, `markDirty()`, `relationDirtyColumns()`, `changedColumns()`, the `IsDirty` setter.

Public API (`IModelBase` in `interfaces.ts` updated to match):

| Member | Semantics |
|---|---|
| `get IsNew(): boolean` | `Snapshot === null` |
| `get IsDirty(): boolean` | `IsNew \|\| diff(true).length > 0`. No setter. Short-circuits on the first differing column. |
| `changeSet(): IModelChange[]` | Every persisted column whose live value differs from the baseline, in descriptor column order, followed by any `@BelongsTo` foreign key whose relation was re-pointed without a column write. On an `IsNew` model: every column, `OldValue: undefined`. |
| `Snapshot`, `takeSnapshot()`, `snapshotRelation(name)`, `clearSnapshot()` | Unchanged. `takeSnapshot()` stays public — `rbac-http-token` `narrowRoles()` depends on it. |

New exported interface in `snapshot.ts` (re-exported from `index.ts`):

```ts
/** One column-level difference between a model's baseline and its current values. */
export interface IModelChange {
  Column: string;
  OldValue: unknown;
  NewValue: unknown;
}
```

The key names `Column` / `OldValue` / `NewValue` are fixed: yourscreen-backend persists this shape as JSON in `entity_change.changes` and its frontend reads the keys by name.

Semantic change to call out: `IsDirty` is `true` on a brand-new model. Today a fresh `new Model()` is not dirty until a column is written and `Relation._update()` compensates with `PK === null || undefined`. The one definition is now "dirty = `save()` would write something".

Constructor after the change:

```ts
constructor(data?: Partial<M>) {
  this.setDefaults();
  if (data) {
    this.hydrate(data as any);
  }
}
```

Verified nothing else depends on the Proxy: no `isProxy` checks, the identity map keys by primary-key string, `metadata.ts:105` is a separate Proxy on `MetadataRelation` and stays.

### 3.2 The diff

One private method computes everything; `IsDirty` and `changeSet()` are views over it.

```ts
/** The single diff. `stopAtFirst` lets IsDirty short-circuit. */
private diff(stopAtFirst: boolean): IModelChange[] {
  const columns = this.snapshotColumns();            // persisted, non-Virtual — existing helper
  const snap = this.__snapshot__?.Columns;
  const out: IModelChange[] = [];

  for (const c of columns) {
    const current = (this as any)[c.Name];
    if (!snap || !snapshotEquals(snap.get(c.Name), current, c.Converter)) {
      out.push({ Column: c.Name, OldValue: baselineValue(snap?.get(c.Name)), NewValue: current });
      if (stopAtFirst) return out;
    }
  }

  // A @BelongsTo re-pointed via SingleRelation.attach() writes no column: toSql() materialises
  // the foreign key from Value.PrimaryKeyValue at write time, so it is derived the same way here.
  for (const [, r] of this.ModelDescriptor?.Relations ?? []) {
    if (r.Type !== RelationType.One || !r.ForeignKey) continue;
    if (out.some((x) => x.Column === r.ForeignKey)) continue;   // a column write already caught it

    const rel = (this as any)[r.Name];
    if (!rel || rel.Value === undefined) continue;                // never attached, never populated

    const target = rel.Value === null ? null : rel.Value.PrimaryKeyValue;
    const converter = columns.find((c) => c.Name === r.ForeignKey)?.Converter;

    if (!snap || !snapshotEquals(snap.get(r.ForeignKey), target, converter)) {
      out.push({ Column: r.ForeignKey, OldValue: baselineValue(snap?.get(r.ForeignKey)), NewValue: target });
      if (stopAtFirst) return out;
    }
  }

  return out;
}

public get IsNew(): boolean { return this.__snapshot__ === null; }
public get IsDirty(): boolean { return this.IsNew || this.diff(true).length > 0; }
public changeSet(): IModelChange[] { return this.diff(false); }
```

`baselineValue()` is a small exported helper in `snapshot.ts` that maps the `UNCOPYABLE` marker to `undefined` so the Symbol never leaks into a change record; the column is still reported (the marker is never equal to anything), so the write is never lost.

Decisions baked in:

- Foreign-key value is `Value.PrimaryKeyValue` whenever the relation holds a target, matching `StandardModelToSqlConverter` (`converters.ts:151`), and it overrides a direct column write — the diff must agree with the write path, and the write path lets the relation win. A relation holding `null` or `undefined` decides nothing; the column is authoritative.
- Cascade insert still works: an attached but unsaved target has `PrimaryKeyValue === undefined`, unequal to any baseline, so the foreign key is reported changed — which is what `runUpdates` in `subject-executor.ts` relies on.
- Amended during execution (Task 3 review): `SingleRelation.attach(obj)` also writes the owner's foreign-key column — the target's key, or `null` on detach — and `toSql()` writes `NULL` for a detached relation (`Value === null`) instead of falling back to the raw column. Without this a detach was never persisted and, with the diff driving `update()`, the relation (`null`) and the column/snapshot (old id) disagreed forever. A `populate()` that finds no row leaves the column untouched, so a read never becomes a change.
- Primary-key columns are included in `changeSet()`. `update()` filters them from the SET list as today.
- Cost: `IsDirty` on a clean hydrated model is one `snapshotEquals` per column (`===` for scalars, `_.isEqual` for JSON). Same work `classify()` already does per model on every `save()`.

### 3.3 Persist and read paths

Rule: a persist path re-baselines after the statement ran; a read path re-baselines after hydration; nothing else touches the snapshot.

| Site | Today | After |
|---|---|---|
| `model.ts:26-38`, `:605` | `MODEL_PROXY_HANDLER`, `new Proxy(...)` | deleted |
| `model.ts:73-95` | `__is_dirty__`, `IsDirty` get/set, `__dirty_props__` | `get IsDirty()` derived; `get IsNew()` added |
| `model.ts:279-318`, `:333-339` | `changedColumns()`, `relationDirtyColumns()`, `markDirty()` | replaced by `diff()`, `changeSet()` |
| `model.ts:637`, `:664` `attach()` | `markDirty(fk)`, `IsDirty = true` | lines deleted — `Value` is the signal |
| `model.ts:694-699` `toSql(onlyDirty)` | `_.pick(vals, __dirty_props__)` | `_.pick(vals, this.changeSet().map((c) => c.Column))` |
| `model.ts:718` `destroy()` | `IsDirty = false` | line deleted; snapshot untouched |
| `model.ts:730-735` `archive()` | writes all columns, no reset | `takeSnapshot()` after the awaited write |
| `model.ts:757-790` `update()` | `union(changedColumns, relationDirtyColumns)`; `IsDirty = false` twice | `changeSet().map(...)`; `IsDirty` lines deleted; existing `takeSnapshot()` stays |
| `model.ts:846-851` `insert()` | `result = query.values(...); IsDirty = false; return result` | `result = await query.values(...); takeSnapshot(); return result` |
| `model.ts:913-923` `refresh()` | `IsDirty = false` | `takeSnapshot()` |
| `builders.ts:143` | `IsDirty = false` before `takeSnapshot()` | line deleted |
| `subject-executor.ts:92`, `:117` | `IsDirty = false` before `takeSnapshot()` | lines deleted |
| `subject-builder.ts:128` | `model.changedColumns()` | `model.changeSet().map((c) => c.Column)` |
| `subject-builder.ts:339-343` `classify()` | `Snapshot === null` / `changedColumns().length` | `IsNew` / `IsDirty` |
| `relation-objects.ts:339-343` `SingleRelation.attach()` | `markDirty(fk)` / `IsDirty = true` | `this.Value = obj` and the owner's foreign-key column set to the target's key or `null` |
| `converters.ts:149-157` `toSql()` One branch | null `Value` falls back to the raw column | `Value` target → its key; raw column when non-null; `NULL` when the relation is detached |
| `relation-objects.ts:709` `Relation._update()` gate | `IsDirty \|\| PK null \|\| PK undefined` | `IsDirty` |
| `metadata.ts:127` | `x.Value = value; x.IsDirty = true` | second line deleted |
| `interfaces.ts:822-844` `IModelBase` | `IsDirty` writable, `changedColumns()`, `markDirty()` | `readonly IsDirty`, `readonly IsNew`, `changeSet()` |
| `snapshot.ts`, `index.ts` | — | `IModelChange` added and exported |
| `rbac-http-token/src/middlewares.ts:160` | `takeSnapshot()` | unchanged |
| `unit-of-work.ts` | `clearSnapshot()`, direct `snapshotEquals` | unchanged |

`insert()` must await before re-baselining: the `afterQuery` middleware backfills an auto-generated primary key during execution, and a snapshot taken earlier would miss it and leave `IsDirty === true` after every insert (defect 8).

Accepted loss: `SingleRelation.attach()` on a `RelationType.Query` relation (no foreign-key column) used to set `IsDirty = true`. With no column behind it that flag never produced a write. Documented in `07-relations.md`.

### 3.4 Edge cases

- Statement fails → no re-baseline. `takeSnapshot()` runs only after the awaited query resolved, so a thrown UPDATE/INSERT leaves the model dirty and a retry writes the same columns.
- `takeSnapshot()` on a never-persisted model makes `IsNew === false`; `save()` would then emit an UPDATE for a row that does not exist. Pre-existing footgun, now also behind `IsNew`. Stays public, guarded by the doc comment only.
- `UNCOPYABLE` baseline: reported on every diff, `OldValue: undefined`.
- `update(data)` hydrates first, then diffs — unchanged. `UpdatedAt` is added after the change set is computed and lands in the post-write snapshot — unchanged.
- `insert()` with `InsertOrUpdate`: no `RETURNING`; the key is backfilled from `LastInsertId` only when missing. The snapshot is taken after that middleware ran.
- In-place JSON mutation is caught by the deep-cloned baseline and `_.isEqual`. This is now the only path that catches it.
- Docs carry cost guidance: call `changeSet()` once and reuse rather than polling `IsDirty` in a loop over large JSON models.

### 3.5 Documentation

- `orm/docs/05-instance-api.md`: constructor note (no Proxy), "Dirty tracking and snapshots" rewritten around `IsNew` / `IsDirty` / `changeSet()`, `update()`, `insert()`, `refresh()`, `archive()`, `toSql(onlyDirty)`.
- `orm/docs/07-relations.md`: `attach()` row, `update()` row, the populate note at `:494`, the Query-relation loss.
- `orm/docs/08-unit-of-work.md`: classification table (`IsNew` / `IsDirty`), the `changedColumns()` mention at `:354`.
- `orm/docs/12-architecture.md:46`: hydration line.
- `RELEASE_NOTES.md`: BREAKING CHANGES entry — `markDirty()`, `changedColumns()`, the `IsDirty` setter and the Proxy removed; `IsDirty` true on new models; `IsNew` and `changeSet()` added; `insert()`, `refresh()`, `archive()` re-baseline. No manual version bump: CI cuts `2.0.x`.

## 4. ORM tests

Rewrite, not patch: the deleted tests asserted the mechanism (`__dirty_props__` contents), not behaviour.

`orm/test/modelSnapshot.test.ts` (unit, fake driver):

- `IsNew` true on `new Model()`, false after `takeSnapshot()`, true after `clearSnapshot()`.
- `IsDirty` true on a new model; false right after `takeSnapshot()`; true after a column write; false again after writing the original back.
- `changeSet()` returns `{ Column, OldValue, NewValue }` for exactly the differing columns, in descriptor order.
- `changeSet()` on an `IsNew` model: every column, `OldValue: undefined`.
- `DateTime` compared by instant, `Buffer` by bytes, JSON column by deep equality including in-place mutation.
- `UNCOPYABLE` column: reported, `OldValue` undefined.
- `toSql(true)` narrowed to `changeSet()` columns.
- `IsDirty` has no setter: assignment throws in strict mode.

`orm/test/model.test.ts`: "a query-produced model records a dirty prop exactly once" and "refresh clears dirty state" become: a query-produced model is clean; after `refresh()` `IsDirty === false` and `Snapshot` holds the fresh values (defect 3, refresh side).

`orm-sqlite/test/markDirty.test.ts` → renamed `attachDiff.test.ts`: `attach()` makes `changeSet()` contain the foreign key with the target's primary key as `NewValue`; repeated attach reports it once; `detach()` reports `null`; attaching an unsaved target reports the key (cascade case); `attach()` source contains no `__dirty_props__`.

`orm-sqlite/test/attach.test.ts:44-55`: same rewrite for the `ModelBase.attach()` path.

`orm-sqlite/test/snapshotCapture.test.ts`, `uowExecutor.test.ts`, `uowSubject.test.ts`: `IsDirty === false` and `changedColumns()` assertions become `IsDirty` / `changeSet()`. Add: `insert()` then `update()` on the same instance emits an UPDATE with only the changed column (defect 3, insert side).

## 5. yourscreen-backend consumer

### 5.1 Type

Delete `IChangeValue` from `packages/common/src/models/yourscreen/EntityChange.ts`; `changes: IModelChange[]` from `@spinajs/orm`. Same swap in `features/src/entity-history/events/EntityChanged.ts`, `features/src/entity-history/actions/History.ts` (`assertChanges`, `revertEntity`), `features/src/entity-history/actions/Emit.ts`, and the two entity-history tests. The frontend declares its own local shape with the same keys and is untouched.

### 5.2 `@ChangeTracked(resource)`

New in `common`, `packages/common/src/models/yourscreen/ChangeTracked.ts`, same pattern as `@OrmResource`:

```ts
export interface IChangeTrackedDescriptor extends IModelDescriptor {
  ChangeResource?: string;
}

export function ChangeTracked(resource: string) {
  return extractDecoratorDescriptor((model: IChangeTrackedDescriptor) => {
    model.ChangeResource = resource;
  });
}

/** Resource string a model was declared with; throws for an undecorated model. */
export function changeResourceOf(model: ModelBase): string {
  const resource = (model.ModelDescriptor as IChangeTrackedDescriptor | null)?.ChangeResource;
  if (!resource) {
    throw new InvalidOperation(`${model.constructor.name} is not @ChangeTracked`);
  }
  return resource;
}
```

Decorated models and their resource strings (unchanged, they are the persisted contract):

| Model | Resource |
|---|---|
| `ArrowOffer` | `arrow-offer` |
| `ArrowCampaign` | `arrow-campaign` |
| `ArrowCampaignComments` | `campaign-comment` |
| `ContentEntries` | `content-entry` |
| `EntriesGroup` | `entries-group` |

The five `*_RESOURCE` constants move into `ChangeTracked.ts` and are the decorator arguments. `features/src/campaigns/entity-history.ts` and `features/src/player-content/entity-history.ts` re-export them, so their importers and the `ChangeTrackingRegistry.register()` calls are untouched.

### 5.3 `_update_tracked(tag, opts?)`

Chain step in `Emit.ts`; replaces `_update()` wherever history is recorded:

```ts
export function _update_tracked(tag: string, opts?: IEmitOptions) {
  return async <T extends ModelBase>(model: T): Promise<T> => {
    // Diff BEFORE update(): a successful update re-baselines the snapshot and the diff is gone.
    const changes = model.changeSet();
    const event = changes.length > 0
      ? _entity_changed(changeResourceOf(model), model.PrimaryKeyValue, tag, changes, opts)
      : null;

    await model.update();

    // Emitted only once the write landed - a step describing a write that never happened is
    // worse than a missing step. A throw above skips this and propagates.
    if (event) {
      await _chain(_ev(event));
    }
    return model;
  };
}
```

`_entity_changed(resource, id, tag, changes, opts)` stays as the low-level builder: `_set_campaign_status` needs it for the synthetic campaign-level `status` step (`arrow_campaign` has no such column) and keeps its hand-built ordering (campaign summary before per-offer detail). `_dto_changes` is deleted.

### 5.4 Call sites

Mutate, then one step. Every `let change: EntityChanged | null` closure disappears.

| Site | Change |
|---|---|
| `features/src/player-content/actions/Groups.ts` `_update_group` | hydrate step, then `_update_tracked(UPDATED_TAG)` |
| `features/src/player-content/actions/Entries.ts` `_update_entry` | hydrate step, then `_update_tracked(UPDATED_TAG)` |
| `features/src/player-content/actions/Entries.ts` `_set_entry_status` | `entry.status = next`, then `_update_tracked(STATUS_CHANGED_TAG)` |
| `features/src/campaigns/actions/Comments.ts` `_update_comment` | the four `?? existing` assignments stay, `pickBy` gone, then `_update_tracked(UPDATED_TAG, { actor: user })` |
| `backend/src/controllers/yourscreen/campaign/Campaigns.ts` `updateCampaign` | `campaign.hydrate(data)`, author resolved onto `campaign.author`, then `await _update_tracked(UPDATED_TAG, { actor: user })(campaign)`; manual `changes.push` gone |

Example:

```ts
export function _update_group(group: EntriesGroup | number, data: Partial<EntriesGroup>): Promise<EntriesGroup> {
  if (data.validation_rules !== undefined) {
    _validate_group_rules(data.validation_rules);
  }

  return _chain(
    _get_group(group),
    (group: EntriesGroup) => {
      group.hydrate(data as any);
      return group;
    },
    _update_tracked(UPDATED_TAG),
  );
}
```

Behaviour change, accepted: `updateCampaign` today persists its step synchronously via `_record_change`. Every other producer emits `EntityChanged` to the queue and the worker persists it; the API app is configured as the producer (`backend/src/apps/api/config/queue.prod.ts:28`). `_update_tracked` uses the queue path, so this endpoint joins the others and its step lands asynchronously.

### 5.5 README

`features/src/entity-history/README.md`, "Producing events from an action": rewritten around `@ChangeTracked` + `_update_tracked` with the ordering rule (diff before `update()`, emit after). `_entity_changed` documented as the builder for synthetic steps only. The "FK re-pointed through a relation" limitation is deleted — `changeSet()` reports it.

## 6. Consumer tests

- Existing group / entry history tests (`groups.actions.test.ts`, `entries.actions.test.ts`) pass unchanged. That is the acceptance criterion for those call-site rewrites. The `_update_comment` cases move from `comments-actions.test.ts` to a database-backed `comment-update.test.ts`: their `fakeComment()` stand-in is built with `Object.create(prototype)` and no ORM boot, so it has neither a snapshot nor column descriptors and `changeSet()` cannot see it.
- New `ChangeTracked` unit test: `changeResourceOf` returns the declared string; throws for an undecorated model.
- New `_update_tracked` unit test on `EntriesGroup`: emits one event with exactly the changed columns; no event when clean; no event when `update()` throws.
- New `updateCampaign` controller test capturing the queue event: `UPDATED` with the changed columns including `author` resolved from a uuid; nothing when the body repeats stored values. Harness pattern from `campaign-documents.controller.test.ts`.

## 7. Build and rollout order

1. spinajs `orm`: implement, run `orm` and `orm-sqlite` suites, `tsc -b` (the backend consumes spinajs through symlinks).
2. spinajs `rbac-http-token`: no code change; compile to confirm.
3. yourscreen-backend `common` → `features` → `backend`: type swap, decorator, `_update_tracked`, call sites, tests.
4. Release notes entry in spinajs; CI version bump.

## 8. Decisions log

| Question | Decision |
|---|---|
| Break policy | Clean cut, one change, tests rewritten. No shims. |
| Public surface | `IsNew`, derived `IsDirty`, `changeSet()`. `changedColumns()` and `markDirty()` deleted. |
| Approach | Pure derived diff (no write observer). Write-invalidated cache and baseline-at-construction rejected. |
| Proxy | Dropped entirely. |
| Scope | ORM and the yourscreen-backend consumer in one spec. |
| Spec location | spinajs repo. |
| Resource binding | `@ChangeTracked(resource)` decorator on the model. |
| Write step | The combinator writes: `_update_tracked(tag, opts)` = diff → `update()` → emit. |
| Method name | `changeSet()` — the approved `changes()` collided with the real `entity_change.changes` column (Task 6 blocker); model members and columns share one namespace. |
