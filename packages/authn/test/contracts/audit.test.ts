import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { AuthnEventListener, AuthnEventSink } from '../../src/contracts/audit.js';
import type { AuthnEvent, AuthnEventType } from '../../src/contracts/audit.js';
import { ImpersonationGuard } from '../../src/contracts/impersonation.js';
import type { IdentityRef } from '../../src/contracts/credentials.js';
import type { Principal, PrincipalRef } from '../../src/contracts/principal.js';
import * as index from '../../src/contracts/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

type Verdict = { ok: true } | { ok: false; code: 'forbidden' | 'protected_role' | 'escalation' };

const EVENT_TYPES = ['login', 'logout', 'mfa.challenge', 'mfa.verify', 'mfa.enrol', 'mfa.disable', 'reauth', 'session.issue', 'session.rotate', 'session.revoke', 'session.expire', 'password.change', 'password.reset.request', 'password.reset', 'invite.redeem', 'token.create', 'token.use', 'token.revoke', 'token.rotate', 'token.update', 'key.register', 'key.use', 'key.revoke', 'identity.link', 'identity.unlink', 'impersonation.start', 'impersonation.end', 'impersonation.expire', 'throttle.block', 'passkey.register', 'passkey.remove', 'address.verify.request', 'address.verify', 'code.request', 'identity.register', 'role.switch', 'request.refuse'] as const;

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

const alice: IdentityRef = { type: 'user', id: 'alice' };
const admin: Principal = { type: 'user', id: 'admin', authenticated: true, source: 'session', attributes: {} };

class ListListener extends AuthnEventListener {
  readonly events: AuthnEvent[] = [];
  async on(e: AuthnEvent): Promise<void> {
    this.events.push(e);
  }
}

class RoleGuard extends ImpersonationGuard {
  async allowed(actor: Principal, target: IdentityRef): Promise<Verdict> {
    if (actor.id === target.id) return { ok: false, code: 'forbidden' };
    if (target.id === 'root') return { ok: false, code: 'protected_role' };
    if (target.id === 'owner') return { ok: false, code: 'escalation' };
    return { ok: true };
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

const parse = (file: string) => ts.createSourceFile(file, readFileSync(join(SRC_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);

function classMembers(file: string): Record<string, ClassShape> {
  const sf = parse(file);
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

function interfaceDocs(file: string, name: string): Record<string, string> {
  const sf = parse(file);
  const out: Record<string, string> = {};
  sf.forEachChild((n) => {
    if (!ts.isInterfaceDeclaration(n) || n.name.text !== name) return;
    for (const m of n.members) out[m.name!.getText(sf)] = docText(m, sf);
  });
  return out;
}

function unionLiterals(file: string, name: string): string[] {
  const sf = parse(file);
  let out: string[] = [];
  sf.forEachChild((n) => {
    if (!ts.isTypeAliasDeclaration(n) || n.name.text !== name || !ts.isUnionTypeNode(n.type)) return;
    out = n.type.types.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : `<${t.getText(sf)}>`));
  });
  return out;
}

const shape = (c: Record<string, ClassShape>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { base: v.base, members: v.members.map(({ doc: _doc, ...rest }) => rest) }]));

describe('audit and impersonation guard contracts', () => {
  describe('runtime', () => {
    it('exports AuthnEventListener and ImpersonationGuard from the contracts index as plain abstract classes', () => {
      expect(index.AuthnEventListener).to.eq(AuthnEventListener);
      expect(index.ImpersonationGuard).to.eq(ImpersonationGuard);
      for (const c of [AuthnEventListener, ImpersonationGuard]) {
        expect(c).to.be.a('function');
        expect(Object.getPrototypeOf(c)).to.eq(Function.prototype);
      }
    });

    it('exports the deprecated AuthnEventSink as a listener whose on() calls publish()', async () => {
      expect(index.AuthnEventSink).to.eq(AuthnEventSink);
      expect(Object.getPrototypeOf(AuthnEventSink)).to.eq(AuthnEventListener);
      const seen: AuthnEvent[] = [];
      const sink = new (class extends AuthnEventSink {
        async publish(e: AuthnEvent): Promise<void> {
          seen.push(e);
        }
      })();
      const e: AuthnEvent = { type: 'logout', at: new Date(0), outcome: 'success' };
      await sink.on(e);
      expect(seen).to.deep.eq([e]);
    });

    it('every listener gets every event', async () => {
      const listeners: AuthnEventListener[] = [new ListListener(), new ListListener()];
      const events: AuthnEvent[] = [
        { type: 'login', at: new Date(0), outcome: 'success', identity: alice, strategy: 'local', session: 'h(s1)' },
        { type: 'throttle.block', at: new Date(1), outcome: 'failure', reason: 'throttled', ip: '10.0.0.1', data: { flow: 'login' } },
      ];
      for (const e of events) await Promise.all(listeners.map((l) => l.on(e)));
      for (const l of listeners) expect((l as ListListener).events).to.deep.eq(events);
    });

    it('a concrete guard answers with every code', async () => {
      const g = new RoleGuard();
      expect(await g.allowed(admin, alice)).to.deep.eq({ ok: true });
      expect(await g.allowed(admin, { type: 'user', id: 'admin' })).to.deep.eq({ ok: false, code: 'forbidden' });
      expect(await g.allowed(admin, { type: 'user', id: 'root' })).to.deep.eq({ ok: false, code: 'protected_role' });
      expect(await g.allowed(admin, { type: 'user', id: 'owner' })).to.deep.eq({ ok: false, code: 'escalation' });
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('audit.ts holds AuthnEventListener with on, ready and flush, and the AuthnEventSink bridge', () => {
      expect(shape(classMembers('audit.ts'))).to.deep.eq({
        AuthnEventListener: {
          base: null,
          members: [
            { name: 'on', modifiers: ['abstract'], optional: false, params: ['e'] },
            { name: 'ready', modifiers: [], optional: true, params: [] },
            { name: 'flush', modifiers: [], optional: true, params: [] },
          ],
        },
        AuthnEventSink: {
          base: 'AuthnEventListener',
          members: [
            { name: 'publish', modifiers: ['abstract'], optional: false, params: ['e'] },
            { name: 'on', modifiers: ['public'], optional: false, params: ['e'] },
          ],
        },
      });
    });

    it('impersonation.ts holds ImpersonationGuard with allowed', () => {
      expect(shape(classMembers('impersonation.ts'))).to.deep.eq({
        ImpersonationGuard: { base: null, members: [{ name: 'allowed', modifiers: ['abstract'], optional: false, params: ['actor', 'target'] }] },
      });
    });

    it('AuthnEventType lists the design members in the design order', () => {
      expect(unionLiterals('audit.ts', 'AuthnEventType')).to.deep.eq([...EVENT_TYPES]);
    });

    it('docs carry the rules a reader needs', () => {
      const ev = interfaceDocs('audit.ts', 'AuthnEvent');
      expect(Object.keys(ev)).to.deep.eq(['type', 'at', 'outcome', 'identity', 'actor', 'strategy', 'reason', 'ip', 'userAgent', 'session', 'data']);
      expect(ev.session).to.contain('Hashed');
      expect(ev.session).to.contain('never the raw id');
      expect(ev.data).to.contain('Never');
      expect(ev.data).to.contain('secrets');
      expect(ev.reason).to.contain('A02');
      const listener = classMembers('audit.ts').AuthnEventListener;
      expect(listener.doc).to.contain('every registered listener gets every event (A21)');
      expect(listener.doc).to.contain('authn.audit.listenerTimeoutMs');
      expect(listener.doc).to.contain('never fails the publish');
      expect(listener.members.find((m) => m.name === 'ready')?.doc).to.contain('a throw fails the boot');
      expect(listener.members.find((m) => m.name === 'flush')?.doc).to.contain('AuthnAudit.settled()');
      expect(classMembers('audit.ts').AuthnEventSink.doc).to.contain('@deprecated');
      const guard = classMembers('impersonation.ts').ImpersonationGuard;
      expect(guard.doc).to.contain('users');
      expect(guard.doc).to.contain('D26');
      expect(guard.doc).to.contain('forbidden without user:impersonate (B26)');
    });
  });

  describe('types', () => {
    it('re-exports every type from the contracts index', () => {
      same<index.AuthnEvent, AuthnEvent>(true);
      same<index.AuthnEventType, AuthnEventType>(true);
      same<index.AuthnEventListener, AuthnEventListener>(true);
      same<index.AuthnEventSink, AuthnEventSink>(true);
      same<index.ImpersonationGuard, ImpersonationGuard>(true);
    });

    it('AuthnEventType is exactly the design union', () => {
      same<AuthnEventType, (typeof EVENT_TYPES)[number]>(true);
      // @ts-expect-error no such event
      const t: AuthnEventType = 'mfa.reset';
      void t;
    });

    it('AuthnEvent is exactly the design shape', () => {
      same<
        AuthnEvent,
        {
          readonly type: AuthnEventType;
          readonly at: Date;
          readonly outcome: 'success' | 'failure';
          readonly identity?: IdentityRef;
          readonly actor?: PrincipalRef;
          readonly strategy?: string;
          readonly reason?: string;
          readonly ip?: string;
          readonly userAgent?: string;
          readonly session?: string;
          readonly data?: Readonly<Record<string, unknown>>;
        }
      >(true);
      // @ts-expect-error outcome is required
      const a: AuthnEvent = { type: 'login', at: new Date(0) };
      // @ts-expect-error outcome is success or failure
      const b: AuthnEvent = { type: 'login', at: new Date(0), outcome: 'throttled' };
      // @ts-expect-error session is the hashed handle, not a SessionHandle
      const c: AuthnEvent = { type: 'login', at: new Date(0), outcome: 'success', session: { id: 'raw', state: 'active' } };
      expect([a, b, c]).to.have.length(3);
    });

    it('AuthnEventListener, AuthnEventSink and ImpersonationGuard members have the design types', () => {
      same<Parameters<AuthnEventListener['on']>, [AuthnEvent]>(true);
      same<ReturnType<AuthnEventListener['on']>, Promise<void>>(true);
      same<AuthnEventListener['ready'], (() => void | Promise<void>) | undefined>(true);
      same<AuthnEventListener['flush'], (() => Promise<void>) | undefined>(true);
      same<Parameters<AuthnEventSink['publish']>, [AuthnEvent]>(true);
      same<ReturnType<AuthnEventSink['publish']>, Promise<void>>(true);
      same<Parameters<ImpersonationGuard['allowed']>, [Principal, IdentityRef]>(true);
      same<ReturnType<ImpersonationGuard['allowed']>, Promise<Verdict>>(true);
    });

    it('the guard result narrows on ok', async () => {
      const r = await new RoleGuard().allowed(admin, alice);
      // @ts-expect-error code exists only on a refusal
      const early = r.code;
      void early;
      const code: Extract<Verdict, { ok: false }>['code'] | null = r.ok ? null : r.code;
      expect(code).to.eq(null);
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const l = (): unknown => new AuthnEventListener();
      // @ts-expect-error abstract
      const a = () => new AuthnEventSink();
      // @ts-expect-error abstract
      const b = () => new ImpersonationGuard();
      const g: ImpersonationGuard = new RoleGuard();
      // @ts-expect-error the actor is a Principal, not an IdentityRef
      const c = () => g.allowed(alice, alice);
      expect([l, a, b, c]).to.have.length(4);
    });

    it('a guard with an unknown code does not compile', () => {
      class DeniedGuard extends RoleGuard {
        // @ts-expect-error the codes are forbidden, protected_role and escalation
        async allowed(): Promise<{ ok: false; code: 'denied' }> {
          return { ok: false, code: 'denied' };
        }
      }
      expect(DeniedGuard).to.be.a('function');
    });
  });
});
