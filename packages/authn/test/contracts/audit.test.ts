import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { AuthnEventSink } from '../../src/contracts/audit.js';
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

const EVENT_TYPES = ['login', 'logout', 'mfa.challenge', 'mfa.verify', 'mfa.enrol', 'mfa.disable', 'reauth', 'session.issue', 'session.rotate', 'session.revoke', 'session.expire', 'password.change', 'password.reset.request', 'password.reset', 'invite.redeem', 'token.create', 'token.use', 'token.revoke', 'key.register', 'key.use', 'key.revoke', 'identity.link', 'identity.unlink', 'impersonation.start', 'impersonation.end', 'impersonation.expire', 'throttle.block'] as const;

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

const alice: IdentityRef = { type: 'user', id: 'alice' };
const admin: Principal = { type: 'user', id: 'admin', authenticated: true, source: 'session', attributes: {} };

class ListSink extends AuthnEventSink {
  readonly events: AuthnEvent[] = [];
  async publish(e: AuthnEvent): Promise<void> {
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
    it('exports AuthnEventSink and ImpersonationGuard from the contracts index as plain abstract classes', () => {
      expect(index.AuthnEventSink).to.eq(AuthnEventSink);
      expect(index.ImpersonationGuard).to.eq(ImpersonationGuard);
      for (const c of [AuthnEventSink, ImpersonationGuard]) {
        expect(c).to.be.a('function');
        expect(Object.getPrototypeOf(c)).to.eq(Function.prototype);
      }
    });

    it('every sink gets every event', async () => {
      const sinks: AuthnEventSink[] = [new ListSink(), new ListSink()];
      const events: AuthnEvent[] = [
        { type: 'login', at: new Date(0), outcome: 'success', identity: alice, strategy: 'local', session: 'h(s1)' },
        { type: 'throttle.block', at: new Date(1), outcome: 'failure', reason: 'throttled', ip: '10.0.0.1', data: { flow: 'login' } },
      ];
      for (const e of events) await Promise.all(sinks.map((s) => s.publish(e)));
      for (const s of sinks) expect((s as ListSink).events).to.deep.eq(events);
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
    it('audit.ts holds AuthnEventSink with publish', () => {
      expect(shape(classMembers('audit.ts'))).to.deep.eq({
        AuthnEventSink: { base: null, members: [{ name: 'publish', modifiers: ['abstract'], optional: false, params: ['e'] }] },
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
      const sink = classMembers('audit.ts').AuthnEventSink;
      expect(sink.doc).to.contain('Array.ofType');
      expect(sink.doc).to.contain('every sink gets every event');
      expect(sink.doc).to.contain('A21');
      expect(sink.doc).to.contain('Log sinks write identifiers (login strings, emails) as keyed hashes');
      expect(sink.doc).to.contain('SR-19');
      expect(sink.doc).to.contain('the audit stream keeps the identity id');
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

    it('AuthnEventSink and ImpersonationGuard members have the design types', () => {
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
      const a = () => new AuthnEventSink();
      // @ts-expect-error abstract
      const b = () => new ImpersonationGuard();
      const g: ImpersonationGuard = new RoleGuard();
      // @ts-expect-error the actor is a Principal, not an IdentityRef
      const c = () => g.allowed(alice, alice);
      expect([a, b, c]).to.have.length(3);
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
