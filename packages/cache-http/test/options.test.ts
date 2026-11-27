import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { resolveResponseCacheOptions } from '../src/index.js';
import type { ResponseCacheOptions } from '../src/index.js';

const refused = (options: unknown): Error => {
  try {
    resolveResponseCacheOptions(options as ResponseCacheOptions);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal');
};

describe('@ResponseCache options', () => {
  it('fills the defaults: per principal, the default cache, no vary, no tags', () => {
    expect(resolveResponseCacheOptions({ ttl: '5m' })).to.deep.eq({ ttl: '5m', scope: 'principal', vary: [], tags: [], cache: 'default' });
  });

  it('keeps each vary header once, lower case and sorted, and the reason of a shared scope trimmed', () => {
    const resolved = resolveResponseCacheOptions({ ttl: 1000, scope: 'shared', sharedBecause: ' regional prices are public ', vary: ['X-Region', 'Accept-Language', 'x-region'], tags: ['any:invoice'], cache: 'replies' });
    expect(resolved).to.deep.eq({ ttl: 1000, scope: 'shared', sharedBecause: 'regional prices are public', vary: ['accept-language', 'x-region'], tags: ['any:invoice'], cache: 'replies' });
    expect(Object.isFrozen(resolved)).to.eq(true);
  });

  it('asks a tenant or shared scope for a reason, and only those scopes', () => {
    expect(refused({ ttl: '1m', scope: 'tenant' }).message).to.contain("scope 'tenant' gives one stored reply to many callers");
    expect(refused({ ttl: '1m', scope: 'shared', sharedBecause: '  ' }).message).to.contain("scope 'shared' gives one stored reply to many callers");
    expect(refused({ ttl: '1m', scope: 'shared', sharedBecause: 42 })).to.be.instanceOf(InvalidArgument);
    expect(refused({ ttl: '1m', sharedBecause: 'public' }).message).to.eq("@ResponseCache sharedBecause goes with scope 'tenant' or 'shared'");
  });

  it('refuses a ttl that is not a duration above 0', () => {
    for (const ttl of [undefined, 0, -5, 'soon', '0s']) {
      expect(refused({ ttl })).to.be.instanceOf(InvalidArgument);
    }
  });

  it('takes swr as a duration of 0 or more', () => {
    expect(resolveResponseCacheOptions({ ttl: '1m', swr: '10m' })).to.include({ ttl: '1m', swr: '10m' });
    expect(resolveResponseCacheOptions({ ttl: '1m', swr: 0 })).to.include({ swr: 0 });
    expect(refused({ ttl: '1m', swr: -1 })).to.be.instanceOf(InvalidArgument);
    expect(refused({ ttl: '1m', swr: 'later' })).to.be.instanceOf(InvalidArgument);
    expect(refused({ ttl: '1m', swr: null })).to.be.instanceOf(InvalidArgument);
  });

  it('refuses an unknown option, scope, vary, tag or cache name', () => {
    expect(refused({ ttl: '1m', store: 'validator' }).message).to.eq('@ResponseCache has no option store');
    expect(refused({ ttl: '1m', scope: 'user' }).message).to.contain("scope must be 'principal', 'tenant' or 'shared'");
    expect(refused({ ttl: '1m', vary: ['X Region'] }).message).to.contain('vary must be a list of request header names');
    expect(refused({ ttl: '1m', vary: ['*'] }).message).to.contain('vary must be a list of request header names');
    expect(refused({ ttl: '1m', vary: 'X-Region' }).message).to.contain('vary must be a list of non-empty strings');
    expect(refused({ ttl: '1m', tags: ['any:invoice', ''] }).message).to.contain('tags must be a list of non-empty strings');
    expect(refused({ ttl: '1m', cache: '' }).message).to.contain('cache must be the name of a cache');
  });

  it('refuses options that are not an object', () => {
    expect(refused(null)).to.be.instanceOf(InvalidArgument);
    expect(refused(['5m'])).to.be.instanceOf(InvalidArgument);
  });
});
