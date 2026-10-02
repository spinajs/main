/** Thrown by a factory that cannot apply a case's config; the case is pending (failed when claimed). */
export class UnsupportedConfig extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`unsupported config: ${keys.join(', ')}`);
    this.name = 'UnsupportedConfig';
  }
}
