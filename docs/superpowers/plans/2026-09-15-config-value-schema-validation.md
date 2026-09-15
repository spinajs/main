# Config Value Schema Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an exposed `@Config(path, { expose: true, ... })` entry has a JSON schema registered in `@spinajs/validation` whose `$id` equals `path`, `PATCH /configuration/:slug` in `@spinajs/configuration-http` validates `Value` and `Default` against that schema in addition to the existing `Type` / `Meta` checks.

**Architecture:** The db row `Slug` is the `@Config` path, so the slug is the schema key. The controller asks `DataValidator.hasSchema(entry.Slug)`; if a schema exists, the per-request value schema becomes `{ allOf: [typeSchema, { $ref: slug }] }`, so ajv resolves the registered schema from its own registry. Schemas are registered the normal `@spinajs/validation` way: files in `system.dirs.schemas` (or `DataValidator.addSchema`). No change to `@spinajs/configuration-db-source`.

**Tech Stack:** TypeScript (ESM, node16 resolution), `@spinajs/validation` (ajv 8.20 + ajv-formats), `@spinajs/http`, mocha + chai + chai-http via `ts-mocha`, sqlite `:memory:` for integration tests.

## Global Constraints

- All code, comments, identifiers, commit messages and docs in English. Comment only non-obvious decisions; no restating code.
- Schema key is the exact `@Config` path (= `DbConfig.Slug`), e.g. `legacy.v1.reports.financial_full`. No prefix, no mapping.
- A registered schema describes the **JSON value as sent to the API** (ISO string for `date`, array for `manyOf`, object for `json`), never the typed runtime value (luxon `DateTime` etc.).
- Entries with no registered schema keep today's behaviour exactly (type / meta validation only).
- Do not add `@spinajs/validation` as a dependency of `@spinajs/configuration-db-source`.
- No manual version bumps. Spinajs releases in lockstep from CI (`release vX.Y.Z [skip ci]`).
- Work on branch `feat/config-value-schema` off `master`. Conventional commits with package scope, e.g. `feat(configuration-http): ...`.
- Run tests from the package directory with `--exit` so the http server suite cannot keep the process alive.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/configuration-http/src/validation.ts` | Modify | `valueSchema()` gains optional `schemaRef`; new `formatValidationErrors()` |
| `packages/configuration-http/test/validation.test.ts` | Create | Unit tests for the two pure helpers |
| `packages/configuration-http/src/controllers/Configuration.ts` | Modify | Look up schema by slug, use the formatter, doc update |
| `packages/configuration-http/test/schemas/app.name.json` | Create | Test schema for a `string` entry |
| `packages/configuration-http/test/schemas/app.limits.json` | Create | Test schema for a `json` entry |
| `packages/configuration-http/test/common.ts` | Modify | Point `system.dirs.schemas` at `test/schemas`, seed `app.limits` row |
| `packages/configuration-http/test/configuration.test.ts` | Modify | Row count 9 → 10, new integration suite |
| `packages/configuration-http/README.md` | Modify | "Value schemas" section |
| `packages/configuration/src/decorators.ts` | Modify | One JSDoc bullet on `@Config` about schema lookup |

---

### Task 1: Pure helpers for schema composition and error messages

**Files:**
- Modify: `packages/configuration-http/src/validation.ts:1` (import) and `:35-77` (`valueSchema`)
- Create: `packages/configuration-http/test/validation.test.ts`

**Interfaces:**
- Consumes: `VALUE_SCHEMAS` (existing, unchanged), `IValidationError` from `@spinajs/validation` (extends ajv `ErrorObject`: `instancePath`, `message?`, `keyword`, `schemaPath`, `params`).
- Produces:
  - `valueSchema(type: ConfigurationEntryType, meta?: IConfigurationEntryMeta, schemaRef?: string): Record<string, unknown>`. Without `schemaRef` returns exactly what it returns today. With it returns `{ allOf: [<today's schema>, { $ref: schemaRef }] }`.
  - `formatValidationErrors(field: string, errors: IValidationError[] | null): string`. Same message format the controller builds today, with duplicate messages removed.

- [ ] **Step 0: Create the branch**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main
git checkout master && git pull --ff-only
git checkout -b feat/config-value-schema
```

- [ ] **Step 1: Write the failing unit tests**

Create `packages/configuration-http/test/validation.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import type { IValidationError } from '@spinajs/validation';
import { formatValidationErrors, valueSchema } from '../src/validation.js';

const err = (instancePath: string, message?: string) => ({ instancePath, message, keyword: 'x', schemaPath: '', params: {} }) as IValidationError;

describe('valueSchema', () => {
  it('returns the plain type schema when no registered schema is referenced', () => {
    expect(valueSchema('string')).to.deep.equal({ type: 'string' });
    expect(valueSchema('number', { min: 1 })).to.deep.equal({ type: 'integer', minimum: 1 });
  });

  it('combines the type schema with a registered schema reference', () => {
    expect(valueSchema('number', { min: 1 }, 'app.maxUsers')).to.deep.equal({
      allOf: [{ type: 'integer', minimum: 1 }, { $ref: 'app.maxUsers' }],
    });
  });

  it('applies meta to array items and the reference to the whole value', () => {
    expect(valueSchema('manyOf', { manyOf: ['a', 'b'] }, 'app.features')).to.deep.equal({
      allOf: [{ type: 'array', uniqueItems: true, items: { type: 'string', enum: ['a', 'b'] } }, { $ref: 'app.features' }],
    });
  });
});

describe('formatValidationErrors', () => {
  it('prefixes the field and strips it from the instance path', () => {
    expect(formatValidationErrors('Value', [err('/Value/perPage', 'must be >= 1')])).to.equal('Value/perPage must be >= 1');
  });

  it('drops duplicate messages produced by both allOf branches', () => {
    expect(formatValidationErrors('Value', [err('/Value', 'must be string'), err('/Value', 'must be string')])).to.equal('Value must be string');
  });

  it('falls back to a generic message', () => {
    expect(formatValidationErrors('Default', [err('/Default')])).to.equal('Default is invalid');
    expect(formatValidationErrors('Default', [])).to.equal('invalid value for Default');
    expect(formatValidationErrors('Default', null)).to.equal('invalid value for Default');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main/packages/configuration-http
npx ts-mocha -p tsconfig.json --exit test/validation.test.ts
```

Expected: FAIL before any test runs, because `../src/validation.js` does not export `formatValidationErrors`. With type-checking on, ts-node also flags the 3-argument `valueSchema` calls.

- [ ] **Step 3: Implement the helpers**

In `packages/configuration-http/src/validation.ts`, add a type import under the existing import on line 1:

```ts
import { ConfigurationEntryType, IConfigurationEntryMeta } from '@spinajs/configuration-db-source';
import type { IValidationError } from '@spinajs/validation';
```

Replace the whole `valueSchema` block (JSDoc + function, lines 35-77) with:

```ts
/**
 * Resolves the value schema for an entry: the constant base schema for its
 * `Type` with the entry `Meta` constraints applied, combined via `allOf` with
 * the schema registered in `@spinajs/validation` under `schemaRef`, if given.
 *
 * The constraints target the schema "leaf" - the `items` schema for array types
 * ( manyOf / *-range ), otherwise the schema itself - so allowed values and
 * bounds land on the element being validated regardless of arity. The
 * registered schema always applies to the whole value.
 *
 * Fed to `DataValidator` ( ajv ) in the controller, after the entry - and so its
 * Type / Meta - has been loaded from the db. It can't live on the request DTO
 * schema, which is validated before that lookup when the type is still unknown.
 *
 * @param schemaRef - `$id` of a registered schema for this entry, ie. its config path
 */
export function valueSchema(type: ConfigurationEntryType, meta?: IConfigurationEntryMeta, schemaRef?: string): JsonSchema {
  const schema = typeSchema(type, meta);
  return schemaRef ? { allOf: [schema, { $ref: schemaRef }] } : schema;
}

function typeSchema(type: ConfigurationEntryType, meta?: IConfigurationEntryMeta): JsonSchema {
  const schema = structuredClone(VALUE_SCHEMAS[type]);

  if (!meta) {
    return schema;
  }

  const leaf = (schema.items as JsonSchema) ?? schema;

  // oneOf / manyOf both restrict the string element to an allowed set
  const allowed = meta.oneOf ?? meta.manyOf;
  if (allowed) {
    leaf.enum = allowed;
  }
  if (meta.min !== undefined) {
    leaf.minimum = meta.min;
  }
  if (meta.max !== undefined) {
    leaf.maximum = meta.max;
  }
  // minDate / maxDate are ISO strings in the JSON Meta; ajv-formats
  // formatMinimum / formatMaximum compare date / time / date-time formats
  if (meta.minDate !== undefined) {
    leaf.formatMinimum = meta.minDate;
  }
  if (meta.maxDate !== undefined) {
    leaf.formatMaximum = meta.maxDate;
  }

  return schema;
}

/**
 * Joins validator errors reported for `field` ( validated wrapped as `{ [field]: value }` )
 * into a single 400 message.
 */
export function formatValidationErrors(field: string, errors: IValidationError[] | null): string {
  const messages = (errors ?? []).map((e) => `${field}${e.instancePath ? e.instancePath.replace(`/${field}`, '') : ''} ${e.message ?? 'is invalid'}`.trim());

  // with allErrors on, the type schema and the registered schema report the same failure from both allOf branches
  return [...new Set(messages)].join('; ') || `invalid value for ${field}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx ts-mocha -p tsconfig.json --exit test/validation.test.ts
```

Expected: PASS, `6 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main
git add packages/configuration-http/src/validation.ts packages/configuration-http/test/validation.test.ts
git commit -m "feat(configuration-http): compose registered value schema into entry validation"
```

---

### Task 2: Validate updates against the schema registered under the config path

**Files:**
- Modify: `packages/configuration-http/src/controllers/Configuration.ts:8`, `:79-80`, `:92-96`, `:144-146`
- Create: `packages/configuration-http/test/schemas/app.name.json`
- Create: `packages/configuration-http/test/schemas/app.limits.json`
- Modify: `packages/configuration-http/test/common.ts` (`TestConfiguration.resolve`, `seed`)
- Modify: `packages/configuration-http/test/configuration.test.ts` (row count, new `describe`)
- Modify: `packages/configuration-http/README.md`
- Modify: `packages/configuration/src/decorators.ts:61-63` (JSDoc only)

**Interfaces:**
- Consumes: `valueSchema(type, meta, schemaRef?)` and `formatValidationErrors(field, errors)` from Task 1. `DataValidator.hasSchema(id: string): boolean` (existing, `@spinajs/validation`).
- Produces: the HTTP contract. `PATCH /configuration/:slug` returns 400 with `{ error: { message } }` when `Value` or `Default` violates the schema whose `$id` equals the slug.

- [ ] **Step 1: Add test schemas**

Create `packages/configuration-http/test/schemas/app.name.json`:

```json
{
  "$id": "app.name",
  "type": "string",
  "minLength": 3,
  "maxLength": 20
}
```

Create `packages/configuration-http/test/schemas/app.limits.json`:

```json
{
  "$id": "app.limits",
  "type": "object",
  "properties": {
    "perPage": { "type": "integer", "minimum": 1, "maximum": 100 },
    "export": { "type": "boolean" }
  },
  "required": ["perPage"],
  "additionalProperties": false
}
```

The existing `app.name` tests send `changed`, `spinajs` and `nope` (the last is rejected with 403 before validation), so `minLength: 3` / `maxLength: 20` does not break them.

- [ ] **Step 2: Wire the schema dir and seed a `json` entry**

In `packages/configuration-http/test/common.ts`, inside `TestConfiguration.resolve()`, replace:

```ts
      system: {
        dirs: {
          controllers: [dir('./../src/controllers')],
        },
      },
```

with:

```ts
      system: {
        dirs: {
          controllers: [dir('./../src/controllers')],
          schemas: [dir('./schemas')],
        },
      },
```

In `seed()`, add this row directly after the `app.window` row:

```ts
    row({ Slug: 'app.limits', Group: 'app', Type: 'json', Value: JSON.stringify({ perPage: 20 }), Default: JSON.stringify({ perPage: 20 }) }),
```

- [ ] **Step 3: Write the failing integration tests**

In `packages/configuration-http/test/configuration.test.ts`, in `it('lists all entries')` change:

```ts
      expect(res.body).to.be.an('array').with.lengthOf(9);
```

to:

```ts
      expect(res.body).to.be.an('array').with.lengthOf(10);
```

Insert this block inside `describe('configuration-http api', ...)`, after the closing `});` of `describe('PATCH /configuration/:slug', ...)` and before `describe('model-level RBAC', ...)`:

```ts
  describe('PATCH /configuration/:slug with a schema registered under the slug', () => {
    it('accepts a string value that satisfies the registered schema', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'short' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('short');
    });

    it('rejects a string value violating the registered schema and keeps the stored value', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'ab' });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Value');

      const get = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('spinajs');
    });

    it('accepts a json object matching the registered schema', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 50, export: true } });
      expect(res).to.have.status(200);
      expect(JSON.parse(res.body.Value)).to.deep.equal({ perPage: 50, export: true });
    });

    it('rejects a json object with an out of range property', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 0 } });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Value/perPage');
    });

    it('rejects a json object missing a required property', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { export: true } });
      expect(res).to.have.status(400);
    });

    it('rejects a json object with an unknown property', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 10, other: 1 } });
      expect(res).to.have.status(400);
    });

    it('validates the Default value against the registered schema too', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 10 }, Default: { perPage: 1000 } });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Default');
    });

    it('keeps type-only validation for entries without a registered schema', async () => {
      const res = await req().patch('configuration/mail.from').set(JSON_HEADERS).send({ Value: 'x' });
      expect(res).to.have.status(200);
    });
  });
```

- [ ] **Step 4: Run the suite to verify the new tests fail**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main/packages/configuration-http
npx ts-mocha -p tsconfig.json --exit test/configuration.test.ts
```

Expected: FAIL on the five rejection cases (`'ab'`, `perPage: 0`, missing `perPage`, unknown `other`, `Default` 1000), each with `expected { Object (_events, ...) } to have status code 400 but got 200`. Every other test passes, including `lists all entries` with 10 rows.

If instead *every* schema test passes vacuously or `hasSchema` never sees the files, check that `DataValidator` was not resolved before `TestConfiguration` assigned `this.Config`. Its `FileSystemSource` reads `system.dirs.schemas` once, at `DataValidator.resolve()`.

- [ ] **Step 5: Wire the controller**

In `packages/configuration-http/src/controllers/Configuration.ts`:

Line 8, replace:

```ts
import { valueSchema } from '../validation.js';
```

with:

```ts
import { formatValidationErrors, valueSchema } from '../validation.js';
```

In the `update` JSDoc (lines 79-80 region), replace:

```ts
   * The incoming value is validated against the entry `Type` and `Meta` constraints.
```

with:

```ts
   * The incoming value is validated against the entry `Type` and `Meta` constraints and,
   * when `@spinajs/validation` holds a schema whose `$id` equals the slug, against that schema.
```

and replace:

```ts
   * @response 400 Invalid value for the entry type or constraints
```

with:

```ts
   * @response 400 Invalid value for the entry type, constraints or registered schema
```

Lines 92-96, replace:

```ts
    // Build the value schema from the entry Type + Meta ( entry.Meta is already an
    // object here, parsed by its @Json converter on load ) and validate the
    // incoming value(s) against it. Validation can only happen here - not on the
    // request DTO - because the entry Type isn't known until after this lookup.
    const schema = valueSchema(entry.Type, entry.Meta);
```

with:

```ts
    // Type + Meta ( Meta already parsed by its @Json converter ), plus the schema registered in
    // @spinajs/validation under the entry's config path, if any. Built here and not on the
    // request DTO because the entry Type isn't known until after this lookup.
    const schema = valueSchema(entry.Type, entry.Meta, this.Validator.hasSchema(entry.Slug) ? entry.Slug : undefined);
```

In `validateValue` (lines 144-146), replace:

```ts
    const message = (errors ?? []).map((e) => `${field}${e.instancePath ? e.instancePath.replace(`/${field}`, '') : ''} ${e.message ?? 'is invalid'}`.trim()).join('; ') || `invalid value for ${field}`;

    return new BadRequestResponse({ error: { message } });
```

with:

```ts
    return new BadRequestResponse({ error: { message: formatValidationErrors(field, errors) } });
```

- [ ] **Step 6: Run the suite to verify it passes**

```bash
npx ts-mocha -p tsconfig.json --exit test/configuration.test.ts
```

Expected: PASS, `36 passing` (28 existing + 8 new).

- [ ] **Step 7: Document the feature**

In `packages/configuration-http/README.md`, insert this section between the paragraph ending `...stored in their canonical string form.` and `## RBAC`:

````md
## Value schemas

An entry can carry its own JSON schema. Register a schema in
[`@spinajs/validation`](../validation) whose `$id` equals the config path passed
to `@Config(path, { expose: true, ... })`, e.g. a file in `system.dirs.schemas`:

```json
{
  "$id": "legacy.v1.reports.financial_full",
  "type": "string",
  "pattern": "\\.xlsx$"
}
```

`PATCH /configuration/:slug` then validates `Value` and `Default` against the
entry `Type` / `Meta` **and** that schema. The schema describes the JSON value as
sent to the API (an ISO string for `date`, an array for `manyOf`, an object for
`json`), not the typed runtime value. Entries without a registered schema are
validated by `Type` / `Meta` only.
````

In `packages/configuration/src/decorators.ts`, after the `watch` bullet that ends with ` *       the live configuration without restarting the app.` (line 63), insert:

```ts
 *  - value schema - not an option: a JSON schema registered in `@spinajs/validation` with
 *    `$id` equal to `path` is enforced by `@spinajs/configuration-http` on updates.
```

- [ ] **Step 8: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main
git add packages/configuration-http/src/controllers/Configuration.ts packages/configuration-http/test packages/configuration-http/README.md packages/configuration/src/decorators.ts
git commit -m "feat(configuration-http): validate config updates against schema registered under the config path"
```

---

### Task 3: Full verification

**Files:** none changed.

- [ ] **Step 1: Run the whole configuration-http suite**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main/packages/configuration-http
npx ts-mocha -p tsconfig.json --exit "test/**/*.test.ts"
```

Expected: `42 passing` (36 integration + 6 unit), exit code 0.

- [ ] **Step 2: Run the db-source suite as a regression check**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main/packages/configuration-db-source
npm test
```

Expected: `22 passing`.

- [ ] **Step 3: Compile and lint the touched packages**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/main/packages/configuration && npm run compile
cd ../configuration-http && npm run compile && npx eslint -c .eslintrc.cjs --ext .ts src
```

Expected: no TypeScript errors, no ESLint errors. Do not use `npm run lint`, it runs with `--fix` and rewrites files.

- [ ] **Step 4: Confirm the tree**

```bash
git status --short
git log --oneline master..HEAD
```

Expected: clean tree, two `feat(configuration-http)` commits. Pushing and opening a PR is the user's call.

---

## Risks and decisions for the reviewer

- **Id namespace is shared.** Any schema in the validator registry whose `$id` equals a config path is applied, including an inline `@Schema({ $id })` DTO once ajv has compiled it. Existing DTO ids (`configuration.http.updateConfigDTO`, `arrow.legacy.v1.GeneralReportFilterDTOSchema`) do not collide with config paths today. A prefix such as `config:` would remove the risk but contradicts the requested key format, so it is not in this plan.
- **ajv options mutate objects.** The controller validates the same object it then stores. With `useDefaults: true` a registered schema's `default`s are filled into a `json` value before saving, and with `removeAdditional` set, unknown properties are stripped instead of rejected.
- **Messages depend on config.** The `@spinajs/validation` default config sets `messages: false`, so production 400s read like `Value/perPage is invalid`. The tests only assert on the field path for that reason.

## Follow-ups, not in this plan

- **yourscreen-backend** does not install `@spinajs/configuration-http` yet, and no frontend screen calls it. Once it does, schemas for keys such as `legacy.v1.reports.financial_full` go in `packages/backend/src/schemas/*.ts` with a default export carrying the `$id`. The build emits them to `build/schemas`, which `system.dirs.schemas` already points at, and the test harness adds `src/schemas`.
- Return the registered schema from `GET /configuration/:slug` so an admin UI can validate client-side.
- Validate each exposed option's `defaultValue` against its schema at startup.
- Gaps from the 2026-09-15 verification: `PATCH { Watch }` has no runtime effect, and options exposed after `Orm` resolves are never watched.
