import { controllerMountPath, type ControllerEntry, type Diagnostic, type RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

function hint(c: ControllerEntry, r: RouteEntry): string {
  if (r.path.startsWith('/') && r.path !== '/') return `Remove the leading slash from the route path ('${r.path}').`;
  const mountPath = c.mountPath ?? controllerMountPath(c.basePath, c.className);
  if (mountPath !== '/') return `Remove the outer slashes from @BasePath ('${mountPath}').`;
  return "Under @BasePath('/'), give the route an explicit path.";
}

export const doubleSlashPath: DoctorRule = {
  code: 'HTTP003',
  describe: 'No route is mounted at a path with //',
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      for (const r of c.routes) {
        if (!r.fullPath.includes('//')) continue;
        const intended = r.fullPath.replace(/\/{2,}/g, '/');
        out.push(
          diagnostic('HTTP003', 'warning', `${c.className}.${r.handler} is mounted at ${r.fullPath}, not ${intended}: @spinajs/http keeps the slashes of @BasePath and the route path as written. ${hint(c, r)}`, r.source),
        );
      }
    }
    return out;
  },
};
