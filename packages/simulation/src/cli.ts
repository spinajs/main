import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SimReport } from './simulate.js';
import { runSuite, type SuiteRegistry } from './suite.js';

export interface SimCliArgs {
  suites: string[];
  seed: number;
  seeds: number;
  steps?: number;
  out?: string;
}

export class SimUsageError extends Error {}

export const USAGE = 'usage: npm run sim -- (--suite <name> ... | --all) [--seed <n>] [--seeds <count>] [--steps <n>] [--out <dir>]';

export function parseArgs(argv: readonly string[], available: readonly string[]): SimCliArgs {
  const args: SimCliArgs = { suites: [], seed: 1, seeds: 1, steps: undefined, out: undefined };
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new SimUsageError(`${flag} needs a value`);
      return v;
    };
    const integer = (): number => {
      const v = value();
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new SimUsageError(`${flag} needs a non-negative integer`);
      return Number(v);
    };
    switch (flag) {
      case '--suite':
        args.suites.push(value());
        break;
      case '--all':
        all = true;
        break;
      case '--seed':
        args.seed = integer();
        break;
      case '--seeds':
        args.seeds = integer();
        break;
      case '--steps':
        args.steps = integer();
        break;
      case '--out':
        args.out = value();
        break;
      default:
        throw new SimUsageError(`unknown option ${flag}`);
    }
  }
  if (all) args.suites = [...available];
  if (args.suites.length === 0) throw new SimUsageError('name a suite with --suite <name> or run every suite with --all');
  const unknown = args.suites.filter((s) => !available.includes(s));
  if (unknown.length > 0) throw new SimUsageError(`unknown suite(s): ${unknown.join(', ')}; available: ${available.join(', ') || 'none'}`);
  if (args.seeds < 1) throw new SimUsageError('--seeds must be at least 1');
  return args;
}

export interface SimCliIo {
  log(line: string): void;
  writeReport(path: string, json: string): void;
}

const CONSOLE_IO: SimCliIo = {
  log: (line) => console.log(line),
  writeReport: (path, json) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json);
  },
};

export function summaryLine(suite: string, r: SimReport): string {
  const database = r.databaseFile === undefined ? '' : `; database: ${r.databaseFile}`;
  const status = r.failure ? `FAIL ${r.failure.invariant} at step ${r.failure.step}; replay: ${r.failure.replay}${database}` : 'ok';
  return `${suite} seed=${r.seed} steps=${r.steps} faults=${r.faults.length} ${status}`;
}

interface JsonAncestor {
  original: unknown;
  written: unknown;
}

/**
 * JSON.stringify drops an Error's fields, so errors are written as `{ name, message, stack, details, cause }`.
 * A report must still print when an error's details hold a BigInt or a cycle.
 */
export function reportJson(r: SimReport): string {
  const ancestors: JsonAncestor[] = [];
  return JSON.stringify(
    r,
    function (this: unknown, _key, value: unknown) {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value !== 'object' || value === null) return value;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1].written !== this) ancestors.pop();
      if (ancestors.some((a) => a.original === value)) return '[Circular]';
      const written = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, details: (value as { details?: unknown }).details, cause: value.cause } : value;
      ancestors.push({ original: value, written });
      return written;
    },
    2,
  );
}

export async function main(argv: readonly string[], registry: SuiteRegistry, io: SimCliIo = CONSOLE_IO): Promise<number> {
  let args: SimCliArgs;
  try {
    args = parseArgs(argv, Object.keys(registry).sort());
  } catch (err) {
    if (!(err instanceof SimUsageError)) throw err;
    io.log(err.message);
    io.log(USAGE);
    return 2;
  }
  // npm runs a workspace script in the package directory; INIT_CWD is where `npm run sim` was typed
  const out = args.out === undefined ? undefined : resolve(process.env.INIT_CWD ?? process.cwd(), args.out);
  let failed = 0;
  for (const name of args.suites) {
    const suite = await registry[name]();
    for (let seed = args.seed; seed < args.seed + args.seeds; seed++) {
      const report = await runSuite(suite, seed, args.steps);
      if (report.failure && args.steps !== undefined) report.failure.replay += ` --steps ${args.steps}`;
      io.log(summaryLine(name, report));
      if (!report.failure) continue;
      failed++;
      const json = reportJson(report);
      io.log(json);
      if (out) io.writeReport(join(out, `${name}-${seed}.json`), json);
    }
  }
  io.log(failed === 0 ? 'simulation: all seeds passed' : `simulation: ${failed} seed(s) failed`);
  return failed === 0 ? 0 : 1;
}
