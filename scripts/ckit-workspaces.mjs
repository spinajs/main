// Workspaces list the ckit packages they link in a "ckit": { "packages": [...] } field; ckit is never an npm dependency (E14).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function ckitPackagesOf(manifest) {
  const list = manifest?.ckit?.packages;
  return Array.isArray(list) ? list.filter((name) => typeof name === 'string' && name !== '') : [];
}

export const isCkitWorkspace = (manifest) => ckitPackagesOf(manifest).length > 0;

export function ckitWorkspaces(root) {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
    .map((entry) => ({ dir: join(packagesDir, entry.name), manifest: JSON.parse(readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => isCkitWorkspace(manifest));
}
