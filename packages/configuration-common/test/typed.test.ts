import 'mocha';
import { expect } from 'chai';
import { expectTypeOf } from 'expect-type';
import type { Configuration, ConfigPaths } from '../src/index.js';

declare module '../src/index.js' {
  interface ConfigPaths {
    'hooks.timeoutMs': number;
    hooks: { timeoutMs: number; maxDepth: number };
  }
}

// Compile-time checks only: the function is never called.
function typeChecks(config: Configuration): void {
  expectTypeOf(config.get('hooks.timeoutMs')).toEqualTypeOf<number>();
  expectTypeOf(config.get('hooks')).toEqualTypeOf<{ timeoutMs: number; maxDepth: number }>();
  expectTypeOf(config.get('hooks.timeoutMs', 10)).toEqualTypeOf<number>();
  expectTypeOf(config.get<string>('unknown.path')).toEqualTypeOf<string>();
  expectTypeOf<ConfigPaths['hooks.timeoutMs']>().toEqualTypeOf<number>();
}

describe('typed config paths', () => {
  it('get() narrows declared paths and keeps the string overload', () => {
    expect(typeChecks).to.be.a('function');
  });
});
