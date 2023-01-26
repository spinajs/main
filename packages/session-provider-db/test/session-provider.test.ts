import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import '../src';
import { DbSessionStore } from '../src';
import { Session } from '@spinajs/rbac';
import { DateTime } from 'luxon';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

chai.use(chaiAsPromised);
const expect = chai.expect;

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        rbac: {
          session: {
            db: {
              cleanupInterval: 1000,
            },
          },
        },
        db: {
          DefaultConnection: 'sqlite',
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'session-provider-connection',
              Migration: {
                OnStartup: true,
              },
            },
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                OnStartup: true,
              },
            },
          ],
        },
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
              layout: '${datetime} ${level} ${message} ${error} duration: ${duration} (${logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
      },
      mergeArrays,
    );
  }
}

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

async function session() {
  return DI.resolve(DbSessionStore);
}

describe('db session provider', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    DI.clearCache();
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    const s = await session();
    await s.truncate();
  });

  after(() => {
    process.exit(0);
  });

  it('should insert session', async () => {
    const s = await session();
    const d = new Map<string, string>();
    d.set('foo', 'bar');

    await s.save(
      new Session({
        Data: d,
        SessionId: 'a',
        Expiration: DateTime.now().plus({ second: 10 }),
      }),
    );

    const r = await s.restore('a');

    expect(r).to.be.not.null;
    expect(r.SessionId).to.eq('a');
    expect(r.Data.has('foo')).to.be.true;
    expect(r.Data.get('foo')).to.eq('bar');
  });

  it('should update session', async () => {
    const s = await session();
    const d = new Map<string, string>();
    d.set('foo', 'bar');

    const sS = new Session({
      Data: d,
      SessionId: 'a',
      Expiration: DateTime.now().plus({ second: 10 }),
    });

    await s.save(sS);

    let r = await s.restore('a');
    expect(r.Data.get('foo')).to.eq('bar');

    sS.Data.set('foo', 'bar 2');

    await s.save(sS);
    r = await s.restore('a');
    expect(r.Data.get('foo')).to.eq('bar 2');
  });

  it('should delete session', async () => {
    const s = await session();
    const d = new Map<string, string>();
    d.set('foo', 'bar');

    await s.save(
      new Session({
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

    const d = new Map<string, string>();
    d.set('foo', 'bar');

    const date = DateTime.now().plus({ second: 10 });
    const date2 = date.plus({ second: 100 });
    const sI = new Session({
      Data: d,
      SessionId: 'a',
      Expiration: date,
    });

    await s.save(sI);

    const sR = await s.restore('a');

    sI.Expiration = date2;
    await s.touch(sI);

    const sR2 = await s.restore('a');

    expect(sR2.Expiration.toMillis() === date2.toMillis());
    expect(sR.Expiration.toMillis() === date.toMillis());
    expect(sR2.Expiration.toMillis() > sR.Expiration.toMillis());
  });
  it('should return null when session expired', async () => {
    const s = await session();

    const d = new Map<string, string>();
    d.set('foo', 'bar');

    await s.save(
      new Session({
        Data: d,
        SessionId: 'a',
        Expiration: DateTime.now().plus({ second: 2 }),
      }),
    );

    await s.save(
      new Session({
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

    const d = new Map<string, string>();
    d.set('foo', 'bar');

    await s.save(
      new Session({
        Data: d,
        SessionId: 'a',
        Expiration: DateTime.now().plus({ second: 10 }),
      }),
    );

    const sI = await s.restore('b');
    expect(sI).to.be.null;
  });
});
