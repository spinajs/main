import 'mocha';
import { expect } from 'chai';
import ts from 'typescript';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, generateClient, generateClientFiles, type GenerateClientFilesOptions } from '../src/index.js';
import { dateCodec, fromClass, type ModelEntry } from '../src/runtime/index.js';
import { planModels, type PlanNode } from '../src/generate/models/plans.js';
import { appBasicManifest } from './support/fixture.js';
import { modelsManifest, SHADOWED, shadowingManifest } from './support/models-fixture.js';
import { typecheck, typecheckProgram } from './support/typecheck.js';

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));
const runtimeUrl = pathToFileURL(fileURLToPath(new URL('../lib/runtime/index.js', import.meta.url))).href;

async function client(options: GenerateClientFilesOptions): Promise<string> {
  const files = await generateClientFiles({ models: true, ...options });
  expect(files.map((f) => f.path)).to.deep.equal(['client.ts']);
  return files[0].contents;
}

function matchSnapshot(name: string, output: string): void {
  const path = snapshot(name);
  if (!existsSync(path)) writeFileSync(path, output);
  expect(output).to.equal(readFileSync(path, 'utf8'));
}

const consumerHeader = [
  `import { dateCodec, fromClass, type Codec, type ModelEntry } from '@spinajs/client/runtime';`,
  `export type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;`,
  `export type Reply<C, K extends keyof C> = C[K] extends (...args: never[]) => Promise<infer R> ? R : never;`,
  `export class User { id = 0; email = ''; name?: string; get label(): string { return this.email; } }`,
  `export { dateCodec, fromClass, type Codec, type ModelEntry };`,
].join('\n');

/** The generated client followed by app code; returns the diagnostics. */
function consume(generated: string, ...lines: string[]): string[] {
  return typecheck(`${generated}\n${consumerHeader}\n${lines.join('\n')}\n`, { unused: true });
}

interface Loaded {
  createAppClient(options: Record<string, unknown>): Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
}

/** Transpiles and imports a generated client whose runtime import is `runtimeUrl`. */
async function load(source: string): Promise<Loaded> {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = mkdtempSync(join(tmpdir(), 'client-models-'));
  try {
    const file = join(dir, 'client.mjs');
    writeFileSync(file, js);
    return (await import(pathToFileURL(file).href)) as Loaded;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function server(reply: unknown) {
  const requests: { url: string; body?: unknown }[] = [];
  const fake = ((url: string, init?: RequestInit) => {
    requests.push({ url, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) });
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fake, requests };
}

type Schema = Record<string, unknown>;
const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The properties a schema declares, through `allOf` members and the `$ref`s they hold. */
function declaredProperties(manifest: Manifest, schema: unknown): [string, unknown][] {
  if (!isSchema(schema)) return [];
  if (typeof schema.$ref === 'string') return declaredProperties(manifest, manifest.schemas[schema.$ref]);
  if (Array.isArray(schema.allOf)) return (schema.allOf as unknown[]).flatMap((m) => declaredProperties(manifest, m));
  return isSchema(schema.properties) ? Object.entries(schema.properties) : [];
}

/** Checks that every object plan under `plan` lists exactly the properties its schema declares. */
function expectDeclaredProps(manifest: Manifest, schema: unknown, plan: PlanNode | null, where: string): void {
  if (!plan || !isSchema(schema)) return;
  if (plan.kind === 'object') {
    const declared = declaredProperties(manifest, schema);
    expect(plan.props.map(([name]) => name), where).to.deep.equal(declared.map(([name]) => name));
    for (const [name, prop] of declared) expectDeclaredProps(manifest, prop, plan.props.find(([key]) => key === name)?.[1] ?? null, `${where}.${name}`);
  } else if (plan.kind === 'array') expectDeclaredProps(manifest, schema.items, plan.items, `${where}[]`);
  else if (plan.kind === 'record') expectDeclaredProps(manifest, schema.additionalProperties, plan.values, `${where}{}`);
  else if (plan.kind === 'union') {
    const members = ((schema.anyOf ?? schema.oneOf) as unknown[]).filter((m) => !(isSchema(m) && m.type === 'null'));
    plan.members.forEach((member, i) => expectDeclaredProps(manifest, members[i], member, `${where}|${i}`));
  }
}

describe('generateClientFiles with models', () => {
  let basic: Manifest;
  let rich: Manifest;
  let basicClient: string;
  let richClient: string;

  before(async () => {
    basic = await appBasicManifest();
    rich = modelsManifest(basic);
    basicClient = await client({ manifest: basic });
    richClient = await client({ manifest: rich, includeSocket: false });
  });

  it('leaves client.ts byte-identical to 4.0 without models', async () => {
    const [file] = await generateClientFiles({ manifest: basic, models: false });
    expect(file.contents).to.equal(readFileSync(snapshot('app-basic.client.ts'), 'utf8'));
  });

  it('matches the committed snapshots', () => {
    matchSnapshot('app-basic.client.models.ts', basicClient);
    matchSnapshot('models-fixture.client.models.ts', richClient);
  });

  it('keeps the 4.0 declarations and only adds to them', async () => {
    const plain = await generateClient({ manifest: rich, includeSocket: false });
    const kept = (text: string) => text.split('\n\n').filter((block) => /^export interface \w+Client \{|^export interface (?!\w+Model\b)\w+ \{/.test(block) && !/ModelClient/.test(block));
    expect(kept(richClient)).to.deep.equal(kept(plain));
  });

  it('type-checks with zero errors, unused locals and parameters included', () => {
    expect(typecheck(basicClient, { unused: true })).to.deep.equal([]);
    expect(typecheck(richClient, { unused: true })).to.deep.equal([]);
  });

  describe('plans', () => {
    it('list every declared property of every object plan, nested ones included', () => {
      const planned = planModels(buildClientModel(rich, { includeSocket: false }));
      expect(planned.dtos.size).to.be.greaterThan(5);
      for (const [name, dto] of planned.dtos) expectDeclaredProps(rich, rich.schemas[dto.id], dto.plan, name);
    });

    it('emit an object plan for every object DTO, closed when the schema is, and none for an enum', () => {
      const { dtos } = planModels(buildClientModel(rich, { includeSocket: false }));
      expect(dtos.get('Note')?.plan).to.deep.include({ kind: 'object', closed: false });
      expect(dtos.get('UserDto')?.plan).to.deep.include({ kind: 'object', closed: true });
      expect(dtos.has('Status')).to.equal(false);
    });

    it('map each format, and a bigint to the int64 slot', () => {
      expect(richClient).to.include("at: { kind: 'format', format: 'date-time' }");
      expect(richClient).to.include("day: { kind: 'format', format: 'date' }");
      expect(richClient).to.include("price: { kind: 'format', format: 'decimal' }");
      expect(richClient).to.include("big: { kind: 'format', format: 'int64' }");
      expect(richClient).to.include("endsAt: { kind: 'format', format: 'date-time' }");
    });

    it('translate x-discriminator $refs to plan names', () => {
      expect(richClient).to.include("Shape: { kind: 'union', discriminator: { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } }, members: [{ kind: 'ref', name: 'Circle' }, { kind: 'ref', name: 'Square' }] },");
    });

    it('tell UserDto from ValidationProblem by the kind that only ValidationProblem declares', () => {
      expect(basicClient).to.include("create: { reply: { kind: 'union', discriminator: { property: 'kind', mapping: { validation: 'ValidationProblem' }, absent: 'UserDto' }, members: [{ kind: 'ref', name: 'UserDto' }, { kind: 'ref', name: 'ValidationProblem' }] }, args: [{ kind: 'ref', name: 'CreateUserDto' }] },");
    });

    it('convert nothing in a union whose members cannot be told apart, and keep its wire type', () => {
      expect(richClient).to.include('either: null');
      expect(richClient).to.include('either?: string | number;');
    });

    it('drop a null member of a union, so a nullable ref still converts', () => {
      expect(richClient).to.include("parent: { kind: 'ref', name: 'EventDto' }");
    });

    it('merge the members of an intersection into one closed object', () => {
      expect(richClient).to.include("Audit: { kind: 'object', closed: true, props: { at: { kind: 'format', format: 'date-time' }, by: null } } satisfies ObjectPlanOf<Audit>,");
    });

    it('close an intersection whose member is a closed intersection, as the server does', () => {
      const { dtos } = planModels(buildClientModel(rich, { includeSocket: false }));
      expect(dtos.get('Outer')?.plan).to.deep.include({ kind: 'object', closed: true });
    });

    it('check nested object plans against their TypeScript type', () => {
      expect(richClient).to.include("satisfies ObjectPlanOf<$Defined<EventDto['meta']>>");
    });

    it('send a tuple and a ref to a schema without a plan as they are', () => {
      expect(richClient).to.include('tuple: null');
      expect(richClient).to.include('status: null');
    });

    it('plan only the routes that convert something', () => {
      expect(basicClient.slice(basicClient.indexOf('const routePlans'))).to.not.match(/health: \{/);
      expect(richClient).to.include("since: { reply: { kind: 'array', items: { kind: 'ref', name: 'EventDto' } }, args: [{ kind: 'format', format: 'date-time' }] },");
      expect(richClient).to.include("stamp: { reply: { kind: 'object', closed: true, props: { when: { kind: 'format', format: 'date-time' }, label: null } } satisfies ObjectPlanOf<$Defined<$ReplyOf<AppClient['events']['stamp']>>>, args: [] },");
    });
  });

  describe('types', () => {
    it('return AppClient without formats and models', () => {
      expect(consume(basicClient, `const api = createAppClient({ baseUrl: '' });`, `export const ok: Eq<typeof api, AppClient> = true;`)).to.deep.equal([]);
    });

    it('type a Date field as Date with the date codec, and every other slot as wire text', () => {
      const diagnostics = consume(
        richClient,
        `const api = createAppClient({ baseUrl: '', formats: { 'date-time': dateCodec } });`,
        `type Event = Reply<typeof api.events, 'get'>;`,
        `export const a: Eq<Event['at'], Date> = true;`,
        `export const b: Eq<Event['endsAt'], Date | null | undefined> = true;`,
        `export const c: Eq<NonNullable<Event['meta']>['seenAt'], Date> = true;`,
        `export const d: Eq<Event['day'], string | undefined> = true;`,
        `export const e: Eq<Event['either'], string | number | undefined> = true;`,
        `export const f: Eq<Reply<typeof api.events, 'stamp'>['when'], Date> = true;`,
        `export const g: Eq<Extract<NonNullable<Event['shape']>, { kind: 'circle' }>['drawnAt'], Date | undefined> = true;`,
        `export const h: Eq<NonNullable<Event['audit']>['at'], Date> = true;`,
        `export const i: Eq<Parameters<typeof api.events.since>[0], Date> = true;`,
        `export const j: Eq<Event['tuple'], EventDto['tuple']> = true;`,
      );
      expect(diagnostics).to.deep.equal([]);
    });

    it('type a bigint and a decimal field as the codec value', () => {
      const diagnostics = consume(
        richClient,
        `declare const bigintCodec: Codec<bigint>;`,
        `const api = createAppClient({ baseUrl: '', formats: { int64: bigintCodec, decimal: bigintCodec } });`,
        `type Event = Reply<typeof api.events, 'get'>;`,
        `export const a: Eq<Event['big'], bigint | undefined> = true;`,
        `export const b: Eq<Event['price'], bigint | undefined> = true;`,
      );
      expect(diagnostics).to.deep.equal([]);
    });

    it('return registered models for refs, arrays and the UserDto | ValidationProblem union', () => {
      const diagnostics = consume(
        basicClient,
        `const api = createAppClient({ baseUrl: '', models: { UserDto: fromClass(User) } });`,
        `export const a: Eq<Reply<typeof api.users, 'get'>, User> = true;`,
        `export const b: Eq<Reply<typeof api.users, 'list'>, User[]> = true;`,
        `export const c: Eq<Reply<typeof api.users, 'create'>, User | ValidationProblem> = true;`,
        `export const d: Eq<Reply<typeof api.health, 'get'>, { ok: boolean }> = true;`,
      );
      expect(diagnostics).to.deep.equal([]);
    });

    it('keep wire text in the format slots of a models-only client', () => {
      const diagnostics = consume(
        richClient,
        `const api = createAppClient({ baseUrl: '', models: { UserDto: fromClass(User) } });`,
        `type Event = Reply<typeof api.events, 'get'>;`,
        `export const a: Eq<Event['at'], string> = true;`,
        `export const b: Eq<NonNullable<Event['owner']>, User> = true;`,
      );
      expect(diagnostics).to.deep.equal([]);
    });

    it('pick the model overload for an options object held in a variable', () => {
      const diagnostics = consume(
        richClient,
        `const options = { baseUrl: '', formats: { 'date-time': dateCodec } };`,
        `const api = createAppClient(options);`,
        `export const a: Eq<Reply<typeof api.events, 'get'>['at'], Date> = true;`,
        `const plain: { baseUrl: string } = { baseUrl: '' };`,
        `const viaPlain = createAppClient(plain);`,
        `export const b: Eq<typeof viaPlain, AppClient> = true;`,
        `export const c: Eq<ReturnType<typeof createAppClient<{}, {}>>, AppModelClient> = true;`,
      );
      expect(diagnostics).to.deep.equal([]);
    });

    it('keep the null of a nullable DTO through a registered model', () => {
      const diagnostics = consume(
        richClient,
        `class Stamped { at = new Date(); }`,
        `const api = createAppClient({ baseUrl: '', formats: { 'date-time': dateCodec }, models: { MaybeStamp: fromClass(Stamped) } });`,
        `export const a: Eq<Reply<typeof api.events, 'maybe'>, Stamped | null> = true;`,
      );
      expect(diagnostics).to.deep.equal([]);
    });

    it('reject a model registered under a name that is not a DTO', () => {
      const diagnostics = consume(basicClient, `export const api = createAppClient({ baseUrl: '', models: { UserDTO: fromClass(User) } });`);
      expect(diagnostics.join('\n')).to.match(/'UserDTO' does not exist/);
    });

    it('let a class merge with a model type, as the docs advise', () => {
      const diagnostics = consume(
        richClient,
        `type AppFormats = FormatTypes<{ 'date-time': typeof dateCodec }>;`,
        `type AppModels = { EventDto: ModelEntry<Event>; UserDto: ModelEntry<User> };`,
        `export interface Event extends EventDtoModel<AppFormats, AppModels> {}`,
        `export class Event { get isPast(): boolean { return this.at.getTime() < Date.now(); } }`,
        `const api = createAppClient({ baseUrl: '', formats: { 'date-time': dateCodec }, models: { EventDto: fromClass(Event), UserDto: fromClass(User) } });`,
        `export const a: Eq<Reply<typeof api.events, 'get'>, Event> = true;`,
        `export const b: Eq<NonNullable<Reply<typeof api.events, 'get'>['owner']>, User> = true;`,
        `export const c: Eq<NonNullable<Reply<typeof api.events, 'get'>['parent']>, Event> = true;`,
        `export const d = (e: Event) => api.events.save(e);`,
      );
      expect(diagnostics).to.deep.equal([]);
    });
  });

  describe('at runtime', () => {
    const wireEvent = {
      id: 1,
      at: '2026-05-01T08:00:00.000Z',
      endsAt: null,
      meta: { seenAt: '2026-05-02T08:00:00.000Z', note: 'n' },
      either: '2026-05-03T08:00:00.000Z',
      shape: { kind: 'circle', r: 1, drawnAt: '2026-05-04T08:00:00.000Z' },
      audit: { at: '2026-05-05T08:00:00.000Z', by: 'ann' },
      owner: { id: 7, email: 'a@b' },
      parent: { id: 2, at: '2026-04-01T08:00:00.000Z' },
      history: ['2026-05-06T08:00:00.000Z'],
    };

    class User {
      id = 0;
      email = '';
      get label(): string {
        return `#${this.id}`;
      }
    }

    it('decodes formats and registered models through every plan kind', async () => {
      const { fetch } = server(wireEvent);
      const api = (await load(await client({ manifest: rich, includeSocket: false, moduleName: runtimeUrl }))).createAppClient({ baseUrl: 'http://h', fetch, formats: { 'date-time': dateCodec }, models: { UserDto: fromClass(User) } });
      const event = (await api.events.get(1)) as typeof wireEvent & Record<string, unknown>;
      for (const value of [event.at, event.meta.seenAt, event.shape.drawnAt, event.audit.at, event.parent.at, event.history[0]]) expect(value).to.be.instanceOf(Date);
      expect(event.endsAt).to.equal(null);
      expect(event.either).to.equal(wireEvent.either);
      expect(event.owner).to.be.instanceOf(User);
    });

    it('decodes the UserDto member of a union into the model and leaves ValidationProblem plain', async () => {
      const source = await client({ manifest: basic, includeSocket: false, moduleName: runtimeUrl });
      const models: Record<string, ModelEntry<unknown>> = { UserDto: fromClass(User) };
      const created = (await load(source)).createAppClient({ baseUrl: 'http://h', fetch: server({ id: 1, email: 'a@b' }).fetch, models });
      expect(await created.users.create({ email: 'a@b' })).to.be.instanceOf(User);
      const refused = (await load(source)).createAppClient({ baseUrl: 'http://h', fetch: server({ kind: 'validation', errors: ['email'] }).fetch, models });
      const problem = await refused.users.create({ email: 'x' });
      expect(Object.getPrototypeOf(problem)).to.equal(Object.prototype);
      expect(problem).to.deep.equal({ kind: 'validation', errors: ['email'] });
    });

    it('encodes arguments: codecs, query values and closed-object projection', async () => {
      const { fetch, requests } = server([]);
      const api = (await load(await client({ manifest: rich, includeSocket: false, moduleName: runtimeUrl }))).createAppClient({ baseUrl: 'http://h', fetch, formats: { 'date-time': dateCodec } });
      await api.events.since(new Date('2026-05-01T08:00:00.000Z'));
      expect(requests[0].url).to.equal('http://h/events/since?from=2026-05-01T08%3A00%3A00.000Z');
      await api.events.save({ id: 1, at: new Date('2026-05-01T08:00:00.000Z'), meta: { seenAt: new Date('2026-05-02T08:00:00.000Z'), cache: 1 }, local: true });
      expect(requests[1].body).to.deep.equal({ id: 1, at: '2026-05-01T08:00:00.000Z', meta: { seenAt: '2026-05-02T08:00:00.000Z' } });
      await api.events.outer({ at: new Date('2026-05-01T08:00:00.000Z'), by: 'ann', y: 'y', cache: 1 });
      expect(requests[2].body).to.deep.equal({ at: '2026-05-01T08:00:00.000Z', by: 'ann', y: 'y' });
    });
  });

  it('refuses a model type name the client already declares', async () => {
    const clash = { ...rich, schemas: { ...rich.schemas, 'spinajs/models/EventDtoModel': { type: 'object', properties: {} } } };
    const routes = [...clash.controllers.at(-1)!.routes, { ...clash.controllers.at(-1)!.routes[0], handler: 'clash', returnType: { text: 'EventDtoModel', schema: 'spinajs/models/EventDtoModel' } }];
    const manifest = { ...clash, controllers: [...clash.controllers.slice(0, -1), { ...clash.controllers.at(-1)!, routes }] };
    await generateClientFiles({ manifest, models: true }).then(
      () => expect.fail('expected a refusal'),
      (e: unknown) => expect((e as Error).message).to.equal("generateClientFiles: models: client.ts would declare 'EventDtoModel' twice; rename the schema or the controller"),
    );
  });

  it('type-checks a client of 200 DTOs within the recorded instantiation budget', async function () {
    this.timeout(180_000);
    // TypeScript 5.9 counts 64,312 here; the budget fails a model-type change that makes the check about 1.5x as costly.
    const budget = 100_000;
    const manifest = manyDtos(basic, 200);
    const source = await client({ manifest, includeSocket: false });
    const { diagnostics, instantiations } = typecheckProgram(
      [
        source,
        consumerHeader,
        `type AppFormats = FormatTypes<{ 'date-time': typeof dateCodec }>;`,
        `type AppModels = { Dto5: ModelEntry<User>; Dto199: ModelEntry<User> };`,
        `const api = createAppClient({ baseUrl: '', formats: { 'date-time': dateCodec }, models: { Dto5: fromClass(User), Dto199: fromClass(User) } });`,
        `export function use(c: AppModelClient<AppFormats, AppModels>): AppModelClient<AppFormats, AppModels> { return c; }`,
        `export const used = use(api);`,
        `export const a: Eq<NonNullable<Reply<typeof api.many, 'get100'>['prev']>['at'], Date> = true;`,
      ].join('\n'),
      { unused: true },
    );
    expect(diagnostics).to.deep.equal([]);
    expect(instantiations, `${instantiations} instantiations`).to.be.below(budget);
  });

  describe('names', () => {
    it('compile with DTOs named like the global types the model code uses', async () => {
      const generated = await client({ manifest: shadowingManifest(basic), includeSocket: false });
      expect(typecheck(generated, { unused: true })).to.deep.equal([]);
      for (const name of SHADOWED) expect(generated).to.include(`export interface ${name}Model<`);
      expect(generated).to.include('satisfies ObjectPlanOf<$Defined<$ReplyOf<AppClient');
      expect(generated).to.include('satisfies ObjectPlanOf<$Defined<$ArgOf<AppClient');
    });

    it('print route types through the sealed client model', () => {
      const view = buildClientModel(basic).ctx.withTsTypes();
      expect(() => view.expression({ $ref: 'spinajs/app-basic/ArticlesController_read_id' })).to.throw(/outside the client model/);
      expect(view.expression({ type: 'array', items: { tsType: "F['date']" } })).to.equal("F['date'][]");
    });
  });
});

function manyDtos(base: Manifest, count: number): Manifest {
  const at = { type: 'string', format: 'date-time' };
  const schemas: Record<string, unknown> = {};
  const routes: Manifest['controllers'][number]['routes'] = [];
  for (let i = 0; i < count; i++) {
    const id = `spinajs/many/Dto${i}`;
    const prev = i > 0 ? { prev: { $ref: `spinajs/many/Dto${i - 1}` } } : {};
    schemas[id] = { type: 'object', properties: { id: { type: 'number' }, at, tags: { type: 'array', items: at }, meta: { type: 'object', properties: { seen: at }, additionalProperties: false }, ...prev }, required: ['id', 'at'], additionalProperties: false };
    routes.push({ method: 'get', path: '', handler: `get${i}`, fullPath: `/many/get${i}`, params: [], returnType: { text: `Dto${i}`, schema: id }, policies: [], middlewares: [], source: { line: 1, col: 1, file: 'x.ts', package: 'x' } });
  }
  return { ...base, schemas: { ...base.schemas, ...schemas }, controllers: [...base.controllers, { id: 'x:ManyController', className: 'ManyController', basePath: 'many', policies: [], middlewares: [], routes, source: { line: 1, col: 1, file: 'x.ts', package: 'x' } }] };
}

