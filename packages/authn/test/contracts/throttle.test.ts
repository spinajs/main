import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { AuthnThrottle } from '../../src/contracts/throttle.js';
import type { ThrottleFlow, ThrottleKey } from '../../src/contracts/throttle.js';
import type { AuthnContext } from '../../src/contracts/credentials.js';
import * as index from '../../src/contracts/index.js';
import { memberDocs } from './source-shape.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

type Attempt = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

const at = (ms: number): AuthnContext => ({ now: new Date(ms), ip: '10.0.0.1', purpose: 'login' });
const keysFor = (login: string): ThrottleKey[] => [
  { kind: 'account', value: login },
  { kind: 'account-ip', value: `${login}|10.0.0.1` },
  { kind: 'ip', value: '10.0.0.1' },
];

// The r4 backoff with free = 2, 1 s doubling, no cap; account-ip gates nothing.
class MemoryThrottle extends AuthnThrottle {
  readonly rows = new Map<string, { attempts: number; nextAllowedAt: number }>();
  private row(flow: ThrottleFlow, k: ThrottleKey) {
    const id = `${flow}|${k.kind}|${k.value}`;
    if (!this.rows.has(id)) this.rows.set(id, { attempts: 0, nextAllowedAt: 0 });
    return this.rows.get(id)!;
  }
  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<Attempt> {
    const now = ctx.now.getTime();
    const wait = Math.max(0, ...keys.filter((k) => k.kind !== 'account-ip').map((k) => this.row(flow, k).nextAllowedAt - now));
    if (wait > 0) return { allowed: false, retryAfterSeconds: Math.ceil(wait / 1000) };
    for (const k of keys) {
      const r = this.row(flow, k);
      r.attempts += 1;
      r.nextAllowedAt = r.attempts >= 2 ? now + 1000 * 2 ** (r.attempts - 2) : now;
    }
    return { allowed: true };
  }
  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    const pair = keys.find((k) => k.kind === 'account-ip');
    const spent = pair ? this.row(flow, pair).attempts : 0;
    for (const k of keys) {
      if (k.kind === 'ip') this.row(flow, k).attempts -= spent;
      else this.rows.delete(`${flow}|${k.kind}|${k.value}`);
    }
  }
}

interface MemberShape {
  name: string;
  modifiers: string[];
  optional: boolean;
  params: string[] | null;
  doc: string;
}

interface ClassShape {
  base: string | null;
  doc: string;
  members: MemberShape[];
}

const docText = (n: ts.Node, sf: ts.SourceFile) =>
  ts
    .getJSDocCommentsAndTags(n)
    .map((d) => d.getText(sf))
    .join(' ');

function classMembers(file: string): Record<string, ClassShape> {
  const sf = ts.createSourceFile(file, readFileSync(join(SRC_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const out: Record<string, ClassShape> = {};
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || !n.name) return;
    const heritage = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    out[n.name.text] = {
      base: heritage ? heritage.types[0].expression.getText(sf) : null,
      doc: docText(n, sf),
      members: n.members.map((m) => ({
        name: m.name ? m.name.getText(sf) : '',
        modifiers: (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).map((x) => x.getText(sf)),
        optional: (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && !!m.questionToken,
        params: ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
        doc: docText(m, sf),
      })),
    };
  });
  return out;
}

const docOf = (members: MemberShape[], name: string) => members.find((m) => m.name === name)?.doc ?? '';

describe('throttle contract', () => {
  describe('runtime', () => {
    it('exports AuthnThrottle from the contracts index as a plain abstract class', () => {
      expect(index.AuthnThrottle).to.eq(AuthnThrottle);
      expect(AuthnThrottle).to.be.a('function');
      expect(Object.getPrototypeOf(AuthnThrottle)).to.eq(Function.prototype);
    });

    it('a concrete throttle backs off, never locks, and does not count refused attempts', async () => {
      const t = new MemoryThrottle();
      const mallory = keysFor('alice');
      expect(await t.attempt(mallory, 'login', at(0))).to.deep.eq({ allowed: true });
      expect(await t.attempt(mallory, 'login', at(0))).to.deep.eq({ allowed: true });
      expect(await t.attempt(mallory, 'login', at(0))).to.deep.eq({ allowed: false, retryAfterSeconds: 1 });
      expect(await t.attempt(mallory, 'login', at(500))).to.deep.eq({ allowed: false, retryAfterSeconds: 1 });
      expect(t.rows.get('login|account|alice')!.attempts).to.eq(2);
      expect(await t.attempt(mallory, 'login', at(1000))).to.deep.eq({ allowed: true });
      expect(await t.attempt(mallory, 'login', at(2000))).to.deep.eq({ allowed: false, retryAfterSeconds: 1 });
      expect(await t.attempt(mallory, 'login', at(3000))).to.deep.eq({ allowed: true });
      expect(await t.attempt(mallory, 'mfa', at(3000))).to.deep.eq({ allowed: true });
    });

    it('a success resets the account key and takes only its attempts off the IP key', async () => {
      const t = new MemoryThrottle();
      await t.attempt(keysFor('alice'), 'login', at(0));
      await t.attempt(keysFor('bob'), 'login', at(0));
      expect(t.rows.get('login|ip|10.0.0.1')!.attempts).to.eq(2);
      await t.succeed(keysFor('bob'), 'login');
      expect(t.rows.has('login|account|bob')).to.eq(false);
      expect(t.rows.get('login|account|alice')!.attempts).to.eq(1);
      expect(t.rows.get('login|ip|10.0.0.1')!.attempts).to.eq(1);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('throttle.ts holds AuthnThrottle with the design members', () => {
      const c = classMembers('throttle.ts');
      expect(Object.keys(c)).to.deep.eq(['AuthnThrottle']);
      expect(c.AuthnThrottle.base).to.eq(null);
      expect(c.AuthnThrottle.members.map(({ doc: _doc, ...rest }) => rest)).to.deep.eq([
        { name: 'attempt', modifiers: ['abstract'], optional: false, params: ['keys', 'flow', 'ctx'] },
        { name: 'succeed', modifiers: ['abstract'], optional: false, params: ['keys', 'flow'] },
        { name: 'checkConfiguration', modifiers: [], optional: true, params: ['configuration'] },
      ]);
    });

    it('docs state the r4 rules', () => {
      const c = classMembers('throttle.ts').AuthnThrottle;
      expect(c.doc).to.contain('Backoff, never a lock');
      expect(c.doc).to.contain('H31');
      const attempt = docOf(c.members, 'attempt');
      expect(attempt).to.contain('Counts the attempt and claims its slot atomically: before verification for interactive strategies, after a failure for');
      expect(attempt).to.contain('per-request ones (K5)');
      expect(attempt).to.contain('a refused attempt is not counted');
      expect(attempt).to.contain('A05');
      expect(attempt).to.contain('A06');
      expect(attempt).to.contain('Retry-After');
      expect(docOf(c.members, 'succeed')).to.contain("Resets the account key and removes that account's attempts from the IP key");
      expect(docOf(c.members, 'succeed')).to.contain("For 'reset' nothing is cleared; only time clears those keys");
      for (const s of ['The caller passes the plain value', 'keyed hash', 'personal data', 'SR-19']) expect(memberDocs('throttle.ts', 'ThrottleKey').value).to.contain(s);
    });
  });

  describe('types', () => {
    it('re-exports the throttle types from the contracts index', () => {
      same<index.AuthnThrottle, AuthnThrottle>(true);
      same<index.ThrottleFlow, ThrottleFlow>(true);
      same<index.ThrottleKey, ThrottleKey>(true);
    });

    it('ThrottleFlow is exactly the four flows', () => {
      same<ThrottleFlow, 'login' | 'mfa' | 'reset' | 'reauth'>(true);
      // @ts-expect-error no signup flow
      const f: ThrottleFlow = 'signup';
      void f;
    });

    it('members have the design types', () => {
      same<Parameters<AuthnThrottle['attempt']>, [readonly ThrottleKey[], ThrottleFlow, AuthnContext]>(true);
      same<ReturnType<AuthnThrottle['attempt']>, Promise<Attempt>>(true);
      same<Parameters<AuthnThrottle['succeed']>, [readonly ThrottleKey[], ThrottleFlow]>(true);
      same<ReturnType<AuthnThrottle['succeed']>, Promise<void>>(true);
    });

    it('the attempt result narrows on allowed', async () => {
      const r = await new MemoryThrottle().attempt(keysFor('alice'), 'reset', at(0));
      // @ts-expect-error retryAfterSeconds exists only on a refusal
      const early = r.retryAfterSeconds;
      void early;
      const wait = r.allowed ? 0 : r.retryAfterSeconds;
      expect(wait).to.eq(0);
    });

    it('a refusal without retryAfterSeconds does not compile', () => {
      class NoRetryAfter extends MemoryThrottle {
        // @ts-expect-error a refusal carries retryAfterSeconds for Retry-After
        async attempt(): Promise<{ allowed: false }> {
          return { allowed: false };
        }
      }
      expect(NoRetryAfter).to.be.a('function');
    });

    it('attempt needs the context and succeed needs the flow', () => {
      const t: AuthnThrottle = new MemoryThrottle();
      // @ts-expect-error ctx is required
      const a = () => t.attempt(keysFor('alice'), 'login');
      // @ts-expect-error flow is required
      const b = () => t.succeed(keysFor('alice'));
      // @ts-expect-error keys are ThrottleKey objects
      const c = () => t.succeed(['alice'], 'login');
      expect([a, b, c]).to.have.length(3);
    });
  });
});
