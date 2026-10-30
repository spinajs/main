declare const configPathsBrand: unique symbol;

/**
 * Leaf and node config paths with their value types. Packages merge into it from a generated
 * `spinajs-config.d.ts` (`spinajs generate:config-types`) or by hand:
 * `declare module '@spinajs/configuration-common' { interface ConfigPaths { 'hooks.timeoutMs': number } }`.
 */
export interface ConfigPaths {
  /** Keeps the interface non-empty; a symbol key is never a ConfigPath. */
  readonly [configPathsBrand]?: never;
}

export type ConfigPath = Extract<keyof ConfigPaths, string>;
