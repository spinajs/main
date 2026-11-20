import 'mocha';
import { expect } from 'chai';
import { ConnectionState, DefaultReplicaRouter, IDriverOptions, markWrite, OrmDriver, QueryBuilder, readYourWrites, wroteInScope } from '../src/index.js';
import { readRouteOf, withReadRoute } from '../src/read-route.js';

function driver(name: string, options: Partial<IDriverOptions> = {}, state = ConnectionState.Connected): OrmDriver {
  return { Options: { Name: name, Driver: 'fake', ...options }, State: state, CurrentTransaction: undefined } as unknown as OrmDriver;
}

const query = {} as QueryBuilder;

function routerWith(primary: OrmDriver, replicas: OrmDriver[]): DefaultReplicaRouter {
  const router = new DefaultReplicaRouter();
  router.register(primary, replicas);
  return router;
}

describe('DefaultReplicaRouter', () => {
  it('answers the primary when it has no replicas', () => {
    const primary = driver('main');

    expect(new DefaultReplicaRouter().pick(primary, query)).to.eq(primary);
  });

  it('takes the healthy replicas in turn', () => {
    const primary = driver('main');
    const router = routerWith(primary, [driver('r1'), driver('r2')]);

    expect([1, 2, 3].map(() => router.pick(primary, query).Options.Name)).to.deep.equal(['r1', 'r2', 'r1']);
  });

  it('skips an unhealthy replica and answers the primary when none is healthy', () => {
    const primary = driver('main');
    const degraded = driver('r1', {}, ConnectionState.Degraded);
    const router = routerWith(primary, [degraded, driver('r2')]);

    expect([1, 2].map(() => router.pick(primary, query).Options.Name)).to.deep.equal(['r2', 'r2']);

    router.register(primary, [degraded]);
    expect(router.pick(primary, query)).to.eq(primary);
  });

  it('answers the primary when ReadPreference is primary', () => {
    const primary = driver('main', { ReadPreference: 'primary' });

    expect(routerWith(primary, [driver('r1')]).pick(primary, query)).to.eq(primary);
  });

  it('answers the primary inside a transaction', () => {
    const primary = { ...driver('main'), CurrentTransaction: { depth: 0 } } as unknown as OrmDriver;

    expect(routerWith(primary, [driver('r1')]).pick(primary, query)).to.eq(primary);
  });

  it('answers the primary after a write in the same scope, and only there', async () => {
    const primary = driver('main');
    const replica = driver('r1');
    const router = routerWith(primary, [replica]);

    await readYourWrites(async () => {
      expect(router.pick(primary, query)).to.eq(replica);
      markWrite(primary);
      await Promise.resolve();
      expect(router.pick(primary, query)).to.eq(primary);
    });

    expect(router.pick(primary, query)).to.eq(replica);
  });

  it('keeps reading replicas after a write when StickyPrimary is off', async () => {
    const primary = driver('main', { StickyPrimary: 'off' });
    const replica = driver('r1');
    const router = routerWith(primary, [replica]);

    await readYourWrites(async () => {
      markWrite(primary);
      expect(router.pick(primary, query)).to.eq(replica);
    });
  });

  it('pins only the connection that was written', async () => {
    const a = driver('a');
    const b = driver('b');
    const rb = driver('rb');
    const router = routerWith(a, [driver('ra')]);
    router.register(b, [rb]);

    await readYourWrites(async () => {
      markWrite(a);
      expect(router.pick(a, query)).to.eq(a);
      expect(router.pick(b, query)).to.eq(rb);
    });
  });
});

describe('read-your-writes scope', () => {
  it('records nothing outside a scope', () => {
    const primary = driver('main');
    markWrite(primary);

    expect(wroteInScope(primary)).to.eq(false);
  });

  it('joins an open scope instead of starting a new one', async () => {
    const primary = driver('main');

    await readYourWrites(async () => {
      await readYourWrites(async () => {
        markWrite(primary);
      });
      expect(wroteInScope(primary)).to.eq(true);
    });
  });
});

describe('read route of relation loads', () => {
  it('routes the selects of the primary it was opened for, and of no other connection', () => {
    const main = driver('main');
    const replica = driver('r1');
    const other = driver('other');

    withReadRoute(main, replica, () => {
      expect(readRouteOf(main)).to.eq(replica);
      expect(readRouteOf(other)).to.eq(undefined);
    });
    expect(readRouteOf(main)).to.eq(undefined);
  });

  it('keeps the outer route inside a nested scope of another connection', () => {
    const main = driver('main');
    const other = driver('other');
    const mainReplica = driver('r1');
    const otherReplica = driver('o1');

    withReadRoute(main, mainReplica, () => {
      withReadRoute(other, otherReplica, () => {
        expect(readRouteOf(main)).to.eq(mainReplica);
        expect(readRouteOf(other)).to.eq(otherReplica);
      });
      expect(readRouteOf(other)).to.eq(undefined);
    });
  });

  it('keeps concurrent scopes apart', async () => {
    const main = driver('main');
    const seen = await Promise.all(
      [driver('r1'), driver('r2')].map((read) =>
        withReadRoute(main, read, async () => {
          await Promise.resolve();
          return readRouteOf(main)?.Options.Name;
        }),
      ),
    );

    expect(seen).to.deep.equal(['r1', 'r2']);
  });
});
