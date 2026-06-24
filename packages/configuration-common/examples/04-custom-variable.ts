/**
 * Defining your own global variable.
 *
 * Extend `ConfigVariable` and register it with `@Injectable(ConfigVariable)`.
 * On the first format() call every registered ConfigVariable is resolved from
 * the DI container and cached, so your variable becomes usable as `${name}`
 * everywhere — including inside configuration files.
 *
 * REGISTRATION IS REQUIRED AND MUST USE THE BASE TYPE:
 *   - `@Injectable(ConfigVariable)` registers the class under the
 *     `ConfigVariable` token; format() collects ALL of them via
 *     `Array.ofType(ConfigVariable)`. `@Injectable()` with no argument would
 *     register the class only as itself and `${appname}` would expand to ''.
 *   - The decorator runs when this module is imported. In a SpinaJS app the
 *     framework loads your modules for you; standalone you must import the file
 *     (a side-effect import is enough) BEFORE the first format() call, because
 *     format() caches the variable set on first use.
 *
 * Run:
 *   npx ts-node examples/04-custom-variable.ts
 */
import { Injectable } from '@spinajs/di';
import { ConfigVariable, format } from '@spinajs/configuration-common';

@Injectable(ConfigVariable)
export class AppNameVariable extends ConfigVariable {
  public get Name(): string {
    return 'appname';
  }

  // the `:option` part (if any) arrives here as `option`
  public Value(option?: string): string {
    const name = 'spinajs-demo';
    return option === 'upper' ? name.toUpperCase() : name;
  }
}

// No need to pass the variable in — it is discovered through DI.
console.log(format(null, 'Running ${appname} (${appname:upper}) on pid ${pid}'));

// Custom vars passed to format() still take precedence over globals of the
// same name, which is handy for per-call overrides.
console.log(format({ appname: 'override' } as any, 'name = ${appname}')); // "name = override"
