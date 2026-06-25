/* eslint-disable @typescript-eslint/no-floating-promises */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { InternalLogger } from '@spinajs/internal-logger';
import { parseAwsPath, extractValue, resolveFallback, TtlCache, assignNested, parseBoolParam, warnUnknownParams } from '../src/utils.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('utils', () => {
  describe('parseAwsPath', () => {
    it('Should parse a plain identifier', () => {
      const r = parseAwsPath('my-secret');
      expect(r.id).to.eq('my-secret');
      expect(r.jsonPath).to.be.undefined;
      expect([...r.params.keys()]).to.be.empty;
    });

    it('Should keep slashes in the identifier', () => {
      expect(parseAwsPath('prod/app/db').id).to.eq('prod/app/db');
    });

    it('Should leave an ARN identifier untouched (colons are not delimiters)', () => {
      const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-AbCdEf';
      expect(parseAwsPath(arn).id).to.eq(arn);
    });

    it('Should split off a JSON path after #', () => {
      const r = parseAwsPath('my-secret#username');
      expect(r.id).to.eq('my-secret');
      expect(r.jsonPath).to.eq('username');
    });

    it('Should keep a dotted JSON path', () => {
      expect(parseAwsPath('my-secret#a.b.c').jsonPath).to.eq('a.b.c');
    });

    it('Should treat a trailing # as no JSON path', () => {
      expect(parseAwsPath('my-secret#').jsonPath).to.be.undefined;
    });

    it('Should parse query parameters', () => {
      const r = parseAwsPath('my-secret?versionStage=AWSPREVIOUS&versionId=v1');
      expect(r.id).to.eq('my-secret');
      expect(r.params.get('versionStage')).to.eq('AWSPREVIOUS');
      expect(r.params.get('versionId')).to.eq('v1');
    });

    it('Should parse query and JSON path together', () => {
      const r = parseAwsPath('my-secret?versionStage=AWSPREVIOUS#user.name');
      expect(r.id).to.eq('my-secret');
      expect(r.params.get('versionStage')).to.eq('AWSPREVIOUS');
      expect(r.jsonPath).to.eq('user.name');
    });

    it('Should split on the first ? only', () => {
      expect(parseAwsPath('p?a=1?b=2').id).to.eq('p');
    });
  });

  describe('extractValue', () => {
    it('Should return undefined for an undefined value', () => {
      expect(extractValue(undefined, undefined)).to.be.undefined;
      expect(extractValue(undefined, 'a')).to.be.undefined;
    });

    it('Should return the raw value when no JSON path is given', () => {
      expect(extractValue('plain', undefined)).to.eq('plain');
    });

    it('Should extract a top level key', () => {
      expect(extractValue('{"a":1}', 'a')).to.eq(1);
    });

    it('Should extract a nested key with dot notation', () => {
      expect(extractValue('{"a":{"b":"x"}}', 'a.b')).to.eq('x');
    });

    it('Should return undefined for a missing key', () => {
      expect(extractValue('{"a":1}', 'missing')).to.be.undefined;
    });

    it('Should return a sub-object when the path points at one', () => {
      expect(extractValue('{"a":{"b":1}}', 'a')).to.deep.eq({ b: 1 });
    });

    it('Should parse a Buffer payload as UTF-8 JSON', () => {
      expect(extractValue(Buffer.from('{"t":"v"}'), 't')).to.eq('v');
    });

    it('Should throw a clear error when the value is not valid JSON', () => {
      expect(() => extractValue('not json', 'a')).to.throw(/not valid JSON/);
    });
  });

  describe('parseBoolParam', () => {
    it('Should return the fallback when the parameter is missing', () => {
      expect(parseBoolParam(new URLSearchParams(''), 'k', true, 'X')).to.be.true;
    });

    it('Should parse true / false', () => {
      expect(parseBoolParam(new URLSearchParams('k=true'), 'k', false, 'X')).to.be.true;
      expect(parseBoolParam(new URLSearchParams('k=false'), 'k', true, 'X')).to.be.false;
    });

    it('Should warn and use the fallback for an invalid value', () => {
      const warn = sinon.stub(InternalLogger, 'warn');
      try {
        expect(parseBoolParam(new URLSearchParams('k=yes'), 'k', true, 'X')).to.be.true;
        expect(warn.calledOnce).to.be.true;
      } finally {
        warn.restore();
      }
    });
  });

  describe('warnUnknownParams', () => {
    it('Should warn for an unrecognized key', () => {
      const warn = sinon.stub(InternalLogger, 'warn');
      try {
        warnUnknownParams(new URLSearchParams('foo=1&versionId=2'), ['versionId'], 'X', 'id');
        expect(warn.calledOnce).to.be.true;
      } finally {
        warn.restore();
      }
    });

    it('Should not warn when every key is allowed', () => {
      const warn = sinon.stub(InternalLogger, 'warn');
      try {
        warnUnknownParams(new URLSearchParams('versionId=2'), ['versionId'], 'X', 'id');
        expect(warn.called).to.be.false;
      } finally {
        warn.restore();
      }
    });
  });

  describe('resolveFallback', () => {
    const err = new Error('boom');

    it('Should use ?default= value', () => {
      const r = resolveFallback(new URLSearchParams('default=foo'), 'X', 'id', err);
      expect(r.handled).to.be.true;
      expect(r.value).to.eq('foo');
    });

    it('Should support an empty ?default=', () => {
      const r = resolveFallback(new URLSearchParams('default='), 'X', 'id', err);
      expect(r.handled).to.be.true;
      expect(r.value).to.eq('');
    });

    it('Should resolve ?optional=true to an empty string', () => {
      const r = resolveFallback(new URLSearchParams('optional=true'), 'X', 'id', err);
      expect(r.handled).to.be.true;
      expect(r.value).to.eq('');
    });

    it('Should not handle when neither default nor optional is present', () => {
      expect(resolveFallback(new URLSearchParams(''), 'X', 'id', err).handled).to.be.false;
    });

    it('Should not handle ?optional=false', () => {
      expect(resolveFallback(new URLSearchParams('optional=false'), 'X', 'id', err).handled).to.be.false;
    });
  });

  describe('assignNested', () => {
    it('Should assign a top level key', () => {
      const o = {};
      assignNested(o, ['a'], 1);
      expect(o).to.deep.eq({ a: 1 });
    });

    it('Should create intermediate objects', () => {
      const o = {};
      assignNested(o, ['a', 'b', 'c'], 'x');
      expect(o).to.deep.eq({ a: { b: { c: 'x' } } });
    });

    it('Should merge into existing nesting', () => {
      const o: Record<string, unknown> = { a: { b: 1 } };
      assignNested(o, ['a', 'c'], 2);
      expect(o).to.deep.eq({ a: { b: 1, c: 2 } });
    });

    it('Should overwrite a non-object intermediate', () => {
      const o: Record<string, unknown> = { a: 'str' };
      assignNested(o, ['a', 'b'], 1);
      expect(o).to.deep.eq({ a: { b: 1 } });
    });
  });

  describe('TtlCache', () => {
    it('Should serve a fresh value from cache without re-running the factory', async () => {
      let now = 1000;
      const cache = new TtlCache(() => now);
      let calls = 0;
      const factory = () => Promise.resolve(++calls);

      expect(await cache.resolve('k', 1000, factory)).to.eq(1);
      expect(await cache.resolve('k', 1000, factory)).to.eq(1);
      expect(calls).to.eq(1);
    });

    it('Should refetch after the TTL elapses', async () => {
      let now = 1000;
      const cache = new TtlCache(() => now);
      let calls = 0;
      const factory = () => Promise.resolve(++calls);

      await cache.resolve('k', 1000, factory); // cached until now+1000 = 2000
      now = 2001;
      expect(await cache.resolve('k', 1000, factory)).to.eq(2);
      expect(calls).to.eq(2);
    });

    it('Should not cache when ttl <= 0 but still dedupe concurrent calls', async () => {
      const cache = new TtlCache(() => 0);
      let started = 0;
      let release!: (v: number) => void;
      const factory = () =>
        new Promise<number>((res) => {
          started++;
          release = res;
        });

      const p1 = cache.resolve('k', 0, factory);
      const p2 = cache.resolve('k', 0, factory);
      release(42);

      expect(await p1).to.eq(42);
      expect(await p2).to.eq(42);
      expect(started, 'concurrent calls should share one factory run').to.eq(1);

      // after settling, ttl<=0 means nothing is retained -> next call runs again
      let calls = 0;
      const counter = () => Promise.resolve(++calls);
      await cache.resolve('k2', 0, counter);
      await cache.resolve('k2', 0, counter);
      expect(calls).to.eq(2);
    });

    it('Should not cache failures', async () => {
      const cache = new TtlCache(() => 1000);
      let attempts = 0;
      const factory = () => {
        attempts++;
        return Promise.reject(new Error('fail'));
      };

      await expect(cache.resolve('k', 1000, factory)).to.be.rejected;
      await expect(cache.resolve('k', 1000, factory)).to.be.rejected;
      expect(attempts).to.eq(2);
    });

    it('Should drop cached values on clear()', async () => {
      const cache = new TtlCache(() => 1000);
      let calls = 0;
      const factory = () => Promise.resolve(++calls);

      await cache.resolve('k', 1000, factory);
      cache.clear();
      await cache.resolve('k', 1000, factory);
      expect(calls).to.eq(2);
    });
  });
});
