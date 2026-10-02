import { expect } from 'chai';
import { DateTime } from 'luxon';
import { regenerateSession, UserSession } from '../src/index.js';
import type { ISession } from '../src/index.js';

// Minimal in-memory fake provider — regenerateSession only needs delete + save.
class FakeProvider {
  public Store = new Map<string, ISession>();
  public Deleted: string[] = [];

  public async delete(id: string): Promise<void> {
    this.Deleted.push(id);
    this.Store.delete(id);
  }
  public async save(session: ISession): Promise<void> {
    this.Store.set(session.SessionId, session);
  }
}

describe('regenerateSession (session-fixation protection)', () => {
  const build = (): ISession => {
    const s = new UserSession();
    s.UserId = 99;
    s.Creation = DateTime.fromISO('2026-01-02T03:04:05.000Z');
    s.Expiration = DateTime.fromISO('2026-01-02T05:04:05.000Z');
    s.Data.set('User', 'user-uuid');
    s.Data.set('Authorized', true);
    return s;
  };

  it('mints a new SessionId different from the old one', async () => {
    const provider = new FakeProvider();
    const old = build();
    provider.Store.set(old.SessionId, old);

    const fresh = await regenerateSession(provider as any, old);

    expect(fresh.SessionId).to.be.a('string');
    expect(fresh.SessionId).to.not.equal(old.SessionId);
  });

  it('copies UserId, Creation and Data to the new session', async () => {
    const provider = new FakeProvider();
    const old = build();

    const fresh = await regenerateSession(provider as any, old);

    expect(fresh.UserId).to.equal(99);
    expect(fresh.Creation.toMillis()).to.equal(old.Creation.toMillis());
    expect(fresh.Data.get('User')).to.equal('user-uuid');
    expect(fresh.Data.get('Authorized')).to.equal(true);
  });

  it('copies Data into a distinct map (mutating the new session does not affect the old)', async () => {
    const provider = new FakeProvider();
    const old = build();

    const fresh = await regenerateSession(provider as any, old);
    fresh.Data.set('extra', 'x');

    expect(old.Data.has('extra')).to.be.false;
  });

  it('deletes the old session id and saves the new one', async () => {
    const provider = new FakeProvider();
    const old = build();
    provider.Store.set(old.SessionId, old);

    const fresh = await regenerateSession(provider as any, old);

    expect(provider.Deleted).to.deep.equal([old.SessionId]);
    expect(provider.Store.has(old.SessionId)).to.be.false;
    expect(provider.Store.get(fresh.SessionId)).to.equal(fresh);
  });
});
