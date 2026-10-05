/**
 * Loads `specifier`, or answers undefined when that package itself is not installed. A package that is installed but
 * fails to load (one of its own dependencies missing, or an error at load) rethrows.
 */
export async function importIfInstalled(specifier: string, load: (s: string) => Promise<unknown> = (s) => import(s)): Promise<unknown> {
  try {
    return await load(specifier);
  } catch (e) {
    const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
    // ESM: "Cannot find package '<x>' imported from ..."; CJS: "Cannot find module '<x>'" then the require stack.
    const firstLine = typeof message === 'string' ? message.split('\n')[0] : '';
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && firstLine.includes(`'${specifier}'`)) return undefined;
    throw e;
  }
}
