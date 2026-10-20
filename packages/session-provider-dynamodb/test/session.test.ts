import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { UserSession as Session } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { DateTime } from 'luxon';
import { bootStore, disposeStore } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const LOCAL_DYNAMO = {
  aws: {
    table: 'rbac_sessions',
    config: {
      region: 'local',
      endpoint: 'http://localhost:8000',
    },
  },
};

async function session() {
  return bootStore(LOCAL_DYNAMO);
}

const make = (over: Partial<ISession>) => new Session({ Subject: { type: 'user', id: 'u-1' }, State: 'active', ...over });

// Live-DynamoDB integration test. Requires a local DynamoDB on http://localhost:8000,
// so it is skipped by default. Run it explicitly with DYNAMO_INTEGRATION=1. The
// fake-backed conformance run in `session-provider.test.ts` is the source of truth.
const RUN_INTEGRATION = process.env.DYNAMO_INTEGRATION === '1';

(RUN_INTEGRATION ? describe : describe.skip)('dynamodb session provider (integration)', function () {
  this.timeout(10000);

  afterEach(async () => {
    const s = await session();
    await s.truncate();
  });

  after(async () => {
    await disposeStore();
  });

  it('should insert session', async () => {
    const s = await session();
    const d = new Map<string, unknown>();
    d.set('foo', 'bar');

    await s.save(
      make({
        Data: d,
        SessionId: 'a',
        Expiration: DateTime.now().plus({ second: 10 }),
      }),
    );

    const r = await s.restore('a');

    expect(r).to.be.not.null;
    expect(r!.SessionId).to.eq('a');
    expect(r!.Data.has('foo')).to.be.true;
    expect(r!.Data.get('foo')).to.eq('bar');
  });

  it('should update session', async () => {
    const s = await session();
    const d = new Map<string, unknown>();
    d.set('foo', 'bar');

    const sS = make({
      Data: d,
      SessionId: 'a',
      Expiration: DateTime.now().plus({ second: 10 }),
    });

    await s.save(sS);

    let r = await s.restore('a');
    expect(r!.Data.get('foo')).to.eq('bar');

    sS.Data.set('foo', 'bar 2');

    await s.save(sS);
    r = await s.restore('a');
    expect(r!.Data.get('foo')).to.eq('bar 2');
  });

  it('should delete session', async () => {
    const s = await session();
    const d = new Map<string, unknown>();
    d.set('foo', 'bar');

    await s.save(
      make({
        Data: d,
        SessionId: 'a',
        Expiration: DateTime.now().plus({ second: 10 }),
      }),
    );

    let r = await s.restore('a');

    expect(r).to.be.not.null;

    await s.delete('a');
    r = await s.restore('a');

    expect(r).to.be.null;
  });

  it('should touch session', async () => {
    const s = await session();

    const d = new Map<string, unknown>();
    d.set('foo', 'bar');

    const date = DateTime.now().plus({ second: 10 });
    await s.save(
      make({
        Data: d,
        SessionId: 'a',
        Expiration: date,
      }),
    );

    const sR = await s.restore('a');
    expect(sR!.Expiration!.toMillis()).to.eq(date.toMillis());

    expect(await s.touch(sR!)).to.be.true;

    const sR2 = await s.restore('a');
    expect(sR2!.Expiration!.toMillis()).to.be.greaterThan(date.toMillis());
  });

  it('should return null when session expired', async () => {
    const s = await session();

    const d = new Map<string, unknown>();
    d.set('foo', 'bar');

    await s.save(
      make({
        Data: d,
        SessionId: 'a',
        Expiration: DateTime.now().plus({ second: 2 }),
      }),
    );

    await s.save(
      make({
        Data: d,
        SessionId: 'b',
        Expiration: DateTime.now().plus({ second: 10 }),
      }),
    );

    const result = await new Promise((resolve) => {
      setTimeout(async () => {
        const sI = await s.restore('a');
        resolve(sI);
      }, 5000);
    });

    const result2 = await s.restore('b');

    expect(result).to.be.null;
    expect(result2).to.be.not.null;
  });

  it('should return null if session not exist', async () => {
    const s = await session();

    const d = new Map<string, unknown>();
    d.set('foo', 'bar');

    await s.save(
      make({
        Data: d,
        SessionId: 'a',
        Expiration: DateTime.now().plus({ second: 10 }),
      }),
    );

    const sI = await s.restore('b');
    expect(sI).to.be.null;
  });
});
