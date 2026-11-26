import { expect } from 'chai';
import 'mocha';
import { Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { createTestApp } from '@spinajs/testing';
import { CacheScope, cache, cacheKey, scopeSegments } from '../src/index.js';

const answers = new Map<string, readonly string[] | null>();

abstract class Answering extends CacheScope {
  public segments(): readonly string[] | null {
    return answers.get(this.constructor.name) ?? [];
  }
}
class ScopeA extends Answering {}
class ScopeB extends Answering {}
class ScopeC extends Answering {}
class Scopea extends Answering {}

function containerOf(...scopes: (typeof ScopeA)[]): IContainer {
  const container = new Container();
  for (const scope of scopes) container.register(scope).as(CacheScope);
  return container;
}

// Park-Miller: the same cases on every run, so a failure can be reproduced.
function random(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 48_271) % 2_147_483_647;
    return state % below;
  };
}

const ATOMS = ['', '/', '//', '%', '%25', '0', '1', '2', '5', '10', 'undefined', 'null', 'a', 'B=5', ' ', 'é', '日本', '😀', 'tenant:5'];

describe('CacheScope keys', () => {
  afterEach(() => answers.clear());

  it('never gives two different scope answers one store key, and one answer always the same key', () => {
    const scopes = [ScopeA, ScopeB, ScopeC];
    // Every subset of the three scopes, so that processes registering different scopes are compared too.
    const cases = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => {
      const subset = scopes.filter((_, i) => Math.floor(mask / 2 ** i) % 2 === 1);
      return { subset, container: containerOf(...subset) };
    });
    const next = random(20_261_126);
    const text = (): string => Array.from({ length: next(4) }, () => ATOMS.at(next(ATOMS.length)) ?? '').join('');
    const seen = new Map<string, string>();
    for (let round = 0; round < 500; round += 1) {
      for (const { subset, container } of cases) {
        const input = subset.map((scope) => [scope.name, Array.from({ length: next(4) }, text)] as const);
        for (const [name, parts] of input) answers.set(name, parts);
        const own = text();
        const key = cacheKey('default', own, scopeSegments(container) ?? []);
        expect(cacheKey('default', own, scopeSegments(container) ?? [])).to.eq(key);
        const identity = JSON.stringify([input, own]);
        expect(seen.get(key) ?? identity, key).to.eq(identity);
        seen.set(key, identity);
        answers.clear();
      }
    }
  });

  it('keeps the entry of scope answers A=[] B=[5] from a read under A=[5] B=[]', async () => {
    const app = await createTestApp({ config: { cache: { caches: { default: {} } } }, register: (container) => [ScopeA, ScopeB].map((scope) => container.register(scope).as(CacheScope)) });
    try {
      answers.set('ScopeA', []).set('ScopeB', ['5']);
      await cache().set('k', 'B=5', { ttl: '1m' });
      answers.set('ScopeA', ['5']).set('ScopeB', []);
      expect(await cache().get('k')).to.eq(undefined);
    } finally {
      await app.dispose();
    }
  });

  // Fails with localeCompare, which puts 'Scopea' before 'ScopeB'.
  it('orders scopes by the code units of their class names', () => {
    answers.set('ScopeB', ['b']).set('Scopea', ['a']);
    expect(scopeSegments(containerOf(Scopea, ScopeB))).to.deep.eq(['ScopeB', '1', 'b', 'Scopea', '1', 'a']);
  });
});
