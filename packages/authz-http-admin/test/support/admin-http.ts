import { randomUUID } from 'node:crypto';

import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import type { AssignmentSubject, AuthzAdminQuery, AuthzCommandResult, Principal, ResourceRef } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { PrincipalSource } from '@spinajs/authz-http';
import { testHost } from '@spinajs/authz-testing';
import type { AdminHttpHandle, BehaviourHarness, Facet, HarnessSession, RbacLinksHandle } from '@spinajs/authz-testing';

// Tests reach authz-rbac only through its src, which L9's harness loads; its lib as well would
// register the write handlers twice.
import { adminHarness, harnessStores } from '../../../authz-rbac/test/admin/admin-harness.js';
import { UNRESOLVED_LINK_ID, linkPrincipalOf } from '../../../authz-rbac/src/index.js';
import { AuthzAdminController } from '../../src/controllers/AuthzAdminController.js';
import { startApp, stopApp } from './app.js';
import type { TestApp } from './app.js';

export const DOMAIN = 'test';
const PRINCIPAL_HEADER = 'x-admin-principal';
const principals = new Map<string, Principal>();

/** Yields the principal a test request names: the header carries a key into `principals`. */
class HeaderPrincipalSource extends PrincipalSource {
  public readonly name = 'admin-test';
  public readonly order = 45;

  public async authenticate(req: Request): Promise<Principal | null> {
    const key = req.headers[PRINCIPAL_HEADER];
    return typeof key === 'string' ? principals.get(key) ?? null : null;
  }
}

export interface RawRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly as?: Principal;
  readonly body?: unknown;
}

export interface RawResponse {
  readonly status: number;
  readonly body: any;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

let app: TestApp | undefined;

/** One request to the running app as `as` (no principal header without it). */
export async function send(req: RawRequest): Promise<RawResponse> {
  if (!app) throw new Error('send: the admin http app is not running');
  let r = app.request()[req.method.toLowerCase() as 'get'](req.path);
  if (req.as) {
    const key = randomUUID();
    principals.set(key, req.as);
    r = r.set(PRINCIPAL_HEADER, key);
  }
  const res = req.body !== undefined ? await r.send(req.body as object) : await r;
  return { status: res.status, body: res.body, headers: res.headers as Record<string, string | undefined> };
}

const refText = (r: ResourceRef): string => (r.id === undefined ? r.type : `${r.type}:${r.id}`);
const subjectText = (s: AssignmentSubject): string => ('set' in s ? `set:${s.set.role}@${refText(s.set.scope)}` : `${s.type}:${s.id}`);

function listPath(q: AuthzAdminQuery): string {
  if (q.kind === 'attributes') return `/authz/scopes/${encodeURIComponent(q.scope.type)}/${encodeURIComponent(q.scope.id ?? '')}/attributes`;
  const params = new URLSearchParams();
  if (q.scope) params.set('scope', refText(q.scope));
  if (q.kind === 'assignments') {
    if (q.subject) params.set('subject', subjectText(q.subject));
    if (q.role !== undefined) params.set('role', q.role);
    if (q.includeExpired !== undefined) params.set('includeExpired', String(q.includeExpired));
  }
  if (q.page) {
    params.set('limit', String(q.page.limit));
    params.set('offset', String(q.page.offset));
  }
  const qs = params.toString();
  return `/authz/${q.kind}${qs ? `?${qs}` : ''}`;
}

/** The C4 lane handle: POST /authz/commands and the GET list routes. */
export const adminHttp: AdminHttpHandle = {
  async execute(actor, body) {
    const res = await send({ method: 'POST', path: '/authz/commands', body, ...(actor ? { as: actor } : {}) });
    const results = (res.body as { results?: readonly AuthzCommandResult[] } | undefined)?.results;
    return { status: res.status, ...(results ? { results } : {}) };
  },
  async list(actor, q) {
    const res = await send({ method: 'GET', path: listPath(q), ...(actor ? { as: actor } : {}) });
    const items = (res.body as { items?: readonly unknown[] } | undefined)?.items;
    return { status: res.status, ...(items ? { items } : {}) };
  },
};

/**
 * The links facet: the token opens the case's MemoryLinkStore row through L1b's linkPrincipalOf, as
 * RbacService.principalForToken does (the harness model is not an RbacModel, so no RbacService).
 */
async function rbacLinks(): Promise<RbacLinksHandle> {
  const { links } = harnessStores({ container: (await testHost.domains()).container(DOMAIN) });
  return {
    async principal(token, companion) {
      return linkPrincipalOf(await links.byToken(token), UNRESOLVED_LINK_ID, companion);
    },
  };
}

/**
 * L9's adminHarness (memory RBAC admin stores, TestRbacModel, DefaultAdminGuard, recording event
 * sink; domain `test`) behind an http server running AuthzAdminController, with
 * `authz.http.admin.domain` set to the harness domain. Lane handles `adminHttp` and `rbacLinks`.
 */
export function adminHttpHarness(opts: { readonly facets?: readonly Facet[] } = {}): BehaviourHarness {
  const base = adminHarness({ facets: ['http', 'links', ...(opts.facets ?? [])] });
  return {
    ...base,
    async beforeAll() {
      DI.register(HeaderPrincipalSource).as(PrincipalSource);
      app = await startApp({ controllers: [AuthzAdminController], config: { 'authz.http.admin.domain': DOMAIN } });
      await base.beforeAll?.();
    },
    async afterAll() {
      try {
        await base.afterAll?.();
        await stopApp();
      } finally {
        app = undefined;
        DI.unregister(HeaderPrincipalSource as Class<unknown>);
        DI.uncache(HeaderPrincipalSource as Class<unknown>);
        DI.uncache(PrincipalSource);
        principals.clear();
      }
    },
    async setup(world, ctx) {
      const session = await base.setup(world, ctx);
      return { ...session, lane: { ...session.lane, adminHttp, rbacLinks: await rbacLinks() } } as HarnessSession;
    },
  };
}
