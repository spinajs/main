import type { Manifest, Diagnostic, SourceRef } from '@spinajs/manifest';

export interface DoctorRule {
  code: string;
  describe: string;
  run(manifest: Manifest, ctx: DoctorContext): Diagnostic[];
}

export interface DoctorContext {
  config?: Record<string, unknown>;
  cwd: string;
  fileExists(p: string): boolean;
  fragmentMtime(pkg: string): number | undefined;
  libMtime(pkg: string): number | undefined;
}

export function diagnostic(code: string, severity: Diagnostic['severity'], message: string, source?: SourceRef): Diagnostic {
  return source ? { code, severity, message, source } : { code, severity, message };
}

export function configAt(config: Record<string, unknown> | undefined, path: string): unknown {
  let current: unknown = config;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
