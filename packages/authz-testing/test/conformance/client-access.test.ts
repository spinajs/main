import 'mocha';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'chai';

import { CLIENT_ACCESS_FIXTURE, clientAccessConformanceChecks, runClientAccessConformance } from '../../src/index.js';
import type { ClientAccessApp } from '../../src/index.js';

interface Grant { readonly user: string; readonly role: string; readonly scope: { readonly type: string; readonly id?: string } }

/** An in-process app that answers as design 2026-10-14 §10.2-§10.4 says; `broken` honours the body's subject. */
async function fakeApp(broken = false): Promise<ClientAccessApp> {
  const grants: Grant[] = CLIENT_ACCESS_FIXTURE.assignments.map((a) => ({ user: a.subject.id, role: a.role, scope: a.scope }));
  const streams = new Map<string, ServerResponse[]>();
  const can = (user: string | undefined, permission: string, id: string): boolean => {
    if (!user) return false;
    return grants.some((g) => (g.user === user || g.user === '*') && CLIENT_ACCESS_FIXTURE.roles[g.role].grants.includes(permission) && (g.scope.type === '$global' || (g.scope.type === 'doc' && g.scope.id === id)));
  };
  const userOf = (req: IncomingMessage): string | undefined => (typeof req.headers['x-user'] === 'string' ? req.headers['x-user'] : undefined);
  const epoch = (user: string | undefined) => createHash('sha256').update(user ?? 'anonymous').digest('hex').slice(0, 16);
  const body = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw ? JSON.parse(raw) : undefined));
    });
  const json = (res: ServerResponse, status: number, value: unknown, user: string | undefined) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-access-epoch': epoch(user) });
    res.end(JSON.stringify(value));
  };
  const server: Server = createServer(async (req, res) => {
    const user = userOf(req);
    if (req.method === 'POST' && req.url === '/user/access/checks') {
      const { checks } = (await body(req)) as { checks: unknown[] };
      if (!Array.isArray(checks) || checks.length > 100) return json(res, 400, { error: 'bad request' }, user);
      const results: boolean[] = [];
      const reasons: (string | null)[] = [];
      for (const c of checks as { object?: { type?: string; id?: string }; permission?: string; subject?: { type: string; id: string } }[]) {
        if (!c || typeof c.object?.type !== 'string' || typeof c.object.id !== 'string' || typeof c.permission !== 'string') {
          results.push(false);
          reasons.push('invalid_request');
          continue;
        }
        const asUser = broken && c.subject ? c.subject.id : user;
        if (!broken && c.subject && (c.subject.type !== 'user' || c.subject.id !== user)) {
          results.push(false);
          reasons.push('subject_mismatch');
          continue;
        }
        const permission = c.permission.includes(':') ? c.permission : `${c.object.type}:${c.permission}`;
        const ok = can(asUser, permission, c.object.id);
        results.push(ok);
        reasons.push(ok ? null : 'no_access');
      }
      return json(res, 200, { results, reasons }, user);
    }
    if (req.method === 'GET' && req.url === CLIENT_ACCESS_FIXTURE.listPath) {
      const rows = CLIENT_ACCESS_FIXTURE.ids.filter((id) => can(user, 'doc:view', id)).map((id) => ({ id, $access: { 'doc:edit': can(user, 'doc:edit', id), 'doc:view': can(user, 'doc:view', id) } }));
      return json(res, 200, rows, user);
    }
    if (req.method === 'GET' && req.url === '/user/access/events' && user) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-access-epoch': epoch(user) });
      res.write(': open\n\n');
      streams.set(user, [...(streams.get(user) ?? []), res]);
      return;
    }
    json(res, 404, {}, user);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    headers: (id): Record<string, string> => (id ? { 'x-user': id } : {}),
    async assign(id, role, scope) {
      grants.push({ user: id, role, scope });
      for (const s of streams.get(id) ?? []) s.write(`event: authz.changed\ndata: ${JSON.stringify({ objects: [scope] })}\n\n`);
    },
    async stop() {
      for (const list of streams.values()) for (const s of list) s.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

runClientAccessConformance('client access conformance over a fake app', () => fakeApp());

describe('client access conformance catches a broken app', () => {
  it('fails the subject check when the app honours the body subject', async () => {
    const app = await fakeApp(true);
    try {
      const subject = clientAccessConformanceChecks(() => app).find((c) => c.id === 'subject')!;
      let failed: Error | undefined;
      await subject.run().catch((e: Error) => (failed = e));
      expect(failed?.message).to.match(/subject/);
    } finally {
      await app.stop();
    }
  });
});
