import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { appRootOf, packageRootOf, type Manifest, type Diagnostic, type SourceRef } from '@spinajs/manifest';
import { compareCodeUnits } from '../sort.js';
import { DEFAULT_RULES } from './rules/index.js';

export { DEFAULT_RULES } from './rules/index.js';

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

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

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

function compare(a: Diagnostic, b: Diagnostic): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byFile = compareCodeUnits(a.source?.file ?? '', b.source?.file ?? '');
  if (byFile !== 0) return byFile;
  const byLine = (a.source?.line ?? 0) - (b.source?.line ?? 0);
  if (byLine !== 0) return byLine;
  return compareCodeUnits(a.code, b.code);
}

export function runDoctor(manifest: Manifest, ctx: DoctorContext, rules: DoctorRule[] = DEFAULT_RULES): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const rule of rules) {
    try {
      out.push(...rule.run(manifest, ctx));
    } catch (err) {
      // One broken rule must not hide the findings of the others.
      out.push(diagnostic(rule.code, 'error', `Rule ${rule.code} failed: ${(err as Error).message}`));
    }
  }
  return out.sort(compare);
}

export function createDoctorContext(manifest: Manifest, options: { cwd: string; config?: Record<string, unknown> }): DoctorContext {
  const resolve = (p: string) => (isAbsolute(p) ? p : join(options.cwd, p));
  const mtime = (p: string | undefined) => {
    if (!p || !existsSync(p)) return undefined;
    return statSync(p).mtimeMs;
  };
  // The manifest records fragments as logical node_modules/<name>/... paths; locate the package the way the runtime does, from the app root.
  const fragmentPath = (name: string): string | undefined => {
    const entry = manifest.packages.find((p) => p.name === name);
    if (!entry) return undefined;
    if (isAbsolute(entry.fragment)) return entry.fragment;
    const logical = `node_modules/${name}/`;
    const underApp = join(appRootOf(manifest, options.cwd), entry.fragment);
    if (!entry.fragment.startsWith(logical)) return underApp;
    try {
      return join(packageRootOf(name, manifest, options.cwd), entry.fragment.slice(logical.length));
    } catch {
      return underApp;
    }
  };
  return {
    cwd: options.cwd,
    config: options.config,
    fileExists: (p) => existsSync(resolve(p)),
    fragmentMtime: (name) => mtime(fragmentPath(name)),
    // The fragment sits beside the package entry (both under lib/), so the entry mtime is the build time.
    libMtime: (name) => {
      const fragment = fragmentPath(name);
      return mtime(fragment && join(dirname(fragment), 'index.js'));
    },
  };
}
