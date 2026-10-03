import 'mocha';
import { expect } from 'chai';
import { DI, Injectable } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';

import { codePointLength, isLoginLength, LocalPasswordPolicy, LocalPasswordPolicyOptions, PASSWORD_HARD_CAP, PasswordBlocklist } from '../src/policy.js';

const DIGIT_RULE = { type: 'string', pattern: '[0-9]' };

class ListBlocklist extends PasswordBlocklist {
  public calls = 0;
  constructor(private readonly list: readonly string[]) {
    super();
  }
  public async isBlocked(password: string): Promise<boolean> {
    this.calls++;
    return this.list.includes(password);
  }
}

function policy(options: LocalPasswordPolicyOptions = {}) {
  const p = new LocalPasswordPolicy(options);
  p.resolve();
  return p;
}

function failure(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('LocalPasswordPolicy', () => {
  describe('length (A04, SR-14)', () => {
    it('7 is too short, 8 and 128 pass, 129 is too long', async () => {
      const p = policy();
      expect(await p.check('a'.repeat(7))).to.deep.equal(['too_short']);
      expect(await p.check('a'.repeat(8))).to.deep.equal([]);
      expect(await p.check('a'.repeat(128))).to.deep.equal([]);
      expect(await p.check('a'.repeat(129))).to.deep.equal(['too_long']);
    });

    it('counts code points: a 4-byte emoji counts as 1', async () => {
      const p = policy();
      const emoji = '\u{1F600}';
      expect(emoji.length).to.equal(2);
      expect(codePointLength(emoji.repeat(8))).to.equal(8);
      expect(await p.check(emoji.repeat(7))).to.deep.equal(['too_short']);
      expect(await p.check(emoji.repeat(8))).to.deep.equal([]);
      expect(await p.check(emoji.repeat(128))).to.deep.equal([]);
      expect(await p.check(emoji.repeat(129))).to.deep.equal(['too_long']);
    });

    it('never trims: leading and trailing spaces count', async () => {
      const p = policy({ minLength: 12, maxLength: 12 });
      expect(await p.check('  Abcdefg1  ')).to.deep.equal([]);
      expect(await p.check('Abcdefg1')).to.deep.equal(['too_short']);
      expect(await p.check('   Abcdefg1  ')).to.deep.equal(['too_long']);
    });

    it('never normalises: composed and decomposed forms are counted as given', async () => {
      const p = policy({ minLength: 8, maxLength: 8 });
      expect(await p.check('é'.repeat(8))).to.deep.equal([]);
      expect(await p.check('é'.repeat(8))).to.deep.equal(['too_long']);
    });

    it('honours configured bounds inside 8–128', async () => {
      const p = policy({ minLength: 10, maxLength: 20 });
      expect(await p.check('a'.repeat(9))).to.deep.equal(['too_short']);
      expect(await p.check('a'.repeat(10))).to.deep.equal([]);
      expect(await p.check('a'.repeat(21))).to.deep.equal(['too_long']);
    });

    for (const [label, opts] of [
      ['minLength below 8', { minLength: 7 }],
      ['maxLength above 128', { maxLength: 129 }],
      ['minLength above maxLength', { minLength: 20, maxLength: 10 }],
      ['a fractional minLength', { minLength: 8.5 }],
      ['a string maxLength', { maxLength: '64' as unknown as number }],
    ] as const) {
      it(`refuses ${label} at first use`, () => {
        expect(failure(() => new LocalPasswordPolicy(opts).resolve())).to.be.instanceOf(InvalidOption);
      });
    }
  });

  describe('login length (D5)', () => {
    it('is the fixed 8–128 in code points', () => {
      expect(isLoginLength('a'.repeat(7))).to.equal(false);
      expect(isLoginLength('a'.repeat(8))).to.equal(true);
      expect(isLoginLength('a'.repeat(128))).to.equal(true);
      expect(isLoginLength('a'.repeat(129))).to.equal(false);
      expect(isLoginLength('\u{1F600}'.repeat(128))).to.equal(true);
      expect(isLoginLength('  abcd  ')).to.equal(true);
    });
  });

  describe('rule', () => {
    it('refuses a password without a digit under { type: string, pattern: [0-9] }', async () => {
      const p = policy({ rule: DIGIT_RULE });
      expect(await p.check('abcdefgh')).to.deep.equal(['rule']);
      expect(await p.check('abcdefg1')).to.deep.equal([]);
    });

    it('a rule that does not compile fails at first use', () => {
      expect(failure(() => policy({ rule: { type: 'string', pattern: '(' } }))).to.be.instanceOf(InvalidOption);
      expect(failure(() => policy({ rule: { type: 'no-such-type' } }))).to.be.instanceOf(InvalidOption);
      expect(failure(() => policy({ rule: 'not a schema' as unknown as object }))).to.be.instanceOf(InvalidOption);
    });

    it('compiles the rule once', async () => {
      const p = policy({ rule: DIGIT_RULE });
      const compiled = (p as unknown as { settings: { rule: unknown } }).settings.rule;
      await p.check('abcdefgh');
      await p.check('abcdefg1');
      expect((p as unknown as { settings: { rule: unknown } }).settings.rule).to.equal(compiled);
    });
  });

  describe('policy()', () => {
    it('exposes minLength, maxLength, pattern and description', () => {
      const p = policy({ minLength: 10, maxLength: 64, rule: DIGIT_RULE, description: 'At least one digit' });
      expect(p.policy()).to.deep.equal({ minLength: 10, maxLength: 64, pattern: '[0-9]', description: 'At least one digit' });
    });

    it('leaves out pattern and description when there are none', () => {
      expect(policy().policy()).to.deep.equal({ minLength: 8, maxLength: 128 });
      expect(policy({ rule: { type: 'string', minLength: 3 } }).policy()).to.deep.equal({ minLength: 8, maxLength: 128 });
    });

    it('leaves out a blank description', () => {
      expect(policy({ description: '   ' }).policy()).to.deep.equal({ minLength: 8, maxLength: 128 });
    });
  });

  describe('blocklist', () => {
    it('refuses exactly its listed strings', async () => {
      const p = policy({ blocklist: new ListBlocklist(['Password1', 'Qwerty123']) });
      expect(await p.check('Password1')).to.deep.equal(['blocklisted']);
      expect(await p.check('Qwerty123')).to.deep.equal(['blocklisted']);
      expect(await p.check('Password2')).to.deep.equal([]);
      expect(await p.check('password1')).to.deep.equal([]);
      expect(await p.check(' Password1')).to.deep.equal([]);
    });

    it('without a hook nothing is blocklisted', async () => {
      const p = policy();
      expect(await p.check('Password1')).to.deep.equal([]);
    });

    it('returns every violation together, in order', async () => {
      const p = policy({ rule: DIGIT_RULE, blocklist: new ListBlocklist(['abc', 'x'.repeat(129)]) });
      expect(await p.check('abc')).to.deep.equal(['too_short', 'rule', 'blocklisted']);
      expect(await p.check('x'.repeat(129))).to.deep.equal(['too_long', 'rule', 'blocklisted']);
    });
  });

  describe('hard cap', () => {
    it(`above ${PASSWORD_HARD_CAP} code points only too_long comes back, without the rule or the hook`, async () => {
      expect(PASSWORD_HARD_CAP).to.equal(1024);
      const hook = new ListBlocklist(['x'.repeat(PASSWORD_HARD_CAP), 'x'.repeat(PASSWORD_HARD_CAP + 1)]);
      let ruleCalls = 0;
      const p = policy({ rule: DIGIT_RULE, blocklist: hook });
      const rule = (p as unknown as { settings: { rule: (x: string) => boolean } }).settings.rule;
      (p as unknown as { settings: { rule: (x: string) => boolean } }).settings.rule = (x: string) => {
        ruleCalls++;
        return rule(x);
      };

      expect(await p.check('x'.repeat(PASSWORD_HARD_CAP + 1))).to.deep.equal(['too_long']);
      expect(await p.check('😀'.repeat(PASSWORD_HARD_CAP + 1))).to.deep.equal(['too_long']);
      expect(ruleCalls).to.equal(0);
      expect(hook.calls).to.equal(0);

      expect(await p.check('x'.repeat(PASSWORD_HARD_CAP))).to.deep.equal(['too_long', 'rule', 'blocklisted']);
      expect(ruleCalls).to.equal(1);
      expect(hook.calls).to.equal(1);
    });
  });

  describe('generate', () => {
    it('honours length and pool', () => {
      const p = policy({ generator: { length: 20, characters: ['ab', 'c'] } });
      for (let i = 0; i < 20; i++) {
        const pw = p.generate();
        expect(codePointLength(pw)).to.equal(20);
        expect(pw).to.match(/^[abc]{20}$/);
      }
    });

    it('draws whole code points from the pool', () => {
      const p = policy({ generator: { length: 10, characters: ['\u{1F600}\u{1F601}'] } });
      const pw = p.generate();
      expect(codePointLength(pw)).to.equal(10);
      expect([...pw].every((c) => c === '\u{1F600}' || c === '\u{1F601}')).to.equal(true);
    });

    it('defaults to 16 characters from letters and digits', () => {
      const pw = policy().generate();
      expect(pw).to.match(/^[A-Za-z0-9]{16}$/);
    });

    it('output passes check, including the rule', async () => {
      const p = policy({ rule: { type: 'string', pattern: '^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])' } });
      for (let i = 0; i < 20; i++) {
        expect(await p.check(p.generate())).to.deep.equal([]);
      }
    });

    it('outputs differ', () => {
      const p = policy();
      const seen = new Set(Array.from({ length: 50 }, () => p.generate()));
      expect(seen.size).to.equal(50);
    });

    it('an empty pool throws', () => {
      expect(failure(() => policy({ generator: { length: 16, characters: [] } }).generate())).to.be.instanceOf(UnexpectedServerError);
      expect(failure(() => policy({ generator: { length: 16, characters: ['', ''] } }).generate())).to.be.instanceOf(UnexpectedServerError);
    });

    it('a length below 1 throws', () => {
      expect(failure(() => policy({ generator: { length: 0, characters: ['abc'] } }).generate())).to.be.instanceOf(UnexpectedServerError);
    });

    it('a length outside the policy bounds throws', () => {
      expect(failure(() => policy({ generator: { length: 7, characters: ['abc'] } }).generate())).to.be.instanceOf(UnexpectedServerError);
      expect(failure(() => policy({ maxLength: 20, generator: { length: 21, characters: ['abc'] } }).generate())).to.be.instanceOf(UnexpectedServerError);
      expect((failure(() => policy({ generator: { length: 7, characters: ['abc'] } }).generate()) as Error).message).to.contain('outside');
    });

    it('counts a repeated pool character once', () => {
      const p = policy({ generator: { length: 100, characters: ['aaaaaaaaab'] } });
      let bs = 0;
      for (let i = 0; i < 10; i++) {
        bs += [...p.generate()].filter((c) => c === 'b').length;
      }
      // About 500 of 1000 with de-duplication, about 100 without.
      expect(bs).to.be.greaterThan(300);
    });

    it('a rule the pool cannot satisfy throws after the attempts', () => {
      const p = policy({ rule: DIGIT_RULE, generator: { length: 16, characters: ['abc'] } });
      const error = failure(() => p.generate());
      expect(error).to.be.instanceOf(UnexpectedServerError);
      expect((error as Error).message).to.contain('attempts');
    });
  });
});

@Injectable(PasswordBlocklist)
class ConfiguredTestBlocklist extends PasswordBlocklist {
  public async isBlocked(password: string): Promise<boolean> {
    return password === 'Blocked-123';
  }
}

let configurations = 0;

// The DI registry and cache key on the class name, so every configuration needs its own.
function policyConfiguration(local: object) {
  const cls = class extends FrameworkConfiguration {
    protected onLoad(): unknown {
      return {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        authn: { local },
      };
    }
  };
  Object.defineProperty(cls, 'name', { value: `PolicyTestConfiguration${++configurations}` });
  return cls;
}

describe('LocalPasswordPolicy config wiring', function () {
  this.timeout(30_000);

  let registered: ReturnType<typeof policyConfiguration> | undefined;

  async function boot(local: object): Promise<LocalPasswordPolicy> {
    DI.setESMModuleSupport();
    registered = policyConfiguration(local);
    DI.register(registered).as(Configuration);
    await DI.resolve(Configuration);
    return DI.resolve(LocalPasswordPolicy);
  }

  afterEach(() => {
    if (registered) {
      DI.unregister(registered);
      DI.uncache(registered);
      registered = undefined;
    }
    DI.uncache(Configuration);
    DI.uncache(LocalPasswordPolicy);
  });

  after(() => {
    DI.unregister(ConfiguredTestBlocklist);
  });

  it('resolved through DI honours authn.local.policy and authn.local.generator', async () => {
    const p = await boot({
      policy: { minLength: 10, maxLength: 40, rule: DIGIT_RULE, description: 'One digit at least', blocklist: 'ConfiguredTestBlocklist' },
      generator: { length: 24, characters: ['xyz', '7'] },
    });
    expect(p.policy()).to.deep.equal({ minLength: 10, maxLength: 40, pattern: '[0-9]', description: 'One digit at least' });
    expect(await p.check('abcdefghi')).to.deep.equal(['too_short', 'rule']);
    expect(await p.check('Blocked-123')).to.deep.equal(['blocklisted']);
    expect(await p.check('Fine-12345')).to.deep.equal([]);

    // Only the length is asserted: the config loader also merges @spinajs/users' shipped `generator.characters`, and arrays
    // concatenate, so the pool here is ours plus users'.
    const pw = p.generate();
    expect(codePointLength(pw)).to.equal(24);
    expect(await p.check(pw)).to.deep.equal([]);
  });

  it('with blocklist null nothing is blocklisted', async () => {
    const p = await boot({ policy: { minLength: 9, blocklist: null } });
    expect(p.policy().minLength).to.equal(9);
    expect(await p.check('Blocked-123')).to.deep.equal([]);
  });

  it('a blocklist that failed to resolve is retried on the next check', async () => {
    await boot({ policy: { blocklist: 'ConfiguredTestBlocklist' } });

    class FlakyPolicy extends LocalPasswordPolicy {
      public attempts = 0;
      protected createBlocklist(type: Parameters<LocalPasswordPolicy['createBlocklist']>[0]) {
        if (++this.attempts === 1) {
          return Promise.reject(new Error('blocklist backend is down'));
        }
        return super.createBlocklist(type);
      }
    }

    const p = new FlakyPolicy();
    p.resolve();
    let error: unknown;
    try {
      await p.check('Blocked-123');
    } catch (e) {
      error = e;
    }
    expect((error as Error)?.message).to.equal('blocklist backend is down');
    expect(await p.check('Blocked-123')).to.deep.equal(['blocklisted']);
    expect(p.attempts).to.equal(2);
  });

  it('an unknown blocklist name fails at resolve', async () => {
    let error: unknown;
    try {
      await boot({ policy: { blocklist: 'NoSuchBlocklist' } });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
  });
});
