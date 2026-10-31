import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { appRootOf, packageRootOf, type Manifest, type Diagnostic } from '@spinajs/manifest';
import { compareCodeUnits } from '../sort.js';
import { DEFAULT_RULES } from './rules/index.js';
import { diagnostic, type DoctorContext, type DoctorRule } from './rule.js';

export { DEFAULT_RULES } from './rules/index.js';
export { configAt, diagnostic, type DoctorContext, type DoctorRule } from './rule.js';

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

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
