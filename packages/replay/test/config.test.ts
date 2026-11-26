import 'mocha';
import { expect } from 'chai';
import { InvalidOperation } from '@spinajs/exceptions';
import '@spinajs/log';
import { configurationViolations, createTestApp, setPastSchema } from '@spinajs/testing';

import { REPLAY_DEFAULTS, replayLimits, replayWindow } from '../src/index.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
const bad = (replay: Record<string, unknown>): Promise<string[]> => configurationViolations({ config: { logger: SILENT, replay } });
const SAFE = Number.MAX_SAFE_INTEGER;

describe('replay configuration', function () {
  this.timeout(60000);

  it('answers the defaults while no configuration is resolved', () => {
    expect(replayLimits()).to.deep.equal({ maxChanges: 50_000, maxKeys: 5_000, maxDepth: 8, maxCalls: 10_000, timeoutMs: 15_000, concurrency: 2, clockSkewMs: 1_000, commitLagMs: 5_000 });
    expect(replayLimits('authz')).to.deep.equal(REPLAY_DEFAULTS);
  });

  it('fills the defaults into replay and lays replay.domains.<domain> over replay', async () => {
    const app = await createTestApp({ config: { logger: SILENT, replay: { maxChanges: 20_000, concurrency: 4, domains: { authz: { maxChanges: 100_000, clockSkewMs: 1 } } } } });
    try {
      expect(app.config.get(['replay', 'maxKeys'])).to.equal(5_000);
      expect(replayLimits()).to.include({ maxChanges: 20_000, concurrency: 4, maxKeys: 5_000, clockSkewMs: 1_000 });
      expect(replayLimits('authz')).to.include({ maxChanges: 100_000, concurrency: 4, maxKeys: 5_000, clockSkewMs: 1 });
      expect(replayLimits('pricing')).to.deep.equal(replayLimits());
    } finally {
      await app.dispose();
    }
  });

  it('fails the boot on a misspelt key, a value out of bounds or a domain name it does not take', async () => {
    expect(await bad({ maxChange: 10 })).to.include('replay.maxChange');
    expect(await bad({ maxChanges: 500_001 })).to.include('replay.maxChanges');
    expect(await bad({ concurrency: 0 })).to.include('replay.concurrency');
    expect(await bad({ domains: { authz: { timeoutMS: 10 } } })).to.include('replay.domains.authz.timeoutMS');
    expect(await bad({ domains: { 'two words': {} } })).to.not.deep.equal([]);
    expect(await bad({ maxChanges: 500_000, maxKeys: 1, maxDepth: 1, maxCalls: 1, timeoutMs: 1, concurrency: 1, clockSkewMs: 1, commitLagMs: 1, domains: { authz: { maxChanges: 1 }, 'billing-v2': { commitLagMs: 1 } } })).to.deep.equal([]);
  });

  // ReplayHistory refuses a budget that is no safe integer, AbortSignal.timeout a delay past 2^32 - 1 (past 2^31 - 1 its
  // timer fires after 1 ms), and a window wider than the calendar scans from an invalid instant, which reads nothing.
  // A booting configuration refuses Infinity as no integer; here configurationOf's JSON round trip makes it null first.
  it('fails the boot on a value the history or the timer would refuse at the first replay, naming the key', async () => {
    expect(await bad({ maxKeys: SAFE + 1 })).to.include('replay.maxKeys');
    expect(await bad({ concurrency: SAFE + 1 })).to.include('replay.concurrency');
    expect(await bad({ domains: { authz: { clockSkewMs: 2_147_483_648 } } })).to.include('replay.domains.authz.clockSkewMs');
    expect(await bad({ commitLagMs: SAFE })).to.include('replay.commitLagMs');
    expect(await bad({ timeoutMs: 2_147_483_648 })).to.include('replay.timeoutMs');
    expect(await bad({ maxKeys: SAFE, maxDepth: SAFE, maxCalls: SAFE, timeoutMs: 2_147_483_647, concurrency: SAFE, clockSkewMs: 2_147_483_647, commitLagMs: 2_147_483_647 })).to.deep.equal([]);
  });

  // The configuration's coercion turns null and false into 0, which would narrow the window without a word.
  it('fails the boot on a window key that is null, false, Infinity, 0 or negative, naming the key', async () => {
    for (const value of [null, false, Number.POSITIVE_INFINITY, 0, -1]) {
      for (const key of ['clockSkewMs', 'commitLagMs']) {
        expect(await bad({ [key]: value }), `${key} ${String(value)}`).to.include(`replay.${key}`);
        expect(await bad({ domains: { authz: { [key]: value } } }), `authz ${key} ${String(value)}`).to.include(`replay.domains.authz.${key}`);
      }
    }
  });

  it('refuses a key or a value that got past the schema, each time it is read', async () => {
    const app = await createTestApp({ config: { logger: SILENT } });
    const reading = (domain?: string): string => {
      try {
        replayLimits(domain);
        return 'read';
      } catch (e) {
        return e instanceof InvalidOperation ? e.message : 'another error';
      }
    };
    try {
      setPastSchema(app.config, 'replay.__file__', ['config/replay.js']);
      setPastSchema(app.config, 'replay.domains.authz.maxKeys', '7');
      expect(reading()).to.equal('read');
      expect(reading('authz')).to.equal(`replay.domains.authz.maxKeys must be an integer of at least 1 and at most ${SAFE}`);
      setPastSchema(app.config, 'replay.domains.authz.maxKeys', 7);
      setPastSchema(app.config, 'replay.domains.authz.maxKey', 7);
      expect(reading('authz')).to.equal('replay.domains.authz.maxKey is not a replay setting');
      setPastSchema(app.config, 'replay.maxChanges', 900_000);
      expect(reading()).to.equal('replay.maxChanges must be an integer of at least 1 and at most 500000');
      setPastSchema(app.config, 'replay.maxChanges', 50_000);
      setPastSchema(app.config, 'replay.timeoutMs', 2.5);
      expect(reading('pricing')).to.equal('replay.timeoutMs must be an integer of at least 1 and at most 2147483647');
      setPastSchema(app.config, 'replay.timeoutMs', Number.NaN);
      expect(reading()).to.equal('replay.timeoutMs must be an integer of at least 1 and at most 2147483647');
    } finally {
      await app.dispose();
    }
  });

  it('widens the window backwards by the duration, the skew and the commit lag, forwards by the skew', () => {
    const limits = { clockSkewMs: 1_000, commitLagMs: 5_000 };
    expect(replayWindow({ durationMs: 40 }, limits)).to.deep.equal({ beforeMs: 6_040, afterMs: 1_000 });
    expect(replayWindow({ durationMs: -5 }, limits)).to.deep.equal({ beforeMs: 6_000, afterMs: 1_000 });
    expect(replayWindow({ durationMs: Number.NaN }, limits)).to.deep.equal({ beforeMs: 6_000, afterMs: 1_000 });
  });
});
