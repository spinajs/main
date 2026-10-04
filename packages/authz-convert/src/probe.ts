import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Runs in a fresh Node process, so every module a config file imports runs again too. It loads what
// JsFileSource and JsonFileSource load (module default, onConfigLoad, then `default ?? cfg`), records
// which environment variables each file (and what it imports) reads, and writes the result to a file:
// stdout may carry whatever the config prints.
const SCRIPT = `
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [files, outFile] = JSON.parse(readFileSync(0, 'utf-8'));
let reads = new Set();
const env = process.env;
process.env = new Proxy(env, {
  get(t, k) { if (typeof k === 'string') reads.add(k); return t[k]; },
  has(t, k) { if (typeof k === 'string') reads.add(k); return k in t; },
});
const out = {};
for (const file of files) {
  reads = new Set();
  try {
    if (file.endsWith('.json')) {
      out[file] = { value: JSON.parse(readFileSync(file, 'utf-8')), reads: [] };
      continue;
    }
    const m = await import(pathToFileURL(file).href);
    let cfg = m.default ?? m;
    if (cfg && typeof cfg.onConfigLoad === 'function') cfg = await cfg.onConfigLoad(cfg);
    out[file] = { value: cfg == null ? undefined : (cfg.default ?? cfg), reads: [...reads] };
  } catch (err) {
    out[file] = { error: String((err && err.message) || err), reads: [...reads] };
  }
}
writeFileSync(outFile, JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
process.exit(0);
`;

const TIMEOUT_MS = 120_000;

export interface ProbeResult {
  /** File → its exported config, as JSON carries it (functions and class instances do not survive). */
  readonly values: ReadonlyMap<string, unknown>;
  /** File → environment variables it, or a module it imports first, read while loading. */
  readonly reads: ReadonlyMap<string, readonly string[]>;
  readonly errors: readonly string[];
}

/**
 * Loads `files` in a child process with `baseEnv`, NODE_ENV and APP_ENV set to `env`. `baseEnv` is the
 * environment from before the first run, so a helper that filled process.env then cannot fill it here.
 */
export function probeFiles(files: readonly string[], env: string, baseEnv: NodeJS.ProcessEnv): ProbeResult {
  const none = (error: string): ProbeResult => ({ values: new Map(), reads: new Map(), errors: [`the config files could not run under NODE_ENV=${env}: ${error}`] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-convert-probe-'));
  const outFile = path.join(dir, 'result.json');
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
      input: JSON.stringify([files, outFile]),
      env: { ...baseEnv, NODE_ENV: env, APP_ENV: env },
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (run.error) return none(run.error.message);
    if (run.status !== 0 || !fs.existsSync(outFile)) return none(run.stderr.trim() || `exit code ${String(run.status)}`);
    let parsed: Record<string, { value?: unknown; error?: string; reads: string[] }>;
    try {
      parsed = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    } catch (err) {
      return none((err as Error).message);
    }
    const errors = Object.entries(parsed)
      .filter(([, r]) => r.error !== undefined)
      .map(([file, r]) => `${file} could not run under NODE_ENV=${env}: ${r.error}`);
    return {
      values: new Map(Object.entries(parsed).map(([file, r]) => [file, r.value])),
      reads: new Map(Object.entries(parsed).map(([file, r]) => [file, r.reads])),
      errors,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
