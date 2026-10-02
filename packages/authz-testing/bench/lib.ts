import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';

/**
 * A bench scenario. Drop a file exporting one (or an array) as default into `bench/scenarios/`;
 * the runner picks it up, so a 3.0 scenario sits next to the 2.x ones without runner changes.
 */
export interface Scenario {
  /** Unique, used as the output file name. Convention: `<area>.<what>`. */
  name: string;
  description?: string;
  /** Measured calls per repeat. */
  iterations?: number;
  /** Unmeasured calls before the first repeat. */
  warmup?: number;
  /** Name of another scenario; the table prints this one's p50/mean as a ratio of it. */
  compare?: string;
  /**
   * Calls of `run` per timed sample; the sample is divided by it. Use for operations near the
   * timer resolution (100 ns on Windows); the percentiles then describe batch means.
   */
  batch?: number;
  setup?(): void | Promise<void>;
  /**
   * Runs once after `setup`, before warm-up. Throw if `run` does not do the work this scenario
   * claims to time (wrong row count, a deny instead of a grant, ...), so nothing is timed on
   * an accidental fast path.
   */
  verify?(): void | Promise<void>;
  teardown?(): void | Promise<void>;
  /** One operation. May be sync or async; timed per call (or per `batch` calls). */
  run(): unknown;
}

export interface Stats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  opsPerSec: number;
}

export interface ScenarioResult extends Stats {
  name: string;
  description?: string;
  compare?: string;
  /** All values in nanoseconds; the headline numbers are medians over `repeats`. */
  unit: 'ns';
  iterations: number;
  warmup: number;
  batch: number;
  repeats: number;
  perRepeat: Stats[];
  env: ReturnType<typeof environment>;
}

export const DEFAULT_ITERATIONS = 100_000;
export const DEFAULT_WARMUP = 10_000;

export function environment() {
  const cpu = cpus();
  return {
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpu[0]?.model.trim() ?? 'unknown',
    cores: cpu.length,
  };
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: Float64Array, p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summarize(samples: Float64Array): Stats {
  const sorted = Float64Array.from(samples).sort();
  let sum = 0;
  for (const v of samples) {
    sum += v;
  }
  const mean = sum / samples.length;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean,
    opsPerSec: 1e9 / mean,
  };
}

async function measure(scenario: Scenario, iterations: number, batch: number): Promise<Stats> {
  const samples = new Float64Array(iterations);
  const first = scenario.run();

  if (isThenable(first)) {
    await first;
    for (let i = 0; i < iterations; i++) {
      const t0 = process.hrtime.bigint();
      for (let b = 0; b < batch; b++) {
        await scenario.run();
      }
      samples[i] = Number(process.hrtime.bigint() - t0) / batch;
    }
  } else {
    for (let i = 0; i < iterations; i++) {
      const t0 = process.hrtime.bigint();
      for (let b = 0; b < batch; b++) {
        scenario.run();
      }
      samples[i] = Number(process.hrtime.bigint() - t0) / batch;
    }
  }

  return summarize(samples);
}

export interface RunOptions {
  repeats: number;
  /** Scales iterations/warmup down for smoke runs. */
  scale?: number;
  outDir?: string;
}

/** Runs one scenario `repeats` times; each headline number is the median across repeats. */
export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const scale = opts.scale ?? 1;
  const iterations = Math.max(10, Math.round((scenario.iterations ?? DEFAULT_ITERATIONS) * scale));
  const warmup = Math.max(1, Math.round((scenario.warmup ?? DEFAULT_WARMUP) * scale));

  const batch = Math.max(1, scenario.batch ?? 1);

  await scenario.setup?.();
  try {
    try {
      await scenario.verify?.();
    } catch (err) {
      throw new Error(`verify failed for ${scenario.name}: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (let i = 0; i < warmup; i++) {
      await scenario.run();
    }

    const perRepeat: Stats[] = [];
    for (let r = 0; r < opts.repeats; r++) {
      perRepeat.push(await measure(scenario, iterations, batch));
    }

    const result: ScenarioResult = {
      name: scenario.name,
      description: scenario.description,
      compare: scenario.compare,
      unit: 'ns',
      iterations,
      warmup,
      batch,
      repeats: opts.repeats,
      p50: median(perRepeat.map((s) => s.p50)),
      p95: median(perRepeat.map((s) => s.p95)),
      p99: median(perRepeat.map((s) => s.p99)),
      mean: median(perRepeat.map((s) => s.mean)),
      opsPerSec: median(perRepeat.map((s) => s.opsPerSec)),
      perRepeat,
      env: environment(),
    };

    const outDir = opts.outDir ?? join(process.cwd(), 'bench', 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${scenario.name}.json`), JSON.stringify(result, null, 2));

    return result;
  } finally {
    await scenario.teardown?.();
  }
}

const fmtUs = (ns: number) => (ns / 1000).toFixed(ns < 10_000 ? 2 : 1);

export function formatTable(results: ScenarioResult[]): string {
  const byName = new Map(results.map((r) => [r.name, r]));
  const rows = results.map((r) => {
    const base = r.compare ? byName.get(r.compare) : undefined;
    return [r.name, fmtUs(r.p50), fmtUs(r.p95), fmtUs(r.p99), fmtUs(r.mean), Math.round(r.opsPerSec).toLocaleString('en-US'), base ? `${(r.p50 / base.p50).toFixed(2)}x / ${(r.mean / base.mean).toFixed(2)}x` : ''];
  });
  const header = ['scenario', 'p50 us', 'p95 us', 'p99 us', 'mean us', 'ops/s', 'vs compare (p50 / mean)'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');

  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
