import { AssertionError } from 'node:assert';
import { FakeClock } from '../fakes/clock.js';
import type { Harness, Need } from '../harness/ports.js';
import { CookieJar } from '../helpers/cookies.js';
import { FACET_KINDS } from './types.js';
import type { AuthnCase, AuthnRule, BddApi, CaseKit, Facet, HarnessFactory, Prepared, RuleId, RunOptions, TestThis } from './types.js';

export const DEFAULT_CASE_TIMEOUT_MS = 10_000;
/** Bound on each cleanup step (dispose, close) once a case is over. */
export const CLEANUP_TIMEOUT_MS = 5_000;
/** Mocha's timeout exceeds the kit's own deadline by this much, so the kit's error and cleanup come first. */
export const MOCHA_SLACK_MS = 2 * CLEANUP_TIMEOUT_MS + 2_000;
export const UNTRANSCRIBED_REASON = 'not transcribed yet (PENDING_TRANSCRIPTION)';

export interface PlannedCase {
  readonly rule: AuthnRule;
  readonly kase: AuthnCase;
  /** The facet or its rule is claimed: missing needs fail instead of going pending. */
  readonly claimed: boolean;
}

export type CaseStatus = 'passed' | 'pending' | 'failed';

export interface CaseResult {
  readonly status: CaseStatus;
  /** The it title after the run (pending cases carry the missing needs). */
  readonly title: string;
  readonly error?: unknown;
}

export const bddOf = (bdd?: BddApi): BddApi => bdd ?? (globalThis as unknown as BddApi);

/** Pending cases of one suite, printed by one `after` (unless AUTHN_TESTING_SUMMARY=off). */
export class PendingLog {
  private readonly entries: { title: string; reason: string }[] = [];

  record(title: string, reason: string): void {
    this.entries.push({ title, reason });
  }

  lines(): readonly string[] {
    return this.entries.map((e) => `authn-testing pending: ${e.title} → ${e.reason}`);
  }

  register(bdd: BddApi): void {
    bdd.after(() => {
      if (process.env.AUTHN_TESTING_SUMMARY === 'off') {
        return;
      }
      for (const line of this.lines()) {
        console.log(line);
      }
    });
  }
}

/** Marks the running case pending: title suffix, summary entry, then `skip()`. Never a silent pass. */
export function markPending(t: TestThis, reason: string, log?: PendingLog, summary: string = reason): void {
  const name = t.test?.title;
  if (t.test) {
    t.test.title += ` [pending: ${reason}]`;
  }
  log?.record(name ?? '(untitled)', summary);
  t.skip();
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The error a case ends with. A failure of the body is rethrown unchanged (mocha keeps its diff), with the cleanup
 * errors attached as `cleanupErrors` and printed; without one, the cleanup errors fail the case.
 */
export function withCleanupErrors(primary: unknown, cleanup: readonly unknown[], name = 'case'): unknown {
  if (cleanup.length === 0) {
    return primary;
  }
  if (primary instanceof Error && Object.isExtensible(primary)) {
    (primary as Error & { cleanupErrors?: readonly unknown[] }).cleanupErrors = cleanup;
    console.error(`authn-testing: cleanup after the failed ${name} also failed:`, ...cleanup);
    return primary;
  }
  const all = primary === undefined ? cleanup : [primary, ...cleanup];
  const head = primary === undefined ? 'cleanup failed' : `${errorMessage(primary)} (and cleanup failed)`;
  return new AggregateError(all, `${head}: ${cleanup.map(errorMessage).join('; ')}`);
}

/** Rejects with `<what> exceeded <ms> ms` when `p` takes longer; the timer is real (FakeClock fakes Date only). */
export async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms);
  });
  p.catch(() => undefined);
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

let activeClock: FakeClock | null = null;

/**
 * A fresh clock for one case. A kit clock still installed (a case abandoned by mocha) is uninstalled first, so
 * one hang cannot fake Date for the rest of the process.
 */
export function startCaseClock(start: Date | undefined, fakeDate: boolean | undefined): FakeClock {
  activeClock?.uninstall();
  const clock = new FakeClock(start);
  if (fakeDate !== false) {
    clock.install();
  }
  activeClock = clock;
  return clock;
}

/** Runs each cleanup step once, bounded, collecting its error. */
export async function cleanUp(steps: readonly [string, (() => Promise<void>) | undefined][]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const [what, step] of steps) {
    if (step) {
      try {
        await withDeadline(step(), CLEANUP_TIMEOUT_MS, what);
      } catch (e) {
        errors.push(e);
      }
    }
  }
  return errors;
}

/** Validation (synchronous, before any registration) and facet filtering. */
export function planCasesIn(rules: ReadonlyMap<RuleId, AuthnRule>, ids: readonly RuleId[], opts: RunOptions = {}): PlannedCase[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!rules.has(id)) {
      throw new Error(`unknown rule id ${String(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate rule id ${id}`);
    }
    seen.add(id);
  }
  const inScope = (x: string): boolean => {
    if (seen.has(x)) {
      return true;
    }
    const [id, kind] = x.split('/');
    const rule = rules.get(id as RuleId);
    if (!seen.has(id) || !rule || kind === undefined) {
      return false;
    }
    // A rule still waiting for transcription has no cases; any facet kind of it is accepted.
    return rule.cases.length === 0 ? (FACET_KINDS as readonly string[]).includes(kind) : rule.cases.some((c) => c.facet === x);
  };
  for (const x of [...(opts.claim ?? []), ...(opts.facets ?? [])]) {
    if (!inScope(x)) {
      throw new Error(`claim/facet not in the requested rules: ${x}`);
    }
  }
  const claim = new Set<string>(opts.claim ?? []);
  const facets = opts.facets ? new Set<Facet>(opts.facets) : null;
  return ids.flatMap((id) => {
    const rule = rules.get(id)!;
    return rule.cases.filter((c) => !facets || facets.has(c.facet)).map((kase) => ({ rule, kase, claimed: claim.has(kase.facet) || claim.has(id) }));
  });
}

const isUnsupportedConfig = (e: unknown): e is { keys: readonly string[] } => e instanceof Error && e.name === 'UnsupportedConfig' && Array.isArray((e as { keys?: unknown }).keys);

function resolves(h: Harness, need: Need, clock: FakeClock): boolean {
  if (need === 'fakeDate') {
    return clock.installed;
  }
  if (need === 'mfa.recovery') {
    return typeof h.mfa?.step.verifyRecovery === 'function' && typeof h.mfa?.step.regenerateRecoveryCodes === 'function';
  }
  if (need.startsWith('http.routes.')) {
    const route = need.slice('http.routes.'.length) as keyof NonNullable<Harness['http']>['routes'];
    return typeof h.http?.routes[route] === 'function';
  }
  return h[need as keyof Harness] != null;
}

/**
 * Runs one case as the body of a mocha `it` (`t` is mocha's `this`): timeout, clock, prepare, factory, needs, run.
 * Resolves 'passed'; a pending case calls `t.skip()` (mocha throws there); failures reject. Harness, prepared
 * resources and the clock are released once on every exit path.
 */
export async function executeCase(p: PlannedCase, factory: HarnessFactory, opts: RunOptions, t: TestThis, log?: PendingLog): Promise<CaseStatus> {
  const kase = p.kase;
  const timeoutMs = Math.max(kase.timeoutMs ?? 0, opts.timeoutMs ?? 0) || DEFAULT_CASE_TIMEOUT_MS;
  t.timeout(timeoutMs + MOCHA_SLACK_MS);
  const clock = startCaseClock(opts.clockStart, opts.fakeDate);
  let prepared: Prepared | undefined;
  let h: Harness | undefined;
  let failed = false;
  let skipped = false;
  let primary: unknown;
  const body = async (): Promise<CaseStatus> => {
    prepared = await kase.prepare?.({ clock });
    const config = typeof kase.config === 'function' ? kase.config(prepared) : kase.config ?? {};
    let missing: string[];
    try {
      h = await factory({ rule: p.rule.id, facet: kase.facet, caseName: kase.name, clock, config });
      const built = h;
      missing = kase.needs.filter((n) => !resolves(built, n, clock));
    } catch (e) {
      if (!isUnsupportedConfig(e)) {
        throw e;
      }
      missing = e.keys.map((key) => `config:${key}`);
    }
    if (missing.length > 0) {
      if (p.claimed) {
        throw new AssertionError({ message: `claimed facet ${kase.facet} misses: ${missing.join(', ')}` });
      }
      skipped = true;
      markPending(t, `missing ${missing.join(', ')}`, log, missing.join(', '));
      return 'pending';
    }
    const kit: CaseKit = { clock, ctx: (over) => clock.ctx(over), config, prepared, jar: () => new CookieJar() };
    await kase.run(h as never, kit);
    return 'passed';
  };
  try {
    return await withDeadline(body(), timeoutMs, kase.name);
  } catch (e) {
    failed = true;
    primary = e;
    throw e;
  } finally {
    const cleanup = await cleanUp([
      ['dispose', h?.dispose ? () => h!.dispose!() : undefined],
      ['prepared.close', prepared?.close ? () => prepared!.close!() : undefined],
    ]);
    clock.uninstall();
    if (cleanup.length > 0) {
      // A skip is not a failure: the cleanup error alone fails the case.
      // eslint-disable-next-line no-unsafe-finally
      throw withCleanupErrors(failed && !skipped ? primary : undefined, cleanup, kase.name);
    }
  }
}

const SKIP = Symbol('authn-testing skip');

/** Runs one planned case outside mocha and reports its status; for mutation checks and the kit's own tests. */
export async function settleCase(p: PlannedCase, factory: HarnessFactory, opts: RunOptions = {}): Promise<CaseResult> {
  const test = { title: p.kase.name };
  const t: TestThis = {
    test,
    timeout: () => undefined,
    skip: () => {
      throw SKIP;
    },
  };
  try {
    const status = await executeCase(p, factory, opts, t);
    return { status, title: test.title };
  } catch (error) {
    return error === SKIP ? { status: 'pending', title: test.title } : { status: 'failed', title: test.title, error };
  }
}

/** runAuthnBehaviour over an explicit rule registry. */
export function runBehaviourIn(rules: ReadonlyMap<RuleId, AuthnRule>, ids: readonly RuleId[], factory: HarnessFactory, opts: RunOptions = {}): void {
  const planned = planCasesIn(rules, ids, opts);
  const bdd = bddOf(opts.bdd);
  const log = new PendingLog();
  bdd.describe(opts.title ?? 'authn behaviour', () => {
    for (const id of ids) {
      const rule = rules.get(id)!;
      const mine = planned.filter((p) => p.rule.id === id);
      const untranscribed = rule.cases.length === 0 && (!opts.facets || opts.facets.some((f) => f.startsWith(`${id}/`)));
      if (mine.length === 0 && !untranscribed) {
        continue;
      }
      bdd.describe(`${id} ${rule.title}`, () => {
        if (untranscribed) {
          bdd.it(id, async function (this: TestThis) {
            markPending(this, UNTRANSCRIBED_REASON, log);
          });
        }
        for (const p of mine) {
          bdd.it(p.kase.name, async function (this: TestThis) {
            await executeCase(p, factory, opts, this, log);
          });
        }
      });
    }
    log.register(bdd);
  });
}
