import { DI } from '@spinajs/di';
import { IdempotencyInFlight, IdempotencyService, type IdempotencyRunOptions, type IdempotencyScope } from '@spinajs/idempotency';
import { currentReplicaId, ensure, invariant, overLimit, WriteOnceLedger, type FaultRule, type SimActor, type SimEnv, type SimSuite, type SimSystem } from '../src/index.js';

const CALLERS = ['caller-1', 'caller-2', 'caller-3'];
const LEASE = 30_000;
const SCOPE: IdempotencyScope = { namespace: 'sim', principal: 'alice' };
/**
 * Three keys are shared at a time, and every 20 steps (about 50 s) three new ones replace them. Three keys for the
 * whole seed would all hold a stored reply within a few steps, after which nothing but replays runs.
 */
const KEYS_AT_A_TIME = 3;
const STEPS_PER_KEY_SET = 20;

interface ClaimRow {
  Key: string;
  State: string;
  Token: string;
  Reply: string | null;
}

interface EffectRow {
  Key: string;
  ExecId: string;
  Token: string;
}

interface Outcome {
  caller: string;
  key: string;
  replayed: boolean;
  value: string;
}

export const IDEMPOTENCY_FAULTS: FaultRule[] = [{ point: 'idempotency.after-claim', when: { probability: 0.1 }, effect: 'crash' }];

export function idempotencySuite(o: { bypass?: boolean; faults?: FaultRule[] } = {}): SimSuite {
  return {
    name: 'idempotency',
    steps: 200,
    options: { faults: o.faults ?? IDEMPOTENCY_FAULTS, pausableReplicas: CALLERS, maxPauseMs: 2 * LEASE },
    build: (env) => buildIdempotency(env, o.bypass ?? false),
  };
}

export const IDEMPOTENCY_SUITE = idempotencySuite();

/** The `body` of the reply a `done` row stores; sqlite hands the JSON column back as text. */
function storedValue(row: ClaimRow | undefined): string | undefined {
  if (row?.State !== 'done' || !row.Reply) return undefined;
  const reply: unknown = JSON.parse(row.Reply);
  return typeof reply === 'object' && reply !== null && 'body' in reply && typeof reply.body === 'string' ? reply.body : undefined;
}

const keySet = (set: number): string[] => Array.from({ length: KEYS_AT_A_TIME }, (_, i) => `order-${set}-${i + 1}`);

async function buildIdempotency(env: SimEnv, bypass: boolean): Promise<SimSystem> {
  await env.boot({ template: 'idempotency', aliases: ['idempotency'], config: { idempotency: { store: 'OrmIdempotencyStore', lease: '30s', sweepBatch: 500 } } });
  const db = env.database.driver;
  await db.schema().createTable('sim_idem_effect', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('Key', 32).notNull();
    t.string('ExecId', 16).notNull();
    t.string('Token', 36).notNull();
    t.string('Replica', 32).notNull();
  });
  const service = await DI.resolve(IdempotencyService);

  let currentSet = 0;
  const liveKeys = (): string[] => keySet(currentSet);
  const allKeys = (): string[] => Array.from({ length: currentSet + 1 }, (_, set) => keySet(set)).flat();

  const claimRow = async (key: string): Promise<ClaimRow | undefined> => (await db.select<ClaimRow[]>().from('__idempotency').where('Key', service.scopedKey(SCOPE, key)))[0];
  const claimRows = async (): Promise<Map<string, ClaimRow>> => {
    const rows = await db.select<ClaimRow[]>().from('__idempotency');
    return new Map(rows.map((r) => [r.Key, r]));
  };
  const storedOf = (rows: Map<string, ClaimRow>, key: string): string | undefined => storedValue(rows.get(service.scopedKey(SCOPE, key)));
  const effects = async (): Promise<EffectRow[]> => await db.select<EffectRow[]>().from('sim_idem_effect');

  let executions = 0;
  const execute = (key: string) => async (): Promise<string> => {
    const execId = `x${++executions}`;
    const token = (await claimRow(key))?.Token ?? 'unclaimed';
    if (env.random.chance(0.15)) await env.park(LEASE + 5_000);
    await db.insert().into('sim_idem_effect').values({ Key: key, ExecId: execId, Token: token, Replica: currentReplicaId() });
    return execId;
  };
  const options: IdempotencyRunOptions<string> = {
    ttl: '1h',
    lease: LEASE,
    toReply: (value) => ({ kind: 'sim', body: value }),
    fromReply: (reply) => (typeof reply.body === 'string' ? reply.body : ''),
  };

  const outcomes: Outcome[] = [];
  const call = async (caller: string, key: string): Promise<void> => {
    try {
      const outcome = await service.run(SCOPE, key, execute(key), options);
      outcomes.push({ caller, key, replayed: outcome.replayed, value: outcome.value });
    } catch (err) {
      if (!(err instanceof IdempotencyInFlight)) throw err;
    }
  };
  const caller = (name: string): SimActor => ({
    name,
    replica: name,
    tick: async () => {
      // self-test only: runs the work without a claim
      if (bypass && name === 'caller-1' && !env.quiescing) {
        await execute(env.random.pick(liveKeys()))();
        return;
      }
      for (const key of env.quiescing ? allKeys() : [env.random.pick(liveKeys())]) await call(name, key);
    },
    restart: () => Promise.resolve(),
  });

  const replies = new WriteOnceLedger();
  return {
    actors: CALLERS.map(caller),
    invariants: [
      invariant('stored-reply-never-changes', async () => {
        const rows = await claimRows();
        for (const key of allKeys()) {
          const value = storedOf(rows, key);
          if (value !== undefined) replies.observe(key, value);
        }
        for (const key of replies.keys()) ensure(storedOf(rows, key) !== undefined, `the stored reply of ${key} disappeared`);
      }),
      invariant('one-execution-per-claim', async () => {
        const shared = overLimit(await effects(), (e) => `${e.Key}|${e.Token}`);
        ensure(shared.length === 0, 'two executions ran under the same claim', shared);
      }),
      invariant('stored-reply-has-one-effect-under-the-final-claim', async () => {
        const all = await effects();
        const rows = await claimRows();
        for (const key of allKeys()) {
          const row = rows.get(service.scopedKey(SCOPE, key));
          const value = storedValue(row);
          if (row === undefined || value === undefined) continue;
          const mine = all.filter((e) => e.ExecId === value);
          ensure(mine.length === 1, `the stored reply of ${key} has ${mine.length} effect rows`, value);
          ensure(mine[0].Token === row.Token, `the stored reply of ${key} comes from an execution that lost its claim`, { effect: mine[0].Token, claim: row.Token });
        }
      }),
      invariant('replays-return-the-stored-reply', async () => {
        const rows = await claimRows();
        for (const outcome of outcomes.filter((x) => x.replayed)) {
          const stored = storedOf(rows, outcome.key);
          ensure(outcome.value === stored, `${outcome.caller} replayed ${outcome.key} as ${outcome.value} while the store holds ${String(stored)}`);
        }
      }),
      invariant(
        'every-caller-gets-the-stored-reply',
        async () => {
          const rows = await claimRows();
          for (const key of allKeys()) {
            const stored = storedOf(rows, key);
            ensure(stored !== undefined, `${key} has no stored reply after quiescence`);
            for (const name of CALLERS) {
              const outcome = await service.run(SCOPE, key, () => Promise.reject(new Error(`${key} executed again after quiescence`)), options);
              ensure(outcome.replayed && outcome.value === stored, `${name} did not get the stored reply of ${key}`, outcome);
            }
          }
        },
        { final: true },
      ),
    ],
    workload: (_random, step) => {
      currentSet = Math.floor(step / STEPS_PER_KEY_SET);
      return Promise.resolve();
    },
    quiesced: async () => {
      const rows = await claimRows();
      return allKeys().every((key) => storedOf(rows, key) !== undefined);
    },
    dispose: () => Promise.resolve(),
  };
}
