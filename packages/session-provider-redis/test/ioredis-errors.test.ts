import { randomBytes } from 'crypto';
import { inspect } from 'util';
import * as chai from 'chai';
import { Redis, ReplyError } from 'ioredis';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UserSession as Session, encodeSessionData } from '@spinajs/authn-session';
import { RedisSessionStore } from '../src/index.js';
import { FakeRedis, array, bulk, error, nil, ok } from './fake-redis.js';
import type { Reply, Rule } from './fake-redis.js';
import { bootStore, disposeStore } from './support.js';

const expect = chai.expect;

const fake = new FakeRedis();

/** The store over real ioredis, pointed at the fake server. */
class IoredisStore extends RedisSessionStore {
  public password: string | undefined;

  protected createClient(): Redis {
    return new Redis({ host: '127.0.0.1', port: fake.port, keyPrefix: 'app:', password: this.password, lazyConnect: true, retryStrategy: () => null });
  }
}

const KEY = randomBytes(32).toString('hex');
const TOKEN = `tok-${randomBytes(16).toString('hex')}`;
const EXTERNAL_KEY = `ek-${randomBytes(16).toString('hex')}`;
const PASSWORD = `pw-${randomBytes(16).toString('hex')}`;
const SECRETS = [KEY, TOKEN, EXTERNAL_KEY, PASSWORD];

const user = { type: 'user', id: 'u-42' };
const STORED = JSON.stringify({
  Subject: 'user:u-42',
  State: 'active',
  Creation: DateTime.now().toISO(),
  Expiration: DateTime.now().plus({ minutes: 10 }).toISO(),
  Data: encodeSessionData(new Map([['refresh', TOKEN]])),
  ExternalKey: EXTERNAL_KEY,
});
const session = () => new Session({ SessionId: KEY, Subject: user, State: 'active', Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map([['refresh', TOKEN]]), ExternalKey: EXTERNAL_KEY });

// Texts as a Redis server sends them.
const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const READONLY = "READONLY You can't write against a read only replica.";
const EXECABORT = 'EXECABORT Transaction discarded because of previous errors.';
const MASTERDOWN = "MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to 'no'.";
const LOADING = 'LOADING Redis is loading the dataset in memory';
const WRONGPASS = 'WRONGPASS invalid username-password pair or user is disabled.';
const ABORTED = 'Command aborted due to connection close';

type Override = Record<string, Reply | ((args: string[]) => Reply | undefined)>;

/** A stored, live session of user:u-42 under KEY, in its subject and external sets, with `over` replacing replies by command name. */
function replies(over: Override): Rule {
  const defaults: Record<string, (args: string[]) => Reply> = {
    get: () => bulk(STORED),
    smembers: ([set]) => (set.includes(':impersonator:') ? '*0\r\n' : array([bulk(KEY)])),
    mget: (keys) => array(keys.map(() => bulk(STORED))),
    eval: () => ':1\r\n',
    scan: () => array([bulk('0'), array([bulk(`app:session:${KEY}`)])]),
    del: () => ':1\r\n',
  };
  let queued = -1;
  return (name, args) => {
    const own = over[name];
    const given = typeof own === 'function' ? own(args) : own;
    if (name === 'multi') {
      queued = 0;
      return given ?? ok;
    }
    if (name === 'exec') {
      const count = queued;
      queued = -1;
      return given ?? array(Array.from({ length: count }, () => ':1\r\n'));
    }
    if (queued >= 0) {
      queued++;
      return given ?? '+QUEUED\r\n';
    }
    return given ?? defaults[name]?.(args);
  };
}

const runsOf = (secret: string) => Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8));
const leaks = (text: string) => SECRETS.flatMap(runsOf).filter((run) => text.includes(run));
const printed = (value: unknown) => [inspect(value, { depth: null, showHidden: true }), JSON.stringify(value) ?? ''].join(' ');

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'security', 'success'] as const;

/** Runs `op`, printing every call of the store's logger when it is made: a later strip must not hide what was logged. */
async function logged(op: () => Promise<unknown>): Promise<[unknown, string[]]> {
  const log = DI.resolve(Log, ['redis-session-store']);
  const lines: string[] = [];
  for (const level of LEVELS) {
    log[level] = (...args: unknown[]) => {
      lines.push(printed(args));
    };
  }
  try {
    return [await op().then(() => undefined, (err: unknown) => err), lines];
  } finally {
    for (const level of LEVELS) {
      Reflect.deleteProperty(log, level);
    }
  }
}

interface ICell {
  op: string;
  fails: string;
  over: Override;
  run: (store: RedisSessionStore) => Promise<unknown>;
  type: 'ReplyError' | 'AbortError' | 'Error';
  message: string;
  previous?: string;
  password?: true;
}

const OPS: [string, (store: RedisSessionStore) => Promise<unknown>][] = [
  ['restore', (s) => s.restore(KEY)],
  ['save', (s) => s.save(session())],
  ['touch', (s) => s.touch(session())],
  ['delete', (s) => s.delete(KEY)],
  ['listBySubject', (s) => s.listBySubject(user)],
  ['listBySubject with impersonations', (s) => s.listBySubject(user, { includeImpersonations: true })],
  ['deleteBySubject', (s) => s.deleteBySubject(user)],
  ['deleteBySubject with impersonations', (s) => s.deleteBySubject(user, { includeImpersonations: true })],
  ['deleteByExternalKey', (s) => s.deleteByExternalKey(EXTERNAL_KEY)],
  ['truncate', (s) => s.truncate()],
];
const op = (name: string) => OPS.find(([n]) => n === name)![1];

const refusedTransaction = { set: error(READONLY), del: error(READONLY), srem: error(READONLY), exec: error(EXECABORT) };
const cutTransaction = { multi: { close: ok } };
const pruneOnly = { mget: (keys: string[]) => array(keys.map(() => nil)) };

const CELLS: ICell[] = [
  { op: 'restore', fails: 'GET: WRONGTYPE', over: { get: error(WRONGTYPE) }, run: op('restore'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'restore', fails: 'GET: connection closed', over: { get: { close: '' } }, run: op('restore'), type: 'Error', message: 'Connection is closed.' },
  { op: 'save', fails: 'GET: WRONGTYPE', over: { get: error(WRONGTYPE) }, run: op('save'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'save', fails: 'MULTI: SET READONLY, EXECABORT', over: refusedTransaction, run: op('save'), type: 'ReplyError', message: EXECABORT, previous: READONLY },
  { op: 'save', fails: 'MULTI: connection closed after MULTI', over: cutTransaction, run: op('save'), type: 'AbortError', message: ABORTED, previous: ABORTED },
  { op: 'save', fails: 'EXEC: a reply in the result is WRONGTYPE', over: { exec: array([error(WRONGTYPE), ':1\r\n', ':1\r\n', ':1\r\n']) }, run: op('save'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'touch', fails: 'GET: WRONGTYPE', over: { get: error(WRONGTYPE) }, run: op('touch'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'touch', fails: 'EVAL: READONLY', over: { eval: error(READONLY) }, run: op('touch'), type: 'ReplyError', message: READONLY },
  { op: 'delete', fails: 'GET: WRONGTYPE', over: { get: error(WRONGTYPE) }, run: op('delete'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'delete', fails: 'MULTI: DEL READONLY, EXECABORT', over: refusedTransaction, run: op('delete'), type: 'ReplyError', message: EXECABORT, previous: READONLY },
  { op: 'delete', fails: 'MULTI: connection closed after MULTI', over: cutTransaction, run: op('delete'), type: 'AbortError', message: ABORTED, previous: ABORTED },
  { op: 'listBySubject', fails: 'SMEMBERS: WRONGTYPE', over: { smembers: error(WRONGTYPE) }, run: op('listBySubject'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'listBySubject', fails: 'MGET: MASTERDOWN', over: { mget: error(MASTERDOWN) }, run: op('listBySubject'), type: 'ReplyError', message: MASTERDOWN },
  { op: 'listBySubject', fails: 'prune MULTI: SREM READONLY, EXECABORT', over: { ...pruneOnly, ...refusedTransaction }, run: op('listBySubject'), type: 'ReplyError', message: EXECABORT, previous: READONLY },
  { op: 'listBySubject with impersonations', fails: 'SMEMBERS of the impersonator set: WRONGTYPE', over: { smembers: ([set]) => (set.includes(':impersonator:') ? error(WRONGTYPE) : undefined) }, run: op('listBySubject with impersonations'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'deleteBySubject', fails: 'SMEMBERS: WRONGTYPE', over: { smembers: error(WRONGTYPE) }, run: op('deleteBySubject'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'deleteBySubject', fails: 'MGET: MASTERDOWN', over: { mget: error(MASTERDOWN) }, run: op('deleteBySubject'), type: 'ReplyError', message: MASTERDOWN },
  { op: 'deleteBySubject', fails: 'MULTI: DEL READONLY, EXECABORT', over: refusedTransaction, run: op('deleteBySubject'), type: 'ReplyError', message: EXECABORT, previous: READONLY },
  { op: 'deleteBySubject with impersonations', fails: 'MULTI: connection closed after MULTI', over: cutTransaction, run: op('deleteBySubject with impersonations'), type: 'AbortError', message: ABORTED, previous: ABORTED },
  { op: 'deleteByExternalKey', fails: 'SMEMBERS: WRONGTYPE', over: { smembers: error(WRONGTYPE) }, run: op('deleteByExternalKey'), type: 'ReplyError', message: WRONGTYPE },
  { op: 'deleteByExternalKey', fails: 'MGET: MASTERDOWN', over: { mget: error(MASTERDOWN) }, run: op('deleteByExternalKey'), type: 'ReplyError', message: MASTERDOWN },
  { op: 'deleteByExternalKey', fails: 'MULTI: DEL READONLY, EXECABORT', over: refusedTransaction, run: op('deleteByExternalKey'), type: 'ReplyError', message: EXECABORT, previous: READONLY },
  { op: 'truncate', fails: 'SCAN: LOADING', over: { scan: error(LOADING) }, run: op('truncate'), type: 'ReplyError', message: LOADING },
  { op: 'truncate', fails: 'DEL: READONLY', over: { del: error(READONLY) }, run: op('truncate'), type: 'ReplyError', message: READONLY },
  ...OPS.map(([name, run]): ICell => ({ op: name, fails: 'AUTH: WRONGPASS', over: { auth: error(WRONGPASS) }, run, type: 'ReplyError', message: WRONGPASS, password: true })),
];

describe('errors that leave the redis session store carry none of the command arguments ioredis attaches', function () {
  this.timeout(30000);

  let store: IoredisStore;

  before(async () => {
    await fake.open();
    await bootStore();
    store = await DI.resolve(IoredisStore);
  });

  after(async () => {
    await store.dispose();
    DI.uncache(IoredisStore);
    await disposeStore();
    await fake.close();
  });

  afterEach(async () => {
    await store.dispose();
    store.password = undefined;
    fake.rule = () => undefined;
  });

  it('real ioredis attaches the session key and the stored value to its errors, so these tests are not vacuous', async () => {
    const client = new Redis({ host: '127.0.0.1', port: fake.port, keyPrefix: 'app:', lazyConnect: true, retryStrategy: () => null });
    try {
      fake.rule = replies({ get: error(WRONGTYPE), set: error(READONLY), exec: error(EXECABORT) });
      const get = await client.get(`session:${KEY}`).then(() => undefined, (err: unknown) => err);
      expect(get).to.be.instanceOf(ReplyError);
      expect(get).to.have.deep.property('command', { name: 'get', args: [`app:session:${KEY}`] });

      const exec = await client
        .multi()
        .set(`session:${KEY}`, STORED)
        .exec()
        .then(() => undefined, (err: unknown) => err);
      expect(exec).to.have.nested.property('previousErrors[0].command.name', 'set');
      expect(leaks(printed(exec))).to.not.be.empty;
    } finally {
      client.disconnect();
    }
  });

  for (const cell of CELLS) {
    it(`${cell.op}, ${cell.fails}: ${cell.type} "${cell.message}" without command`, async () => {
      fake.rule = replies(cell.over);
      store.password = cell.password ? PASSWORD : undefined;
      await store.resolve();

      const [err, lines] = await logged(() => cell.run(store));

      expect(err, 'the operation fails').to.be.instanceOf(Error);
      const failure = err as Error;
      expect(failure.constructor.name).to.equal(cell.type);
      expect(failure.name).to.equal(cell.type);
      expect(failure.message).to.equal(cell.message);
      if (cell.type === 'ReplyError') {
        expect(failure).to.be.instanceOf(ReplyError);
      }
      expect(Object.getOwnPropertyNames(failure)).to.not.include('command');
      if (cell.previous) {
        const previous: unknown = Reflect.get(failure, 'previousErrors');
        expect(previous, 'previousErrors are kept').to.be.an('array').that.is.not.empty;
        for (const item of previous as Error[]) {
          expect(item.message).to.equal(cell.previous);
          expect(Object.getOwnPropertyNames(item)).to.not.include('command');
        }
      }
      expect(failure.cause, 'no cause').to.equal(undefined);
      expect(leaks(printed(failure)), 'runs of the storage key, the stored Data, the ExternalKey or the password').to.deep.equal([]);
      expect(lines.flatMap(leaks), 'in a log line').to.deep.equal([]);
    });
  }
});
