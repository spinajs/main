import 'mocha';
import { expect } from 'chai';
import { SocketException } from '@spinajs/http-socket-common';
import { TokenBucket, assertHooksConfig, assertLimitsConfig, assertPayloadSize, assertRate, payloadSize } from '../src/limits.js';

describe('socket limit primitives', () => {
  describe('payloadSize', () => {
    it('counts the UTF-8 bytes of the JSON form', () => {
      expect(payloadSize({ a: 1 })).to.equal(Buffer.byteLength('{"a":1}'));
      // two quotes + a two-byte character
      expect(payloadSize('ż')).to.equal(4);
    });

    it('counts binary parts by byte length, not by their JSON expansion', () => {
      expect(payloadSize({ bin: Buffer.alloc(1000) })).to.equal(1000 + Buffer.byteLength('{"bin":null}'));
      expect(payloadSize(new Uint8Array(10))).to.equal(10 + 4);
      expect(payloadSize(new ArrayBuffer(8))).to.equal(8 + 4);
    });

    it('treats an absent payload as empty', () => {
      expect(payloadSize(undefined)).to.equal(0);
    });
  });

  describe('TokenBucket', () => {
    let now = 0;
    const clock = () => now;

    beforeEach(() => {
      now = 0;
    });

    it('lets a burst through and then refuses', () => {
      const bucket = new TokenBucket(10, 2, clock);
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.false;
    });

    it('says how long until the next token', () => {
      const bucket = new TokenBucket(10, 1, clock);
      bucket.take();
      expect(bucket.retryAfterMs()).to.equal(100);
      now = 50;
      expect(bucket.retryAfterMs()).to.equal(50);
    });

    it('refills at the configured rate, up to the burst', () => {
      const bucket = new TokenBucket(10, 2, clock);
      bucket.take();
      bucket.take();
      now = 100;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.false;
      now = 10_000;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.false;
    });
  });

  describe('assertions', () => {
    it('refuses an oversized payload as a non-retryable resource_exhausted', () => {
      let caught: unknown;
      try {
        assertPayloadSize('x'.repeat(100), 10);
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(SocketException);
      expect((caught as SocketException).toWire()).to.deep.equal({
        code: 'resource_exhausted',
        message: 'payload of 102 bytes exceeds the limit of 10 bytes',
        retryable: false,
        details: { size: 102, limit: 10 },
      });
    });

    it('lets a payload exactly at the limit through', () => {
      expect(() => assertPayloadSize('x'.repeat(8), 10)).not.to.throw();
    });

    it('refuses an empty bucket with retryAfterMs', () => {
      let now = 0;
      const bucket = new TokenBucket(4, 1, () => now);
      bucket.take();
      let caught: unknown;
      try {
        assertRate(bucket);
      } catch (err) {
        caught = err;
      }
      expect((caught as SocketException).toWire()).to.deep.equal({ code: 'resource_exhausted', message: 'rate limit exceeded', retryable: true, retryAfterMs: 250 });
      now = 250;
      expect(() => assertRate(bucket)).not.to.throw();
    });
  });

  describe('assertHooksConfig', () => {
    it('refuses a connect hook timeout that is not a positive number', () => {
      for (const bad of [0, -1, Number.NaN, undefined, '5']) {
        expect(() => assertHooksConfig({ hooks: { connectTimeoutMs: bad as number } }), String(bad)).to.throw(RangeError);
      }
      expect(() => assertHooksConfig({ hooks: { connectTimeoutMs: 1 } })).not.to.throw();
    });
  });

  describe('assertLimitsConfig', () => {
    const ok: Parameters<typeof assertLimitsConfig>[0] = {
      rate: { perSecond: 50, burst: 100 },
      maxPayloadBytes: 1024 * 1024,
      maxInFlightPerConnection: 32,
      maxInFlightEventsPerConnection: 128,
      auth: { required: false, revalidateMs: 60_000 },
      transports: ['websocket', 'polling'],
    };
    const refuses = (patch: Record<string, unknown>, label: string) => expect(() => assertLimitsConfig({ ...ok, ...patch } as typeof ok), label).to.throw(RangeError);

    it('accepts the defaults and an event cap equal to the burst', () => {
      expect(() => assertLimitsConfig(ok)).not.to.throw();
      expect(() => assertLimitsConfig({ ...ok, maxInFlightEventsPerConnection: 100 })).not.to.throw();
    });

    it('refuses an event cap that is not an integer or is below the burst', () => {
      for (const bad of [0, -1, 1.5, 99, Number.NaN, undefined]) {
        expect(() => assertLimitsConfig({ ...ok, maxInFlightEventsPerConnection: bad as number }), String(bad)).to.throw(RangeError);
      }
    });

    it('refuses a payload limit that is not a finite integer above 0', () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, '1024']) {
        refuses({ maxPayloadBytes: bad }, String(bad));
      }
    });

    it('refuses a command in-flight cap that is not an integer above 0', () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, '32']) {
        refuses({ maxInFlightPerConnection: bad }, String(bad));
      }
    });

    it('refuses a revalidation interval that is not a finite number of at least 0, and accepts 0', () => {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '60000']) {
        refuses({ auth: { required: false, revalidateMs: bad } }, String(bad));
      }
      expect(() => assertLimitsConfig({ ...ok, auth: { required: false, revalidateMs: 0 } })).not.to.throw();
    });

    it('refuses an empty transport list or an unknown transport, and accepts either one alone', () => {
      for (const bad of [[], ['webtransport'], ['websocket', 'flash'], 'websocket', null]) {
        refuses({ transports: bad }, JSON.stringify(bad));
      }
      expect(() => assertLimitsConfig({ ...ok, transports: ['websocket'] })).not.to.throw();
      expect(() => assertLimitsConfig({ ...ok, transports: ['polling'] })).not.to.throw();
    });
  });
});
