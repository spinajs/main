import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { IdentityStore, PasswordCredentialStore } from '../../src/contracts/identity.js';
import type { IdentityStatus } from '../../src/contracts/identity.js';
import { IdentityLinkStore } from '../../src/contracts/link.js';
import type { IdentityLink } from '../../src/contracts/link.js';
import type { ExternalSubject, IdentityRef } from '../../src/contracts/credentials.js';
import * as index from '../../src/contracts/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

const user: IdentityRef = { type: 'user', id: 'u1' };
const google: ExternalSubject = { provider: 'oidc:google', subject: 'g-1', email: 'a@b.c', emailVerified: true };
const ok: IdentityStatus = { exists: true, active: true, banned: false, deleted: false };

class LinkOnlyStore extends IdentityStore {
  async findByLogin(login: string): Promise<IdentityRef | null> {
    return login === 'a@b.c' ? user : null;
  }
  async status(_id: IdentityRef): Promise<IdentityStatus> {
    return ok;
  }
  async display(_id: IdentityRef): Promise<{ email?: string; name?: string }> {
    return { email: 'a@b.c' };
  }
}

class JitStore extends LinkOnlyStore {
  async provision(external: ExternalSubject): Promise<IdentityRef> {
    return { type: 'user', id: `jit-${external.subject}` };
  }
}

class MemoryPasswords extends PasswordCredentialStore {
  private readonly hashes = new Map<string, string>();
  async get(id: IdentityRef): Promise<string | null> {
    return this.hashes.get(id.id) ?? null;
  }
  async set(id: IdentityRef, hash: string, expected?: string | null): Promise<boolean> {
    if (expected !== undefined && (this.hashes.get(id.id) ?? null) !== expected) return false;
    this.hashes.set(id.id, hash);
    return true;
  }
}

class MemoryLinks extends IdentityLinkStore {
  private links: IdentityLink[] = [];
  async find(provider: string, subject: string): Promise<IdentityLink | null> {
    return this.links.find((l) => l.provider === provider && l.subject === subject) ?? null;
  }
  async list(identity: IdentityRef): Promise<readonly IdentityLink[]> {
    return this.links.filter((l) => l.identity.id === identity.id);
  }
  async link(identity: IdentityRef, external: ExternalSubject): Promise<IdentityLink> {
    const l: IdentityLink = { id: `l${this.links.length + 1}`, identity, provider: external.provider, subject: external.subject, email: external.email, linkedAt: new Date(0) };
    this.links.push(l);
    return l;
  }
  async unlink(id: string): Promise<void> {
    this.links = this.links.filter((l) => l.id !== id);
  }
}

interface MemberShape {
  name: string;
  modifiers: string[];
  optional: boolean;
  params: string[] | null;
  doc: string;
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
        optional: ts.isMethodDeclaration(m) && !!m.questionToken,
        params: ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
        doc: ts
          .getJSDocCommentsAndTags(m)
          .map((d) => d.getText(sf))
          .join(' '),
      })),
    };
  });
  return out;
}

const shape = (members: MemberShape[]) => members.map(({ doc: _doc, ...rest }) => rest);
const docOf = (members: MemberShape[], name: string) => members.find((m) => m.name === name)?.doc ?? '';

describe('identity store and account link contracts', () => {
  describe('runtime', () => {
    it('exports the three abstract classes from the contracts index', () => {
      expect(index.IdentityStore).to.eq(IdentityStore);
      expect(index.PasswordCredentialStore).to.eq(PasswordCredentialStore);
      expect(index.IdentityLinkStore).to.eq(IdentityLinkStore);
      for (const c of [IdentityStore, PasswordCredentialStore, IdentityLinkStore]) {
        expect(c).to.be.a('function');
        expect(Object.getPrototypeOf(c)).to.eq(Function.prototype);
      }
    });

    it('concrete subclasses work', async () => {
      expect(await new LinkOnlyStore().findByLogin('a@b.c')).to.deep.eq(user);
      expect(await new LinkOnlyStore().findByLogin('nobody')).to.eq(null);
      expect(new LinkOnlyStore().provision).to.eq(undefined);
      expect(await new JitStore().provision(google)).to.deep.eq({ type: 'user', id: 'jit-g-1' });

      const pw = new MemoryPasswords();
      expect(await pw.get(user)).to.eq(null);
      await pw.set(user, '$argon2id$v=19$m=65536,t=3,p=4$x');
      expect(await pw.get(user)).to.eq('$argon2id$v=19$m=65536,t=3,p=4$x');

      const links = new MemoryLinks();
      const l = await links.link(user, google);
      expect(await links.find('oidc:google', 'g-1')).to.eq(l);
      expect(await links.list(user)).to.have.length(1);
      await links.unlink(l.id);
      expect(await links.find('oidc:google', 'g-1')).to.eq(null);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('IdentityStore and PasswordCredentialStore', () => {
      const c = classMembers('identity.ts');
      expect(Object.keys(c)).to.deep.eq(['IdentityStore', 'PasswordCredentialStore']);
      expect(c.IdentityStore.base).to.eq(null);
      expect(shape(c.IdentityStore.members)).to.deep.eq([
        { name: 'findByLogin', modifiers: ['abstract'], optional: false, params: ['login'] },
        { name: 'status', modifiers: ['abstract'], optional: false, params: ['id'] },
        { name: 'display', modifiers: ['abstract'], optional: false, params: ['id'] },
        { name: 'provision', modifiers: [], optional: true, params: ['external'] },
      ]);
      expect(c.PasswordCredentialStore.base).to.eq(null);
      expect(shape(c.PasswordCredentialStore.members)).to.deep.eq([
        { name: 'get', modifiers: ['abstract'], optional: false, params: ['id'] },
        { name: 'set', modifiers: ['abstract'], optional: false, params: ['id', 'hash', 'expected'] },
      ]);
    });

    it('IdentityLinkStore', () => {
      const c = classMembers('link.ts');
      expect(Object.keys(c)).to.deep.eq(['IdentityLinkStore']);
      expect(c.IdentityLinkStore.base).to.eq(null);
      expect(shape(c.IdentityLinkStore.members)).to.deep.eq([
        { name: 'find', modifiers: ['abstract'], optional: false, params: ['provider', 'subject'] },
        { name: 'list', modifiers: ['abstract'], optional: false, params: ['identity'] },
        { name: 'link', modifiers: ['abstract'], optional: false, params: ['identity', 'external'] },
        { name: 'unlink', modifiers: ['abstract'], optional: false, params: ['id'] },
      ]);
    });

    it('docs carry the rules a reader needs', () => {
      const identity = classMembers('identity.ts');
      const provision = docOf(identity.IdentityStore.members, 'provision');
      expect(provision).to.contain('authn.linking.jit');
      expect(provision).to.contain('off by default');
      const set = docOf(identity.PasswordCredentialStore.members, 'set');
      expect(set).to.contain('never a raw password');
      expect(set).to.contain('A03');
      expect(set).to.contain('compare-and-set');
      expect(set).to.contain('null: no password stored');
      expect(docOf(identity.PasswordCredentialStore.members, 'get')).to.contain('hash');
      expect(docOf(classMembers('link.ts').IdentityLinkStore.members, 'find')).to.contain('A19');
    });
  });

  describe('types', () => {
    it('re-exports the interfaces from the contracts index', () => {
      same<index.IdentityStatus, IdentityStatus>(true);
      same<index.IdentityLink, IdentityLink>(true);
    });

    it('IdentityStatus is exactly the design shape', () => {
      same<IdentityStatus, { readonly exists: boolean; readonly active: boolean; readonly banned: boolean; readonly deleted: boolean; readonly invitePending?: boolean }>(true);
      const invited: IdentityStatus = { ...ok, active: false, invitePending: true };
      expect(invited.invitePending).to.eq(true);
      // @ts-expect-error banned is required
      const noBanned: IdentityStatus = { exists: true, active: true, deleted: false };
      void noBanned;
    });

    it('IdentityLink is exactly the design shape', () => {
      same<IdentityLink, { readonly id: string; readonly identity: IdentityRef; readonly provider: string; readonly subject: string; readonly email?: string; readonly linkedAt: Date; readonly lastUsedAt?: Date }>(true);
      // @ts-expect-error linkedAt is a Date
      const badDate: IdentityLink = { id: 'l1', identity: user, provider: 'p', subject: 's', linkedAt: '2026-01-01' };
      void badDate;
    });

    it('IdentityStore members have the design types', () => {
      same<Parameters<IdentityStore['findByLogin']>, [string]>(true);
      same<ReturnType<IdentityStore['findByLogin']>, Promise<IdentityRef | null>>(true);
      same<Parameters<IdentityStore['status']>, [IdentityRef]>(true);
      same<ReturnType<IdentityStore['status']>, Promise<IdentityStatus>>(true);
      same<Parameters<IdentityStore['display']>, [IdentityRef]>(true);
      same<ReturnType<IdentityStore['display']>, Promise<{ email?: string; name?: string }>>(true);
      same<IdentityStore['provision'], ((external: ExternalSubject) => Promise<IdentityRef>) | undefined>(true);
    });

    it('PasswordCredentialStore members have the design types', () => {
      same<Parameters<PasswordCredentialStore['get']>, [IdentityRef]>(true);
      same<ReturnType<PasswordCredentialStore['get']>, Promise<string | null>>(true);
      same<Parameters<PasswordCredentialStore['set']>, [IdentityRef, string, (string | null)?]>(true);
      same<ReturnType<PasswordCredentialStore['set']>, Promise<boolean>>(true);
    });

    it('IdentityLinkStore members have the design types', () => {
      same<Parameters<IdentityLinkStore['find']>, [string, string]>(true);
      same<ReturnType<IdentityLinkStore['find']>, Promise<IdentityLink | null>>(true);
      same<Parameters<IdentityLinkStore['list']>, [IdentityRef]>(true);
      same<ReturnType<IdentityLinkStore['list']>, Promise<readonly IdentityLink[]>>(true);
      same<Parameters<IdentityLinkStore['link']>, [IdentityRef, ExternalSubject]>(true);
      same<ReturnType<IdentityLinkStore['link']>, Promise<IdentityLink>>(true);
      same<Parameters<IdentityLinkStore['unlink']>, [string]>(true);
      same<ReturnType<IdentityLinkStore['unlink']>, Promise<void>>(true);
    });

    it('provision is optional: callers must check it', async () => {
      const s: IdentityStore = new JitStore();
      // @ts-expect-error provision may be undefined
      void s.provision(google);
      expect(await s.provision?.(google)).to.deep.eq({ type: 'user', id: 'jit-g-1' });
    });

    it('the abstract classes cannot be instantiated', () => {
      // @ts-expect-error abstract
      const a = () => new IdentityStore();
      // @ts-expect-error abstract
      const b = () => new PasswordCredentialStore();
      // @ts-expect-error abstract
      const c = () => new IdentityLinkStore();
      expect([a, b, c]).to.have.length(3);
    });

    it('a subclass missing any required member does not compile', () => {
      // @ts-expect-error findByLogin is missing
      class NoFind extends IdentityStore {
        async status(): Promise<IdentityStatus> {
          return ok;
        }
        async display(): Promise<{ email?: string; name?: string }> {
          return {};
        }
      }
      // @ts-expect-error status is missing
      class NoStatus extends IdentityStore {
        async findByLogin(): Promise<IdentityRef | null> {
          return null;
        }
        async display(): Promise<{ email?: string; name?: string }> {
          return {};
        }
      }
      // @ts-expect-error display is missing
      class NoDisplay extends IdentityStore {
        async findByLogin(): Promise<IdentityRef | null> {
          return null;
        }
        async status(): Promise<IdentityStatus> {
          return ok;
        }
      }
      // @ts-expect-error set is missing
      class NoSet extends PasswordCredentialStore {
        async get(): Promise<string | null> {
          return null;
        }
      }
      // @ts-expect-error get is missing
      class NoGet extends PasswordCredentialStore {
        async set(): Promise<boolean> {
          return true;
        }
      }
      // @ts-expect-error unlink is missing
      class NoUnlink extends IdentityLinkStore {
        async find(): Promise<IdentityLink | null> {
          return null;
        }
        async list(): Promise<readonly IdentityLink[]> {
          return [];
        }
        async link(): Promise<IdentityLink> {
          throw new Error();
        }
      }
      expect([NoFind, NoStatus, NoDisplay, NoSet, NoGet, NoUnlink]).to.have.length(6);
    });

    it('a store without JIT omits provision', () => {
      class Omitted extends IdentityStore {
        async findByLogin(): Promise<IdentityRef | null> {
          return null;
        }
        async status(): Promise<IdentityStatus> {
          return ok;
        }
        async display(): Promise<{ email?: string; name?: string }> {
          return {};
        }
      }
      expect(new Omitted().provision).to.eq(undefined);
      expect('provision' in LinkOnlyStore.prototype).to.eq(false);
      expect(typeof JitStore.prototype.provision).to.eq('function');
    });

    it('a JIT store must provision with the design signature', () => {
      class BadJit extends LinkOnlyStore {
        // @ts-expect-error provision resolves to an IdentityRef
        async provision(_external: ExternalSubject): Promise<string> {
          return 'u1';
        }
      }
      expect(BadJit).to.be.a('function');
    });
  });
});
