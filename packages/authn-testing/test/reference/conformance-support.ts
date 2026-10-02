import type { AuthenticationStrategy, Credentials } from '@spinajs/authn/contracts';
import type { BddApi, TestThis } from '../../src/conformance/bdd.js';
import type { StrategySubject, StrategySubjectFactory } from '../../src/conformance/strategy.js';
import { FakeIdentityStore, FakeStrategy, MemoryPasswordCredentialStore, RecordingEventSink, fakeSeedPort } from '../../src/fakes/index.js';

export type CaseStatus = 'passed' | 'failed' | 'pending';
export interface CaseOutcome {
  readonly title: string;
  readonly status: CaseStatus;
  readonly error?: unknown;
}

const SKIP = Symbol('skip');

/** Registers a suite on a collecting BddApi, then runs every case in order. */
export async function runSuite(register: (bdd: BddApi) => void): Promise<CaseOutcome[]> {
  const cases: { title: string; fn: (this: TestThis) => Promise<void> }[] = [];
  register({
    describe: (_title, fn) => fn(),
    it: (title, fn) => void cases.push({ title, fn }),
    after: () => undefined,
  });
  const out: CaseOutcome[] = [];
  for (const c of cases) {
    const test = { title: c.title };
    const self: TestThis = {
      test,
      skip: () => {
        throw SKIP;
      },
      timeout: () => undefined,
    };
    try {
      await c.fn.call(self);
      out.push({ title: test.title, status: 'passed' });
    } catch (error) {
      out.push(error === SKIP ? { title: test.title, status: 'pending' } : { title: test.title, status: 'failed', error });
    }
  }
  return out;
}

export const failedTitles = (r: readonly CaseOutcome[]) => r.filter((c) => c.status === 'failed').map((c) => c.title);
export const pendingTitles = (r: readonly CaseOutcome[]) => r.filter((c) => c.status === 'pending').map((c) => c.title);

export const FAST_TIMING = { runs: 30, warmup: 3, retries: 1 } as const;

export const CASE = {
  declared: 'conformance: name, kinds and interactive are declared',
  accepts: 'conformance: verify accepts valid credentials',
  alike: 'conformance: verify answers invalid and unknown credentials alike without throwing',
  undeclared: 'conformance: an undeclared kind is unsupported_credentials',
  sideEffects: 'conformance: verify has no session or event side effects',
  stable: 'conformance: throttle keys are stable',
  noSecret: 'conformance: throttle key values carry no secret',
  accountKeys: 'conformance: a non-interactive strategy returns account and account-ip keys from a stable id',
  timing: 'conformance: A02 verify takes the same time for unknown accounts',
} as const;

export interface SubjectEnv {
  readonly events: RecordingEventSink;
  readonly sessions: { n: number; count(): Promise<number> };
}

const newEnv = (): SubjectEnv => {
  const env: SubjectEnv = { events: new RecordingEventSink(), sessions: { n: 0, count: async () => env.sessions.n } };
  return env;
};

const PASSWORD = 'right-password-1';

export function passwordSubject(tweak: (s: FakeStrategy, env: SubjectEnv) => AuthenticationStrategy = (s) => s, over: Partial<StrategySubject> = {}): StrategySubjectFactory {
  return async () => {
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    await fakeSeedPort(identities, passwords).user({ login: 'conf-alice', password: PASSWORD });
    const env = newEnv();
    const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });
    return {
      strategy: tweak(FakeStrategy.password({ identities, passwords }), env),
      valid: async () => pw('conf-alice', PASSWORD),
      invalid: async () => pw('conf-alice', 'wrong-password-1'),
      unknown: async () => pw('conf-nobody', 'wrong-password-1'),
      secretsOf: (c) => [String((c as { password: string }).password)],
      sessions: env.sessions,
      events: env.events,
      ...over,
    };
  };
}

export function bearerSubject(tweak: (s: FakeStrategy, env: SubjectEnv) => AuthenticationStrategy = (s) => s): StrategySubjectFactory {
  return async () => {
    const env = newEnv();
    const token = 'spt_conformance_token_0001';
    const strategy = FakeStrategy.bearer({ tokens: new Map([[token, { type: 'user', id: 'u-1' }]]) });
    return {
      strategy: tweak(strategy, env),
      valid: async () => ({ kind: 'bearer', token }),
      invalid: async () => ({ kind: 'bearer', token: 'spt_conformance_wrong_0002' }),
      unknown: async () => ({ kind: 'bearer', token: 'spt_conformance_wrong_0003' }),
      sameId: async () => ({ kind: 'bearer', token }),
      secretsOf: (c) => [String((c as { token: string }).token)],
      sessions: env.sessions,
      events: env.events,
    };
  };
}

export function externalSubject(): StrategySubjectFactory {
  return async () => {
    const env = newEnv();
    const strategy = FakeStrategy.external({ provider: 'fake-idp', subjects: new Map([['sub-1', { provider: 'fake-idp', subject: 'sub-1', email: 'a@example.test', emailVerified: true }]]) });
    return {
      strategy,
      valid: async () => ({ kind: 'external', provider: 'fake-idp', payload: { subject: 'sub-1' } }),
      invalid: async () => ({ kind: 'external', provider: 'fake-idp', payload: { subject: 'bogus' } }),
      secretsOf: () => [],
      sessions: env.sessions,
      events: env.events,
    };
  };
}

/** A strategy that behaves like `inner` except for the given members. */
export function wrap(inner: AuthenticationStrategy, over: Partial<Pick<AuthenticationStrategy, 'verify' | 'throttleKeys' | 'kinds' | 'name'>>): AuthenticationStrategy {
  return Object.assign(Object.create(inner), over);
}
