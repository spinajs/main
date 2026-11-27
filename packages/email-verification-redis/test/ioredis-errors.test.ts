import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import type { CachedVerdict } from '@spinajs/email-verification';
import { Redis, ReplyError } from 'ioredis';
import { RedisEmailVerificationStore } from '../src/index.js';
import { FakeRedis, array, bulk, error, int, nil, ok } from './fake-redis.js';
import type { Reply, Rule } from './fake-redis.js';
import { bootStore, disposeStore } from './support.js';

const fake = new FakeRedis();

/** The store over real ioredis, pointed at the fake server. */
class IoredisStore extends RedisEmailVerificationStore {
  public password: string | undefined;

  protected createClient(): Redis {
    return new Redis({ ...this.clientOptions(), host: '127.0.0.1', port: fake.port, password: this.password, lazyConnect: true, retryStrategy: () => null });
  }
}

const DOMAIN = `ev-${randomBytes(16).toString('hex')}.test`;
const LIST_TOKEN = `lt-${randomBytes(16).toString('hex')}`;
const PASSWORD = `pw-${randomBytes(16).toString('hex')}`;
const SECRETS = [DOMAIN, LIST_TOKEN, PASSWORD];

const SOURCE = 'shared-blocklist';
const ORIGIN = `block|https://lists.example/block.txt?token=${LIST_TOKEN}`;
const VERDICT: CachedVerdict = { result: 'refuse', reason: 'null_mx', checkedAt: 1 };

// Texts as a Redis server sends them.
const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const READONLY = "READONLY You can't write against a read only replica.";
const EXECABORT = 'EXECABORT Transaction discarded because of previous errors.';
const NOAUTH = 'NOAUTH Authentication required.';
const WRONGPASS = 'WRONGPASS invalid username-password pair or user is disabled.';
const ERR_ARITY = "ERR wrong number of arguments for 'get' command";
const ABORTED = 'Command aborted due to connection close';
const CLOSED = 'Connection is closed.';
const TX_ABORTED = 'Redis transaction was aborted';
const redactedUnknown = (name: string) => `ERR unknown command '${name}', with args beginning with: <redacted>`;

/** Redis 6.2+ and 7 quote each argument as `'%.*s' ` until 128 characters are written. */
function unknownCommand(name: string, args: string[]): Reply {
  let list = '';
  for (const arg of args) {
    if (list.length >= 128) break;
    list += `'${arg.slice(0, 128 - list.length)}' `;
  }
  return error(`ERR unknown command '${name.slice(0, 128)}', with args beginning with: ${list}`);
}

type Answer = Reply | ((args: string[], queued: number) => Reply | undefined);
type Override = Record<string, Answer>;

/** A Redis that holds one list source with DOMAIN, with `over` replacing replies by command name; MULTI behaves as on a server. */
function replies(over: Override): Rule {
  const defaults = new Map<string, (args: string[]) => Reply>([
    ['get', () => nil],
    ['smembers', ([set]) => (set === 'ev:lists' ? array([bulk(`block:${SOURCE}`)]) : array([bulk(DOMAIN)]))],
    ['del', () => int(1)],
  ]);
  const answers = new Map(Object.entries(over));
  let queued = -1;
  let refused = false;
  return (name, args) => {
    const own = answers.get(name);
    const given = typeof own === 'function' ? own(args, queued) : own;
    if (name === 'multi') {
      queued = 0;
      refused = false;
      return given ?? ok;
    }
    if (name === 'exec') {
      const [count, failed] = [queued, refused];
      queued = -1;
      return given ?? (failed ? error(EXECABORT) : array(Array.from({ length: count }, () => int(1))));
    }
    if (queued >= 0) {
      queued++;
      if (typeof given === 'string' && given.startsWith('-')) refused = true;
      return given ?? '+QUEUED\r\n';
    }
    return given ?? defaults.get(name)?.(args);
  };
}

const runsOf = (secret: string) => Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8));
const leaks = (text: string) => SECRETS.flatMap(runsOf).filter((run) => text.includes(run));
/** JSON that prints a repeated object once: a refused AUTH in a transaction lists the error in its own previousErrors. */
function json(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v !== 'object' || v === null) return v;
      if (seen.has(v)) return '[seen]';
      seen.add(v);
      return v;
    }) ?? ''
  );
}
const printed = (value: unknown) => [inspect(value, { depth: null, showHidden: true }), json(value)].join(' ');

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'security', 'success'] as const;

/** Runs `op`, printing every call of the store's logger when it is made: a later strip must not hide what was logged. */
async function logged(op: () => Promise<unknown>): Promise<[unknown, string[]]> {
  const log = DI.resolve(Log, ['email-verification']);
  const lines: string[] = [];
  for (const level of LEVELS) {
    Reflect.set(log, level, (...args: unknown[]) => {
      lines.push(printed(args));
    });
  }
  try {
    return [await op().then(() => undefined, (err: unknown) => err), lines];
  } finally {
    for (const level of LEVELS) Reflect.deleteProperty(log, level);
  }
}

type Run = (store: RedisEmailVerificationStore) => Promise<unknown>;

interface ICell {
  op: string;
  fails: string;
  over: Override;
  type: 'ReplyError' | 'AbortError' | 'Error';
  message: string;
  previous?: string;
  password?: true;
}

const OPS: Record<string, Run> = {
  getVerdict: (s) => s.getVerdict('dns', DOMAIN),
  setVerdict: (s) => s.setVerdict('dns', DOMAIN, VERDICT, 60),
  loadLists: (s) => s.loadLists(),
  listVersion: (s) => s.listVersion(),
  upsertEntries: (s) => s.upsertEntries([{ domain: DOMAIN, kind: 'block', source: SOURCE }]),
  removeEntries: (s) => s.removeEntries('block', [DOMAIN], SOURCE),
  replaceSource: (s) => s.replaceSource(SOURCE, 'block', [DOMAIN]),
  'replaceSource to empty': (s) => s.replaceSource(SOURCE, 'block', []),
  getMeta: (s) => s.getMeta(`sync:${SOURCE}:origin`),
  setMeta: (s) => s.setMeta(`sync:${SOURCE}:origin`, ORIGIN),
};

const reads = ['getVerdict', 'listVersion', 'getMeta'];
const writes = ['setVerdict', 'setMeta'];
const transactions = ['upsertEntries', 'removeEntries', 'replaceSource', 'replaceSource to empty'];
const queuedRefused = { sadd: error(READONLY), srem: error(READONLY), del: (_: string[], queued: number) => (queued >= 0 ? error(READONLY) : undefined) };
const failedInResult = { exec: (_: string[], queued: number) => array([error(WRONGTYPE), ...Array.from({ length: queued - 1 }, () => int(1))]) };

const CELLS: ICell[] = [
  ...reads.flatMap((op): ICell[] => [
    { op, fails: 'GET: WRONGTYPE', over: { get: error(WRONGTYPE) }, type: 'ReplyError', message: WRONGTYPE },
    { op, fails: 'GET: NOAUTH', over: { get: error(NOAUTH) }, type: 'ReplyError', message: NOAUTH },
    { op, fails: 'GET: ERR', over: { get: error(ERR_ARITY) }, type: 'ReplyError', message: ERR_ARITY },
    { op, fails: 'GET: connection closed', over: { get: { close: '' } }, type: 'Error', message: CLOSED },
  ]),
  ...writes.flatMap((op): ICell[] => [
    { op, fails: 'SET: READONLY', over: { set: error(READONLY) }, type: 'ReplyError', message: READONLY },
    { op, fails: 'SET: NOAUTH', over: { set: error(NOAUTH) }, type: 'ReplyError', message: NOAUTH },
  ]),
  { op: 'loadLists', fails: 'SMEMBERS of a list: WRONGTYPE', over: { smembers: ([set]) => (set === 'ev:lists' ? undefined : error(WRONGTYPE)) }, type: 'ReplyError', message: WRONGTYPE },
  { op: 'loadLists', fails: 'SMEMBERS of the index: NOAUTH', over: { smembers: error(NOAUTH) }, type: 'ReplyError', message: NOAUTH },
  ...transactions.flatMap((op): ICell[] => [
    { op, fails: 'MULTI: a queued command READONLY, EXECABORT', over: queuedRefused, type: 'ReplyError', message: EXECABORT, previous: READONLY },
    { op, fails: 'MULTI: connection closed after MULTI', over: { multi: { close: ok } }, type: 'AbortError', message: ABORTED, previous: ABORTED },
    { op, fails: 'EXEC: a reply in the result is WRONGTYPE', over: failedInResult, type: 'ReplyError', message: WRONGTYPE },
    { op, fails: 'EXEC: aborted (nil)', over: { exec: '*-1\r\n' }, type: 'Error', message: TX_ABORTED },
  ]),
  { op: 'replaceSource', fails: 'the swap MULTI: RENAME READONLY, EXECABORT', over: { rename: error(READONLY) }, type: 'ReplyError', message: EXECABORT, previous: READONLY },
  { op: 'getVerdict', fails: 'GET: unknown command', over: { get: (args) => unknownCommand('get', args) }, type: 'ReplyError', message: redactedUnknown('get') },
  { op: 'setVerdict', fails: 'SET: unknown command', over: { set: (args) => unknownCommand('set', args) }, type: 'ReplyError', message: redactedUnknown('set') },
  { op: 'setMeta', fails: 'SET of the list origin: unknown command', over: { set: (args) => unknownCommand('set', args) }, type: 'ReplyError', message: redactedUnknown('set') },
  {
    op: 'upsertEntries',
    fails: 'MULTI: a queued SADD unknown command, EXECABORT',
    over: { sadd: (args) => unknownCommand('sadd', args) },
    type: 'ReplyError',
    message: EXECABORT,
    previous: redactedUnknown('sadd'),
  },
  ...Object.keys(OPS).map(
    (op): ICell => ({ op, fails: 'AUTH: WRONGPASS', over: { auth: error(WRONGPASS) }, type: 'ReplyError', message: WRONGPASS, previous: transactions.includes(op) ? WRONGPASS : undefined, password: true }),
  ),
];

describe('errors that leave the redis email verification store carry none of the command arguments ioredis attaches', function () {
  this.timeout(30000);

  let store: IoredisStore;

  before(async () => {
    await fake.open();
    await bootStore();
    store = await DI.resolve(IoredisStore);
    await store.dispose();
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

  it('real ioredis attaches the domain and the stored value to its errors, so these tests are not vacuous', async () => {
    const client = new Redis({ host: '127.0.0.1', port: fake.port, keyPrefix: 'ev:', lazyConnect: true, retryStrategy: () => null });
    try {
      fake.rule = replies({ get: error(WRONGTYPE), set: error(READONLY) });
      const get = await client.get(`verdict:dns:${DOMAIN}`).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(get).to.be.instanceOf(ReplyError);
      expect(get).to.have.deep.property('command', { name: 'get', args: [`ev:verdict:dns:${DOMAIN}`] });

      const exec = await client
        .multi()
        .set(`meta:sync:${SOURCE}:origin`, ORIGIN)
        .exec()
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(exec).to.have.nested.property('previousErrors[0].command.name', 'set');
      expect(leaks(printed(exec))).to.not.be.empty;
    } finally {
      client.disconnect();
    }
  });

  it("Redis's unknown-command reply quotes the domain and the list token in the message, so the redaction tests are not vacuous", async () => {
    const client = new Redis({ host: '127.0.0.1', port: fake.port, keyPrefix: 'ev:', lazyConnect: true, retryStrategy: () => null });
    try {
      fake.rule = replies({ get: (args) => unknownCommand('get', args), set: (args) => unknownCommand('set', args) });
      const get = await client.get(`verdict:dns:${DOMAIN}`).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(get).to.have.property('message', `ERR unknown command 'get', with args beginning with: 'ev:verdict:dns:${DOMAIN}' `);
      const set = await client.set(`meta:sync:${SOURCE}:origin`, ORIGIN).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(set).to.have.property('message').that.includes(LIST_TOKEN);
    } finally {
      client.disconnect();
    }
  });

  for (const cell of CELLS) {
    it(`${cell.op}, ${cell.fails}: ${cell.type} "${cell.message}" without command`, async () => {
      fake.rule = replies(cell.over);
      store.password = cell.password ? PASSWORD : undefined;
      await store.resolve();

      const [err, lines] = await logged(() => OPS[cell.op](store));

      expect(err, 'the operation fails').to.be.instanceOf(Error);
      const failure = err as Error;
      expect(failure.constructor.name).to.equal(cell.type);
      expect(failure.name).to.equal(cell.type);
      expect(failure.message).to.equal(cell.message);
      expect(Reflect.get(failure, 'code'), 'code').to.equal(undefined);
      if (cell.type === 'ReplyError') expect(failure).to.be.instanceOf(ReplyError);
      expect(Object.getOwnPropertyNames(failure)).to.not.include('command');
      const previous: unknown = Reflect.get(failure, 'previousErrors');
      if (cell.previous) {
        expect(previous, 'previousErrors are kept').to.be.an('array').that.is.not.empty;
        for (const item of previous as Error[]) {
          expect(item.message).to.equal(cell.previous);
          expect(Object.getOwnPropertyNames(item)).to.not.include('command');
        }
      } else {
        expect(previous, 'no previousErrors').to.equal(undefined);
      }
      expect(failure.cause, 'no cause').to.equal(undefined);
      expect(leaks(printed(failure)), 'runs of the domain, the list token or the password').to.deep.equal([]);
      for (const item of cell.previous ? [failure, ...(previous as Error[])] : [failure]) {
        expect(item.stack?.split('\n')[0], 'the first line of the stack').to.equal(`${item.name}: ${item.message}`);
        expect(leaks(String(item.stack)), 'in a stack').to.deep.equal([]);
      }
      expect(lines.flatMap(leaks), 'in a log line').to.deep.equal([]);
    });
  }
});
