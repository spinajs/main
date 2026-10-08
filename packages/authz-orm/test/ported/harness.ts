import { AuthorizationModel, DecisionAudit, runWithPrincipal } from '@spinajs/authz';
import type { ModelCapabilities, Principal, ResourceFilter } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost } from '@spinajs/authz-testing';
import type { VoteFn, VoteTable } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Owner } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

export const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });
export const permit = (when: ResourceFilter = { op: 'true' }) => ({ permitWhen: when });
export const ownerRelation = { op: 'relation', relation: 'owner' } as ResourceFilter;
export const as = <T>(p: Principal, fn: () => T | Promise<T>): Promise<T> => runWithPrincipal(p, async () => fn());

export type Resource = typeof ModelBase & { query(): any; where(...a: unknown[]): any; update(v: object): any; destroy(pk: unknown): any; insert(v: object | object[]): any };

export const DIALECTS = ['sqlite', 'postgres'] as const satisfies readonly Dialect[];

/** The world of a ported suite: the ORM on a dialect, one domain per case, and the `@AccessResource` model the legacy ResourceModel stood for. */
export class PortedWorld {
  readonly TYPE = 'resource';
  readonly P = { read: 'resource:read', create: 'resource:create', update: 'resource:update', delete: 'resource:delete' };
  db!: TestDb;
  pg = false;
  private seq = 0;
  private readonly undo: (() => void | Promise<void>)[] = [];

  async open(): Promise<void> {
    this.pg = await TestDb.postgresReachable();
    this.db = await TestDb.open({ postgres: this.pg });
    // Root boots before the suite registers its types, so their permissions come from the test domain's config.
    await (await testHost.domains()).service('root');
  }

  async close(): Promise<void> {
    await this.db?.close();
  }

  async reset(): Promise<void> {
    for (const fn of this.undo.splice(0).reverse()) await fn();
    await this.db.clear();
  }

  /** The legacy ResourceModel: `UserId` is the @Owner column. */
  resource(dialect: Dialect): Promise<Resource> {
    return this.db.define(
      {
        name: 'Resource',
        columns: { UserId: 'TEXT', Value: 'TEXT' },
        decorate: (cls, proto) => {
          AccessResource(this.TYPE)(cls);
          Owner()(proto, 'UserId');
        },
      },
      dialect,
    ) as Promise<Resource>;
  }

  /** A test domain voting `votes` on the permissions of the resource type and `extraTypes`; `authz.orm.domain` names it. */
  async grant(votes: VoteTable | VoteFn, extraTypes: readonly string[] = [], opts: { sync?: ModelCapabilities['sync'] } = {}): Promise<void> {
    const ds = await testHost.domains();
    const name = `ported${++this.seq}`;
    const config = testHost.config();
    const permissions = Object.fromEntries([this.TYPE, ...extraTypes].flatMap((t) => ['read', 'create', 'update', 'delete'].map((a) => [`${t}:${a}`, { types: [t] }])));
    const set = (path: string[], value: unknown) => {
      const before = config.get<unknown>(path);
      config.set(path, value);
      this.undo.push(() => (before === undefined ? config.unset(path) : config.set(path, before)));
    };
    set(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
    set(['authz', 'orm', 'domain'], name);
    const container: IContainer = ds.create(name, 'root');
    this.undo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
    container.register(testHost.instance(new StaticModel({ name: 'm1', votes, ...(opts.sync ? { capabilities: { sync: opts.sync } } : {}) }))).as(AuthorizationModel);
    container.register(testHost.instance(new RecordingAudit())).as(DecisionAudit);
    await ds.service(name);
  }

  /** Raw rows, unscoped, as [UserId, Value] sorted by Value. */
  async stored(Res: Resource): Promise<[unknown, unknown][]> {
    return (await this.db.rows(Res)).map((r) => [r.UserId, r.Value] as [unknown, unknown]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }
}
