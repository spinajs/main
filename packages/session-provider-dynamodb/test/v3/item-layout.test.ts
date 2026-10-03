import { expect } from 'chai';
import { UserSession as Session, decodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { DateTime } from 'luxon';
import { bootStore, disposeStore, fake, storedKeys } from '../support.js';

const user = (id: string) => ({ type: 'user', id });
const SLIDING = { service: 'SlidingExpiration', ttl: 60 };

const session = (over: Partial<ISession>) => new Session({ Subject: user('u-1'), State: 'active', Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map<string, unknown>(), ...over });

describe('dynamodb session provider: 3.0 item layout', function () {
  this.timeout(15000);

  after(async () => {
    await disposeStore();
  });

  it('SR-06 the subject persists as top-level Subject, ImpersonatorId and State attributes that the scan filters on, and restores as the same IdentityRef', async () => {
    const store = await bootStore({ expiration: SLIDING });
    await store.truncate();

    await store.save(session({ SessionId: 'l-77', Subject: user('77'), Impersonator: user('admin') }));

    const item = fake.items.get('l-77')!;
    expect(item.Subject).to.deep.equal({ S: 'user:77' });
    expect(item.ImpersonatorId).to.deep.equal({ S: 'user:admin' });
    expect(item.State).to.deep.equal({ S: 'active' });
    expect(item).to.not.have.property('UserId');

    const restored = (await store.restore('l-77'))!;
    expect({ ...restored.Subject }).to.deep.equal(user('77'));
    expect({ ...restored.Impersonator }).to.deep.equal(user('admin'));

    // A row without the attributes is a 2.x row: without them neither delete below would reach it.
    expect(await store.deleteBySubject(user('admin'), { includeImpersonations: true })).to.equal(1);
    await store.save(session({ SessionId: 'l-78', Subject: user('77') }));
    expect(await store.deleteBySubject(user('77'))).to.equal(1);
  });

  it('a session without impersonator stores no ImpersonatorId; a pending one stores State pending', async () => {
    const store = await bootStore({ expiration: SLIDING });
    await store.truncate();

    await store.save(session({ SessionId: 'l-pending', State: 'pending', Expiration: DateTime.now().plus({ minutes: 5 }) }));

    expect(fake.items.get('l-pending')).to.not.have.property('ImpersonatorId');
    expect(fake.items.get('l-pending')!.State).to.deep.equal({ S: 'pending' });
  });

  it('the principal type is escaped like principalKey', async () => {
    const store = await bootStore({ expiration: SLIDING });
    await store.truncate();

    const odd = { type: 'a:b%', id: 'x:y' };
    await store.save(session({ SessionId: 'l-odd', Subject: odd }));

    expect(fake.items.get('l-odd')!.Subject).to.deep.equal({ S: 'a%3Ab%25:x:y' });
    expect({ ...(await store.restore('l-odd'))!.Subject }).to.deep.equal(odd);
    expect((await store.listBySubject(odd)).map((s) => s.SessionId)).to.deep.equal(['l-odd']);
  });

  it('Creation persists as ISO text, Expiration as epoch ms (the TTL attribute), Data through the codec', async () => {
    const store = await bootStore({ expiration: SLIDING });
    await store.truncate();

    const creation = DateTime.fromISO('2026-10-03T08:00:00.000Z');
    const expiration = DateTime.fromISO('2031-01-02T03:04:05.006Z');
    await store.save(session({ SessionId: 'l-attrs', Creation: creation, Expiration: expiration, Data: new Map<string, unknown>([['k', 'v']]) }));

    const item = fake.items.get('l-attrs')!;
    expect(DateTime.fromISO(item.Creation.S!).toMillis()).to.equal(creation.toMillis());
    expect(item.Expiration).to.deep.equal({ N: `${expiration.toMillis()}` });
    expect(decodeSessionData(item.Data.S).get('k')).to.equal('v');
  });

  it('resolve() creates the table keyed by SessionId with TTL on Expiration when it is missing, and leaves an existing table alone', async () => {
    fake.tableExists = false;
    fake.items.clear();

    await bootStore({ expiration: SLIDING });
    expect(fake.tableExists).to.be.true;
    expect(fake.ttlAttribute).to.equal('Expiration');

    await bootStore({ expiration: SLIDING });
    expect(fake.sent.map((s) => s.command)).to.deep.equal(['DescribeTableCommand']);
  });

  it('truncate removes every item and keeps the table and its TTL setting', async () => {
    const store = await bootStore({ expiration: SLIDING });
    fake.pageSize = 1;
    for (let i = 0; i < 4; i++) {
      await store.save(session({ SessionId: `l-t-${i}` }));
    }

    await store.truncate();

    expect(await storedKeys(store)).to.deep.equal([]);
    expect(fake.tableExists).to.be.true;
    expect(fake.ttlAttribute).to.equal('Expiration');
  });
});
