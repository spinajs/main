import { AssertionError } from 'node:assert/strict';

export interface TimingOptions {
  readonly runs?: number;
  readonly warmup?: number;
  readonly tolerance?: number;
  readonly noiseFloorMs?: number;
  readonly retries?: number;
}

export interface TimingReport {
  readonly p50a: number;
  readonly p50b: number;
  readonly diffMs: number;
  readonly limitMs: number;
  readonly pass: boolean;
  readonly attempts: number;
}

/** Gives the calls of one measurement attempt; anything slow or single-use (credentials with a fresh jti or nonce) is built here, outside the timed calls. */
export interface TimedSource {
  prepare(count: number): Promise<readonly (() => Promise<unknown>)[]>;
}

/** A source whose calls are all `fn`. */
export function repeat(fn: () => Promise<unknown>): TimedSource {
  return { prepare: async (count) => Array.from({ length: count }, () => fn) };
}

function envNumber(v: string | undefined): number | undefined {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function timingDefaults(env: NodeJS.ProcessEnv = process.env): Required<TimingOptions> {
  const ci = !!env.CI && env.CI !== '0' && env.CI.toLowerCase() !== 'false';
  return {
    runs: 200,
    warmup: 20,
    tolerance: 0.1,
    noiseFloorMs: envNumber(env.AUTHN_TESTING_TIMING_FLOOR_MS) ?? (ci ? 2 : 0.5),
    retries: envNumber(env.AUTHN_TESTING_TIMING_RETRIES) ?? (ci ? 4 : 2),
  };
}

/** Case timeout for a timing case: (retries + 1) × 2 × (warmup + runs) × perCallMs × 1.5, at least 60 s. */
export function timingTimeoutMs(opts: Required<TimingOptions>, perCallMs: number): number {
  return Math.max(60_000, (opts.retries + 1) * 2 * (opts.warmup + opts.runs) * perCallMs * 1.5);
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function measure(a: TimedSource, b: TimedSource, o: Required<TimingOptions>): Promise<Omit<TimingReport, 'attempts'>> {
  const total = o.warmup + o.runs;
  const ca = await a.prepare(total);
  const cb = await b.prepare(total);
  for (let i = 0; i < o.warmup; i++) {
    await ca[i]();
    await cb[i]();
  }
  const sa: number[] = [];
  const sb: number[] = [];
  for (let i = o.warmup; i < total; i++) {
    // Order flips every pair so drift hits both sides alike.
    if ((i - o.warmup) % 2 === 0) {
      sa.push(await timed(ca[i]));
      sb.push(await timed(cb[i]));
    } else {
      sb.push(await timed(cb[i]));
      sa.push(await timed(ca[i]));
    }
  }
  const p50a = median(sa);
  const p50b = median(sb);
  const diffMs = Math.abs(p50a - p50b);
  const limitMs = Math.max(o.tolerance * Math.max(p50a, p50b), o.noiseFloorMs);
  return { p50a, p50b, diffMs, limitMs, pass: diffMs <= limitMs };
}

async function attempts(a: TimedSource, b: TimedSource, opts?: TimingOptions): Promise<readonly TimingReport[]> {
  const defined = Object.fromEntries(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined));
  const o: Required<TimingOptions> = { ...timingDefaults(), ...defined };
  const all: TimingReport[] = [];
  for (let n = 1; n <= o.retries + 1; n++) {
    const r = { ...(await measure(a, b, o)), attempts: n };
    all.push(r);
    if (r.pass) break;
  }
  return all;
}

/** Passes when any attempt passes: |p50a − p50b| ≤ max(tolerance × max(p50a, p50b), noiseFloorMs). Returns the passing or last attempt. */
export async function compareTiming(a: TimedSource, b: TimedSource, opts?: TimingOptions): Promise<TimingReport> {
  const all = await attempts(a, b, opts);
  return all[all.length - 1];
}

export async function assertSameTiming(a: TimedSource, b: TimedSource, opts?: TimingOptions): Promise<void> {
  const all = await attempts(a, b, opts);
  const last = all[all.length - 1];
  if (!last.pass) {
    const lines = all.map((r) => `  attempt ${r.attempts}: p50a ${r.p50a.toFixed(3)} ms, p50b ${r.p50b.toFixed(3)} ms, diff ${r.diffMs.toFixed(3)} ms, limit ${r.limitMs.toFixed(3)} ms`);
    throw new AssertionError({ message: `timing differs in every attempt:\n${lines.join('\n')}` });
  }
}
