import { spawnSync } from 'node:child_process';

// Runs in a fresh Node process, so every module a config file imports runs again too. It loads what
// JsFileSource and JsonFileSource load (module default, onConfigLoad, then `default ?? cfg`).
const SCRIPT = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const files = JSON.parse(readFileSync(0, 'utf-8'));
const out = {};
for (const file of files) {
  try {
    if (file.endsWith('.json')) {
      out[file] = { value: JSON.parse(readFileSync(file, 'utf-8')) };
      continue;
    }
    const m = await import(pathToFileURL(file).href);
    let cfg = m.default ?? m;
    if (typeof cfg.onConfigLoad === 'function') cfg = await cfg.onConfigLoad(cfg);
    out[file] = { value: cfg.default ?? cfg };
  } catch (err) {
    out[file] = { error: String((err && err.message) || err) };
  }
}
process.stdout.write(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
`;

export interface ProbeResult {
  /** File → its exported config, as JSON carries it (functions and class instances do not survive). */
  readonly values: ReadonlyMap<string, unknown>;
  readonly errors: readonly string[];
}

/** Loads `files` in a child process whose NODE_ENV and APP_ENV are `env`. */
export function probeFiles(files: readonly string[], env: string): ProbeResult {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    input: JSON.stringify(files),
    env: { ...process.env, NODE_ENV: env, APP_ENV: env },
    cwd: process.cwd(),
    encoding: 'utf-8',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (run.error || run.status !== 0) return { values: new Map(), errors: [`the config files could not run under NODE_ENV=${env}: ${run.error?.message ?? run.stderr.trim()}`] };
  const parsed = JSON.parse(run.stdout) as Record<string, { value?: unknown; error?: string }>;
  const errors = Object.entries(parsed)
    .filter(([, r]) => r.error !== undefined)
    .map(([file, r]) => `${file} could not run under NODE_ENV=${env}: ${r.error}`);
  return { values: new Map(Object.entries(parsed).map(([file, r]) => [file, r.value])), errors };
}
