/**
 * Typed subpath exports a package's `typesVersions` map leaves out. A consumer on `moduleResolution: node` reads only
 * that map, so a package that has one must list every subpath; a package without one is resolved by `exports` alone.
 */
export function typesVersionsGaps(pkg) {
  const map = pkg.typesVersions?.['*'];
  if (!map) return [];
  return Object.entries(pkg.exports ?? {})
    .filter(([sub, target]) => sub.startsWith('./') && !sub.includes('*') && typeof target?.types === 'string')
    .filter(([sub, target]) => !(map[sub.slice(2)] ?? []).includes(target.types.replace(/^\.\//, '')))
    .map(([sub, target]) => `typesVersions has no "${sub.slice(2)}": ["${target.types.replace(/^\.\//, '')}"] for the "${sub}" export`);
}
