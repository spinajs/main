/**
 * Protocol-backed config values — `ConfigVarProtocol` + `ConfigVar`.
 *
 * The concrete `@spinajs/configuration` module lets a config entry be a string
 * like `"aws-secret://db/password"`. The prefix before `://` selects a
 * `ConfigVarProtocol` implementation that knows how to resolve it (a secret
 * manager, the database, a vault, ...). This file shows the shape you implement
 * — it is a definition example, the resolution itself is driven by the
 * configuration module at load time.
 *
 * `ConfigVar` is a tiny lazy wrapper: return one from `getVar` when the real
 * value must only be computed after all modules are resolved; it memoizes the
 * first `get()`.
 *
 * REGISTRATION IS REQUIRED: a protocol is only picked up after it is registered
 * in the DI container under the `ConfigVarProtocol` token — that is exactly what
 * `@Injectable(ConfigVarProtocol)` does. The configuration module then resolves
 * every class registered under that token. As with variables, the decorator
 * runs when the module is imported; a SpinaJS app loads it for you, standalone
 * you must import the file. Because `ConfigVarProtocol` extends `AsyncService`,
 * it is initialized asynchronously at config load time.
 */
import { Injectable } from '@spinajs/di';
import { ConfigVarProtocol, ConfigVar } from '@spinajs/configuration-common';

@Injectable(ConfigVarProtocol)
export class EnvProtocol extends ConfigVarProtocol {
  // handles values written as `env://SOME_VAR`
  public get Protocol(): string {
    return 'env://';
  }

  // `path` is the value with the protocol stripped (e.g. "SOME_VAR").
  // `configuration` is the whole Configuration instance, in case resolving
  // this var depends on other already-loaded config.
  public async getVar(path: string, _configuration: any): Promise<string | ConfigVar | undefined> {
    // Resolve eagerly...
    if (process.env[path] !== undefined) {
      return process.env[path];
    }

    // ...or hand back a lazy holder that is only computed (once) on first use.
    return new ConfigVar(() => process.env[path] ?? `<${path} not set>`);
  }
}

// Illustrative: a lazy value is computed at most once.
const lazy = new ConfigVar(() => {
  console.log('computing lazy value...');
  return 42;
});
console.log(lazy.get()); // logs "computing lazy value..." then 42
console.log(lazy.get()); // 42 (no recompute)
