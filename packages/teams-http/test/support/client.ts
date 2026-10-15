import chai from 'chai';
import { AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';

import { EMAIL_HEADER, USER_HEADER, appPort } from './app.js';

export interface Res {
  readonly status: number;
  readonly body: any;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** One request to the running app; `as` sends `x-user: <as>`, `email` a verified email for it. */
export async function send(method: Method, path: string, opts: { readonly as?: string; readonly email?: string; readonly body?: unknown } = {}): Promise<Res> {
  const origin = `http://127.0.0.1:${appPort()}`;
  const agent = chai.request(origin);
  let call = method === 'GET' ? agent.get(path) : method === 'POST' ? agent.post(path) : method === 'PATCH' ? agent.patch(path) : agent.delete(path);
  call = call.set('Accept', 'application/json');
  // A CSRF guard, when an installed package registers one, refuses an unsafe request from another origin.
  if (method !== 'GET') call = call.set('Origin', origin);
  if (opts.as !== undefined) call = call.set(USER_HEADER, opts.as);
  if (opts.email !== undefined) call = call.set(EMAIL_HEADER, opts.email);
  const res = opts.body === undefined ? await call : await call.send(opts.body as object);
  return { status: res.status, body: res.body, headers: res.headers as Record<string, string | undefined> };
}

export interface Client {
  get(path: string): Promise<Res>;
  post(path: string, body?: unknown): Promise<Res>;
  patch(path: string, body?: unknown): Promise<Res>;
  del(path: string): Promise<Res>;
}

export function as(user: string, email?: string): Client {
  const who = { as: user, ...(email !== undefined ? { email } : {}) };
  return {
    get: (path) => send('GET', path, who),
    post: (path, body = {}) => send('POST', path, { ...who, body }),
    patch: (path, body = {}) => send('PATCH', path, { ...who, body }),
    del: (path) => send('DELETE', path, who),
  };
}

let seq = 0;

/** An id or slug no other case uses: all suites share one database. Lower-case, so it is a valid slug. */
export const uniq = (prefix: string): string => `${prefix}-${++seq}-${Date.now().toString(36)}`;

export const teamRef = (id: string): ResourceRef => ({ type: 'team', id });
export const groupRef = (id: string): ResourceRef => ({ type: 'group', id });
export const subjectPath = (user: string): string => encodeURIComponent(`user:${user}`);

/** Grants `role` at `scope` to `user:<user>` as SYSTEM, past every guard. */
export async function grantAt(user: string, role: string, scope: ResourceRef): Promise<void> {
  const admin = ((await DI.resolve(AuthzService)) as AuthzService).admin();
  const [result] = await admin.execute(SYSTEM, [{ kind: 'assignment.grant', subject: { type: 'user', id: user }, role, scope }], { reason: 'teams-http test seed' });
  if (!result.ok) throw new Error(`seed ${role} for ${user}: ${result.error.code} ${result.error.message}`);
}

/** A fresh user holding `test.platform` (team:create) at $global. */
export async function platformUser(): Promise<string> {
  const id = uniq('platform');
  await grantAt(id, 'test.platform', GLOBAL);
  return id;
}

/** POST /teams as `owner`; the answer's team. */
export async function createTeam(owner: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await as(owner).post('/teams', { slug: uniq('team'), name: 'Team', ...body });
  if (res.status !== 200) throw new Error(`createTeam: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A root team and its owner, a fresh platform user. */
export async function ownedTeam(): Promise<{ readonly owner: string; readonly team: any }> {
  const owner = await platformUser();
  return { owner, team: await createTeam(owner) };
}
