export const MANIFEST_PATH = 'lib/manifest.fragment.json';

export function addManifestField(pkg) {
  if (pkg.spinajs?.manifest === MANIFEST_PATH) return pkg;
  return { ...pkg, spinajs: { ...pkg.spinajs, manifest: MANIFEST_PATH } };
}

/** True when an npm `files` entry would publish the fragment. */
export function manifestInFiles(pkg) {
  const target = (pkg.spinajs?.manifest ?? MANIFEST_PATH).replace(/^\.\//, '');
  const files = pkg.files;
  if (!Array.isArray(files)) return true;
  return files.some((entry) => {
    const e = entry.replace(/^\.\//, '').replace(/\/(\*\*\/?\*?|\*)?$/, '');
    return e === target || target.startsWith(`${e}/`);
  });
}
