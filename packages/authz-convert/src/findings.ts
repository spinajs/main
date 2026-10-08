/**
 * - `manual`: the converter left the key out (or wrote it as found) because it cannot convert it
 *   without guessing; a person must finish it. The CLI exits with 2 while one is open.
 * - `warning`: converted, but 3.0 behaves differently or the app must act (secrets, models, data).
 * - `info`: converted as documented; listed so the review sees it.
 */
export type Severity = 'manual' | 'warning' | 'info';

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  /** The 2.x key or role the finding is about, when there is one. */
  readonly path?: string;
  /** The config layer: 'common' or an env name such as 'prod'. */
  readonly layer?: string;
  readonly message: string;
}

/** A 2.x config the converter refuses: it writes nothing and lists every problem it found. */
export class ConversionError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`spinajs-authz-convert refused the configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConversionError';
  }
}

export class Findings {
  readonly list: Finding[] = [];
  readonly problems: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly layer?: string) {}

  add(severity: Severity, code: string, message: string, path?: string): void {
    const key = `${severity}|${code}|${path ?? ''}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ severity, code, message, ...(path === undefined ? {} : { path }), ...(this.layer === undefined ? {} : { layer: this.layer }) });
  }

  manual(code: string, message: string, path?: string): void {
    this.add('manual', code, message, path);
  }

  warn(code: string, message: string, path?: string): void {
    this.add('warning', code, message, path);
  }

  info(code: string, message: string, path?: string): void {
    this.add('info', code, message, path);
  }

  refuse(problem: string): void {
    this.problems.push(this.layer === undefined ? problem : `[${this.layer}] ${problem}`);
  }
}
