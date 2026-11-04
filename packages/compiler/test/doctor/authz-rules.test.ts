import 'mocha';
import { expect } from 'chai';
import type { AuthzSection, Manifest, PolicyRef } from '@spinajs/manifest';
import { fieldsWithoutFilter, handlerWithoutPolicy, resourceMismatch, socketWithoutPolicy, systemWithoutReason, unknownPermission } from '../../src/doctor/rules/index.js';
import { controller, fixture, route, src } from './fixture.js';

type EntryPoint = AuthzSection['entryPoints'][number];

const ctx = (config?: Record<string, unknown>) => ({ cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined, ...(config ? { config } : {}) });
const access = (...options: unknown[]): PolicyRef => ({ type: 'AccessPolicy', options });
const entry = (kind: EntryPoint['kind'], id: string, line: number, over: Partial<EntryPoint> = {}): EntryPoint => ({ kind, id, access: [], source: src('src/app.ts', line), ...over });
const APP = { name: 'app', version: '0.0.0', root: '/fixture', outDir: 'lib' };
const withAuthz = (entryPoints: EntryPoint[], over: Partial<AuthzSection> & Partial<Manifest> = {}): Manifest => {
  const { resources = [], permissions = [], ignores = [], ...rest } = over;
  return fixture({ app: APP, authz: { resources, permissions, entryPoints, findings: [], ignores }, ...rest });
};
const codes = (found: { code: string; severity: string; source?: { line: number } }[]) => found.map((d) => `${d.code}:${d.severity}:${d.source?.line ?? '-'}`);

describe('AUTHZ003 socket-without-policy', () => {
  const m = withAuthz([
    entry('socket-command', 'docs.open', 1),
    entry('socket-event', 'docs.seen', 2),
    entry('socket-command', 'docs.edit', 3, { access: [[access('doc:update')]] }),
    entry('route', 'GET /x', 4),
    { ...entry('socket-command', 'lib.cmd', 5), source: src('src/lib.ts', 5, '@x/lib') },
  ]);

  it('is an error for every unguarded socket command and event, of the app and of its packages: the server denies them', () => {
    const found = socketWithoutPolicy.run(m, ctx());
    expect(codes(found)).to.deep.equal(['AUTHZ003:error:1', 'AUTHZ003:error:2', 'AUTHZ003:error:5']);
    expect(found[0].message).to.equal('socket command docs.open has no @SocketAccess or @SocketPolicy on it or on its class: the server denies it (no_policy).');
  });

  it("is a warning while the configuration keeps http.socket.access.default 'allow'", () => {
    expect(codes(socketWithoutPolicy.run(m, ctx({ http: { socket: { access: { default: 'allow' } } } })))).to.deep.equal(['AUTHZ003:warning:1', 'AUTHZ003:warning:2', 'AUTHZ003:warning:5']);
  });

  it('keeps quiet about an entry a spinajs-authz-ignore comment on its line or the line above covers', () => {
    const ignores = [
      { code: 'AUTHZ003', reason: 'probe', source: src('src/app.ts', 1) },
      { code: 'AUTHZ001', reason: 'another code', source: src('src/app.ts', 4) },
    ];
    expect(codes(socketWithoutPolicy.run(withAuthz(m.authz!.entryPoints, { ignores }), ctx()))).to.deep.equal(['AUTHZ003:error:5']);
  });
});

describe('AUTHZ004 handler-without-policy and AUTHZ009 system-without-reason', () => {
  const job = (className: string, runAs?: string) => ({ className, kind: 'job' as const, payload: { text: className }, options: runAs ? { runAs } : {}, source: src('src/app.ts', 1) });
  const m = withAuthz(
    [
      entry('queue-handler', 'job:Plain', 1),
      entry('queue-handler', 'job:Sys', 2),
      entry('queue-handler', 'job:Declared', 3, { access: [[access('invoice:send')]] }),
      entry('queue-handler', 'job:Reasoned', 4, { system: 'nightly purge' }),
      entry('queue-handler', 'job:SysWithAccess', 5, { access: [[access('invoice:send')]] }),
      entry('queue-handler', 'event:Seen', 6),
      entry('schedule', 'nightly', 7),
      entry('schedule', 'hourly', 8, { system: 'refreshes the rates' }),
      entry('cli', 'docs:sync', 9),
      { ...entry('cli', 'orm:migrate', 10), source: src('src/cli.ts', 10, '@spinajs/orm-cli') },
    ],
    { queueMessages: [job('Plain'), job('Sys', 'system'), job('Declared', 'initiator'), job('Reasoned', 'system'), job('SysWithAccess', 'system')] },
  );

  it('warns about an app queue handler with neither access nor @SystemTask, naming runAs system', () => {
    const found = handlerWithoutPolicy.run(m, ctx());
    expect(codes(found)).to.deep.equal(['AUTHZ004:warning:1', 'AUTHZ004:warning:2', 'AUTHZ004:warning:6']);
    expect(found.map((d) => d.message)).to.deep.equal([
      'job:Plain is a queue handler with no @Job({ access }) and no @SystemTask(reason).',
      "job:Sys is a queue handler with no @Job({ access }) and no @SystemTask(reason). It runs as SYSTEM: runAs: 'system' needs @SystemTask(reason) as well.",
      'event:Seen is a queue handler with no @SystemTask(reason) on its event class.',
    ]);
  });

  it('warns about an app schedule, CLI command or system job with access but no @SystemTask; framework entries are left to their packages', () => {
    expect(codes(systemWithoutReason.run(m, ctx()))).to.deep.equal(['AUTHZ009:warning:5', 'AUTHZ009:warning:7', 'AUTHZ009:warning:9']);
  });
});

describe('AUTHZ005 unknown-permission', () => {
  const m = withAuthz(
    [
      entry('route', 'GET /posts', 1, { access: [[access('post:read', 'post:raed')]] }),
      entry('route', 'GET /files', 2, { access: [[access('fs:read')]] }),
      entry('socket-command', 'posts.publish', 3, { access: [[access('post:publish', { resource: { type: 'post' } })]] }),
    ],
    { resources: [{ type: 'post', model: 'app:Post', relations: [], source: src('src/post.ts') }], permissions: ['read', 'create', 'update', 'delete'].map((a) => ({ name: `post:${a}`, declaredIn: 'model' as const })) },
  );

  it('needs the configuration: without it the permissions declared there are unknown', () => {
    expect(unknownPermission.run(m, ctx())).to.deep.equal([]);
  });

  it('flags a permission of a known type missing from the catalogue, never one of a type only an adapter knows', () => {
    const found = unknownPermission.run(m, ctx({ authz: { domains: { reports: { permissions: { 'post:publish': {} } } } } }));
    expect(found.map((d) => d.message)).to.deep.equal(['route GET /posts checks post:raed, which is neither in authz.permissions nor one of the read|create|update|delete permissions of an access resource.']);
  });
});

describe('AUTHZ007 resource-mismatch', () => {
  const models = [
    { id: 'app:Note', className: 'Note', tableName: 'notes', columns: [], relations: [], accessResource: 'doc', source: src('src/note.ts') },
    { id: 'app:Tag', className: 'Tag', tableName: 'tags', columns: [], relations: [], source: src('src/tag.ts') },
  ];
  const m = withAuthz(
    [
      entry('route', 'GET /a', 1, { access: [[access('doc:read', { resource: { type: 'doc' } })]] }),
      entry('route', 'GET /b', 2, { access: [[access('doc:read', { resource: { type: 'post' } })]] }),
      entry('route', 'GET /c', 3, { access: [[access('doc:read', { resource: { model: 'app:Note' } })]] }),
      entry('route', 'GET /d', 4, { access: [[access('doc:read', { resource: { model: 'app:Tag' } })]] }),
      entry('route', 'GET /e', 5, { access: [[access('folder:read', { resource: { type: 'doc' } })]] }),
    ],
    { models },
  );

  it('flags an extractor whose type the permission is not checked on, and fromModel of a model that is no access resource', () => {
    expect(resourceMismatch.run(m, ctx()).map((d) => d.message)).to.deep.equal([
      "route GET /b: its resource extractor yields 'post', but doc:read is checked on 'doc'.",
      'route GET /d: fromModel(Tag) names a model that is no @AccessResource.',
      "route GET /e: its resource extractor yields 'doc', but folder:read is checked on 'folder'.",
    ]);
  });

  it('reads the types a configured permission may be checked on', () => {
    expect(codes(resourceMismatch.run(m, ctx({ authz: { permissions: { 'folder:read': { types: ['folder', 'doc'] } } } })))).to.deep.equal(['AUTHZ007:warning:2', 'AUTHZ007:warning:4']);
  });
});

describe('AUTHZ008 fields-without-filter', () => {
  const m = fixture({
    app: APP,
    controllers: [
      controller({
        className: 'Users',
        source: src('src/users.ts'),
        routes: [
          route({ handler: 'get', access: ['user:read'], source: src('src/users.ts', 4) }),
          route({ handler: 'list', access: ['user:read'], middlewares: [{ type: 'AuthzFieldsMiddleware', options: [] }], source: src('src/users.ts', 8) }),
          route({ handler: 'other', access: ['user:delete'], source: src('src/users.ts', 9) }),
        ],
      }),
      controller({ className: 'Lib', source: src('src/lib.ts', 1, '@x/lib'), routes: [route({ handler: 'get', access: ['user:read'], source: src('src/lib.ts', 2, '@x/lib') })] }),
    ],
  });

  it('flags an app route that checks a fields: true permission without filtering, with --config', () => {
    expect(fieldsWithoutFilter.run(m, ctx())).to.deep.equal([]);
    expect(fieldsWithoutFilter.run(m, ctx({ authz: { permissions: { 'user:read': { fields: true } } } }))).to.deep.equal([
      { code: 'AUTHZ008', severity: 'warning', message: "Users.get checks user:read, declared with fields: true, but returns every field: add { fields: 'filter' } to its @Access.", source: src('src/users.ts', 4) },
    ]);
  });
});
