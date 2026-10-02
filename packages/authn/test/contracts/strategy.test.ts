import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { AsyncService } from '@spinajs/di';

import { AuthenticationStrategy } from '../../src/contracts/strategy.js';
import { AuthnService, PrincipalFactory } from '../../src/contracts/service.js';
import type { ThrottleKey } from '../../src/contracts/throttle.js';
import type { AuthenticationResult, AuthnContext, Credentials, IdentityRef, StrategyOutcome } from '../../src/contracts/credentials.js';
import type { SessionHandle } from '../../src/contracts/session.js';
import type { AuthnFacts, Ceiling, Principal } from '../../src/contracts/principal.js';
import * as index from '../../src/contracts/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

type Success = Extract<AuthenticationResult, { status: 'success' }>;
type Extra = { ceiling?: Ceiling; onBehalfOf?: Principal; delegation?: 'inherit' | 'intersect' };

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

const user: IdentityRef = { type: 'user', id: 'u1' };
const ctx: AuthnContext = { now: new Date(0), purpose: 'login', ip: '10.0.0.1' };
const active: SessionHandle = { id: 'raw', state: 'active' };
const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };

class LocalStrategy extends AuthenticationStrategy {
  readonly name = 'local';
  readonly kinds: readonly string[] = ['password'];
  readonly interactive = true;
  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    const keys: ThrottleKey[] = [{ kind: 'ip', value: ctx.ip ?? '' }];
    if (c.kind === 'password') keys.push({ kind: 'account', value: String(c.login) });
    return keys;
  }
  async verify(c: Credentials, _ctx: AuthnContext): Promise<StrategyOutcome> {
    return c.kind === 'password' ? { ok: true, identity: user, method: 'password' } : { ok: false, reason: 'unsupported_credentials' };
  }
}

class TestAuthnService extends AuthnService {
  async authenticate(_c: Credentials, _ctx: AuthnContext): Promise<AuthenticationResult> {
    return { status: 'failure', reason: 'invalid_credentials' };
  }
  async completeMfa(_pending: SessionHandle, _step: string, _response: string, _ctx: AuthnContext): Promise<AuthenticationResult> {
    return { status: 'failure', reason: 'invalid_credentials' };
  }
  async reauthenticate(_session: SessionHandle, _c: Credentials, _ctx: AuthnContext): Promise<boolean> {
    return false;
  }
  async principalOf(result: Success): Promise<Principal> {
    return { type: result.identity.type, id: result.identity.id, authenticated: true, source: 'session', attributes: {} };
  }
  strategies(): readonly AuthenticationStrategy[] {
    return [new LocalStrategy()];
  }
}

class TestPrincipalFactory extends PrincipalFactory {
  async principalOf(id: IdentityRef, facts: AuthnFacts, extra: Extra): Promise<Principal> {
    return { type: id.type, id: id.id, authenticated: true, source: 'session', attributes: {}, authn: facts, ...extra };
  }
}

interface MemberShape {
  name: string;
  modifiers: string[];
  params: string[] | null;
}

function classMembers(file: string): Record<string, { base: string | null; members: MemberShape[] }> {
  const sf = ts.createSourceFile(file, readFileSync(join(SRC_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const out: Record<string, { base: string | null; members: MemberShape[] }> = {};
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || !n.name) return;
    const heritage = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    out[n.name.text] = {
      base: heritage ? heritage.types[0].expression.getText(sf) : null,
      members: n.members.map((m) => ({
        name: m.name ? m.name.getText(sf) : '',
        modifiers: (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).map((x) => x.getText(sf)),
        params: ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
      })),
    };
  });
  return out;
}

describe('strategy, service and principal factory contracts', () => {
  describe('runtime', () => {
    it('exports the three abstract classes from the contracts index', () => {
      expect(index.AuthenticationStrategy).to.eq(AuthenticationStrategy);
      expect(index.AuthnService).to.eq(AuthnService);
      expect(index.PrincipalFactory).to.eq(PrincipalFactory);
      for (const c of [AuthenticationStrategy, AuthnService, PrincipalFactory]) expect(c).to.be.a('function');
    });

    it('extends AsyncService for the strategy and the service only', () => {
      expect(Object.getPrototypeOf(AuthenticationStrategy)).to.eq(AsyncService);
      expect(Object.getPrototypeOf(AuthnService)).to.eq(AsyncService);
      expect(Object.getPrototypeOf(PrincipalFactory)).to.eq(Function.prototype);
    });

    it('a concrete subclass works', async () => {
      const s = new LocalStrategy();
      expect(s).to.be.instanceOf(AsyncService);
      expect(s.throttleKeys({ kind: 'password', login: 'a@b.c', password: 'x' }, ctx)).to.deep.eq([
        { kind: 'ip', value: '10.0.0.1' },
        { kind: 'account', value: 'a@b.c' },
      ]);
      expect(await s.verify({ kind: 'bearer', token: 't' }, ctx)).to.deep.eq({ ok: false, reason: 'unsupported_credentials' });

      const svc = new TestAuthnService();
      expect(svc).to.be.instanceOf(AsyncService);
      expect(svc.strategies()[0]).to.be.instanceOf(AuthenticationStrategy);
      expect(await svc.reauthenticate(active, { kind: 'password', login: 'a', password: 'b' }, { ...ctx, purpose: 'reauth' })).to.eq(false);

      const p = await new TestPrincipalFactory().principalOf(user, facts, { delegation: 'intersect' });
      expect(p).to.include({ type: 'user', id: 'u1', delegation: 'intersect' });
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('AuthenticationStrategy', () => {
      expect(classMembers('strategy.ts')).to.deep.eq({
        AuthenticationStrategy: {
          base: 'AsyncService',
          members: [
            { name: 'name', modifiers: ['abstract', 'readonly'], params: null },
            { name: 'kinds', modifiers: ['abstract', 'readonly'], params: null },
            { name: 'interactive', modifiers: ['abstract', 'readonly'], params: null },
            { name: 'throttleKeys', modifiers: ['abstract'], params: ['c', 'ctx'] },
            { name: 'verify', modifiers: ['abstract'], params: ['c', 'ctx'] },
          ],
        },
      });
    });

    it('AuthnService and PrincipalFactory', () => {
      expect(classMembers('service.ts')).to.deep.eq({
        AuthnService: {
          base: 'AsyncService',
          members: [
            { name: 'authenticate', modifiers: ['abstract'], params: ['c', 'ctx'] },
            { name: 'completeMfa', modifiers: ['abstract'], params: ['pending', 'step', 'response', 'ctx'] },
            { name: 'reauthenticate', modifiers: ['abstract'], params: ['session', 'c', 'ctx'] },
            { name: 'principalOf', modifiers: ['abstract'], params: ['result'] },
            { name: 'strategies', modifiers: ['abstract'], params: [] },
          ],
        },
        PrincipalFactory: {
          base: null,
          members: [{ name: 'principalOf', modifiers: ['abstract'], params: ['id', 'facts', 'extra'] }],
        },
      });
    });
  });

  describe('types', () => {
    it('re-exports ThrottleKey from the contracts index', () => {
      same<index.ThrottleKey, ThrottleKey>(true);
    });

    it('ThrottleKey is exactly the design shape, open kind included', () => {
      same<ThrottleKey, { readonly kind: 'ip' | 'account' | 'account-ip' | 'global' | (string & {}); readonly value: string }>(true);
      const keys: ThrottleKey[] = [
        { kind: 'ip', value: '1' },
        { kind: 'account', value: '2' },
        { kind: 'account-ip', value: '3' },
        { kind: 'global', value: '4' },
        { kind: 'tenant', value: '5' },
      ];
      expect(keys).to.have.length(5);
      // @ts-expect-error value is required
      const noValue: ThrottleKey = { kind: 'ip' };
      void noValue;
    });

    it('AuthenticationStrategy members have the design types', () => {
      same<Pick<AuthenticationStrategy, 'name' | 'kinds' | 'interactive'>, { readonly name: string; readonly kinds: readonly string[]; readonly interactive: boolean }>(true);
      same<Parameters<AuthenticationStrategy['throttleKeys']>, [Credentials, AuthnContext]>(true);
      same<ReturnType<AuthenticationStrategy['throttleKeys']>, readonly ThrottleKey[]>(true);
      same<Parameters<AuthenticationStrategy['verify']>, [Credentials, AuthnContext]>(true);
      same<ReturnType<AuthenticationStrategy['verify']>, Promise<StrategyOutcome>>(true);
    });

    it('AuthnService members have the design types', () => {
      same<Parameters<AuthnService['authenticate']>, [Credentials, AuthnContext]>(true);
      same<ReturnType<AuthnService['authenticate']>, Promise<AuthenticationResult>>(true);
      same<Parameters<AuthnService['completeMfa']>, [SessionHandle, string, string, AuthnContext]>(true);
      same<ReturnType<AuthnService['completeMfa']>, Promise<AuthenticationResult>>(true);
      same<Parameters<AuthnService['reauthenticate']>, [SessionHandle, Credentials, AuthnContext]>(true);
      same<ReturnType<AuthnService['reauthenticate']>, Promise<boolean>>(true);
      same<Parameters<AuthnService['principalOf']>, [Success]>(true);
      same<ReturnType<AuthnService['principalOf']>, Promise<Principal>>(true);
      same<Parameters<AuthnService['strategies']>, []>(true);
      same<ReturnType<AuthnService['strategies']>, readonly AuthenticationStrategy[]>(true);
    });

    it('PrincipalFactory.principalOf has the design types, extra included', () => {
      same<Parameters<PrincipalFactory['principalOf']>, [IdentityRef, AuthnFacts, Extra]>(true);
      same<ReturnType<PrincipalFactory['principalOf']>, Promise<Principal>>(true);
      const f: PrincipalFactory = new TestPrincipalFactory();
      // @ts-expect-error delegation is a closed union
      void f.principalOf(user, facts, { delegation: 'replace' });
      // @ts-expect-error extra is required
      void f.principalOf(user, facts);
    });

    it('the abstract classes cannot be instantiated', () => {
      // @ts-expect-error abstract
      const a = () => new AuthenticationStrategy();
      // @ts-expect-error abstract
      const b = () => new AuthnService();
      // @ts-expect-error abstract
      const c = () => new PrincipalFactory();
      expect([a, b, c]).to.have.length(3);
    });

    it('a subclass missing any member does not compile', () => {
      // @ts-expect-error name is missing
      class NoName extends AuthenticationStrategy {
        readonly kinds: readonly string[] = [];
        readonly interactive = false;
        throttleKeys(): readonly ThrottleKey[] {
          return [];
        }
        async verify(): Promise<StrategyOutcome> {
          return { ok: false, reason: 'invalid_credentials' };
        }
      }
      // @ts-expect-error kinds is missing
      class NoKinds extends AuthenticationStrategy {
        readonly name = 'x';
        readonly interactive = false;
        throttleKeys(): readonly ThrottleKey[] {
          return [];
        }
        async verify(): Promise<StrategyOutcome> {
          return { ok: false, reason: 'invalid_credentials' };
        }
      }
      // @ts-expect-error interactive is missing
      class NoInteractive extends AuthenticationStrategy {
        readonly name = 'x';
        readonly kinds: readonly string[] = [];
        throttleKeys(): readonly ThrottleKey[] {
          return [];
        }
        async verify(): Promise<StrategyOutcome> {
          return { ok: false, reason: 'invalid_credentials' };
        }
      }
      // @ts-expect-error throttleKeys is missing
      class NoThrottleKeys extends AuthenticationStrategy {
        readonly name = 'x';
        readonly kinds: readonly string[] = [];
        readonly interactive = false;
        async verify(): Promise<StrategyOutcome> {
          return { ok: false, reason: 'invalid_credentials' };
        }
      }
      // @ts-expect-error verify is missing
      class NoVerify extends AuthenticationStrategy {
        readonly name = 'x';
        readonly kinds: readonly string[] = [];
        readonly interactive = false;
        throttleKeys(): readonly ThrottleKey[] {
          return [];
        }
      }
      // @ts-expect-error strategies is missing
      class NoStrategies extends AuthnService {
        async authenticate(): Promise<AuthenticationResult> {
          return { status: 'failure', reason: 'invalid_credentials' };
        }
        async completeMfa(): Promise<AuthenticationResult> {
          return { status: 'failure', reason: 'invalid_credentials' };
        }
        async reauthenticate(): Promise<boolean> {
          return false;
        }
        async principalOf(): Promise<Principal> {
          throw new Error();
        }
      }
      // @ts-expect-error principalOf is missing
      class NoPrincipalOf extends PrincipalFactory {}
      expect([NoName, NoKinds, NoInteractive, NoThrottleKeys, NoVerify, NoStrategies, NoPrincipalOf]).to.have.length(7);
    });

    it('a strategy cannot return a wrong outcome', () => {
      class BadOutcome extends AuthenticationStrategy {
        readonly name = 'x';
        readonly kinds: readonly string[] = [];
        readonly interactive = false;
        throttleKeys(): readonly ThrottleKey[] {
          return [];
        }
        // @ts-expect-error verify resolves to a StrategyOutcome
        async verify(): Promise<AuthenticationResult> {
          return { status: 'failure', reason: 'invalid_credentials' };
        }
      }
      expect(BadOutcome).to.be.a('function');
    });
  });
});
