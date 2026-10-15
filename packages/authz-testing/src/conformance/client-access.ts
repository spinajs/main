import { GLOBAL } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';

import { check, fail } from './common.js';
import type { ConformanceCheck } from './common.js';

/** What the app under test holds when the suite starts. */
export const CLIENT_ACCESS_FIXTURE = Object.freeze({
  type: 'doc' as const,
  ids: Object.freeze(['1', '2', '3', '4']),
  permissions: Object.freeze({ 'doc:edit': { list: true as const }, 'doc:view': { list: true as const } }),
  roles: Object.freeze({ 'doc.editor': { grants: ['doc:edit', 'doc:view'] }, 'doc.viewer': { grants: ['doc:view'] } }) as Readonly<Record<string, { readonly grants: readonly string[] }>>,
  assignments: Object.freeze([
    { subject: { type: 'user', id: 'me' }, role: 'doc.editor', scope: { type: 'doc', id: '1' } },
    { subject: { type: 'user', id: 'me' }, role: 'doc.editor', scope: { type: 'doc', id: '3' } },
    { subject: { type: 'user', id: '*' }, role: 'doc.viewer', scope: GLOBAL },
  ]) as readonly { readonly subject: PrincipalRef; readonly role: string; readonly scope: ResourceRef }[],
  listPath: '/docs' as const,
});

export interface ClientAccessApp {
  /** Origin of the running app, e.g. `http://127.0.0.1:41234`. */
  readonly baseUrl: string;
  /** Headers that authenticate as user `id`; no id: no credential (the app's anonymous principal). */
  headers(id?: 'me' | 'other'): Readonly<Record<string, string>>;
  /** Assigns `role` at `scope` to user `id` through AuthzAdmin, so the change is pushed. */
  assign(id: 'me' | 'other', role: string, scope: ResourceRef): Promise<void>;
  stop(): Promise<void>;
}

export type ClientAccessHarness = () => Promise<ClientAccessApp>;

export type ClientAccessCheckId = 'wire' | 'permission-names' | 'isolation' | 'subject' | 'anonymous' | 'type-level' | 'limit' | 'access-field' | 'epoch' | 'push';

export interface ClientAccessOptions {
  readonly timeoutMs?: number;
  readonly skip?: readonly ClientAccessCheckId[];
}

const me = { type: 'user', id: 'me' };
/** ckit's `request(id, permission)` (http.test.ts). */
const request = (id: string, permission = 'edit', extra: Readonly<Record<string, unknown>> = {}) => ({ object: { type: 'doc', id }, permission, subject: me, ...extra });
const EPOCH = /^[0-9a-f]{16}$/;

interface Answer {
  readonly status: number;
  readonly results: unknown;
  readonly reasons: unknown;
  readonly epoch: string | null;
  readonly contentType: string | null;
}

async function checks(app: ClientAccessApp, body: unknown, as: 'me' | 'other' | 'anonymous' = 'me'): Promise<Answer> {
  const res = await fetch(`${app.baseUrl}/user/access/checks`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...app.headers(as === 'anonymous' ? undefined : as) }, body: JSON.stringify(body) });
  const payload = (await res.json().catch(() => undefined)) as { results?: unknown; reasons?: unknown } | undefined;
  return { status: res.status, results: payload?.results, reasons: payload?.reasons, epoch: res.headers.get('x-access-epoch'), contentType: res.headers.get('content-type') };
}

function booleans(a: Answer, n: number, what: string): boolean[] {
  check(a.status === 200, `${what}: status ${a.status}`);
  check(Array.isArray(a.results) && a.results.length === n && a.results.every((r) => typeof r === 'boolean'), () => `${what}: results must be ${n} booleans, got ${JSON.stringify(a.results)}`);
  check(Array.isArray(a.reasons) && a.reasons.length === n, () => `${what}: reasons must have ${n} entries, got ${JSON.stringify(a.reasons)}`);
  return a.results as boolean[];
}

const same = (a: readonly unknown[], b: readonly unknown[], what: string) => check(JSON.stringify(a) === JSON.stringify(b), () => `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

/** The first SSE event named `name` on an open response, or a failure after `timeoutMs`. */
async function nextEvent(res: Response, name: string, timeoutMs: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => (timer = setTimeout(() => r(null), Math.max(1, deadline - Date.now()))))]);
      clearTimeout(timer);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        const event =
          lines
            .find((l) => l.startsWith('event:'))
            ?.slice(6)
            .trim() ?? 'message';
        if (event === name)
          return lines
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return fail(`push: no ${name} event within ${timeoutMs} ms`);
}

/** The checks in run order; `push` changes the app's data, so it runs last. */
export function clientAccessConformanceChecks(app: () => ClientAccessApp, opts: ClientAccessOptions = {}): readonly ConformanceCheck<ClientAccessCheckId>[] {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const docs = ['1', '2', '3', '4'];
  return [
    {
      id: 'wire',
      title: "ckit's default wire format: { checks } in, { results } out, one boolean per check in order; context is never env",
      run: async () => {
        const a = await checks(app(), { checks: [request('1'), request('2', 'edit', { context: { ip: '10.0.0.1' } }), request('3'), request('4')] });
        same(booleans(a, 4, 'wire'), [true, false, true, false], 'wire: answers');
        check(a.contentType?.startsWith('application/json') === true, `wire: content-type ${a.contentType}`);
        check(a.epoch !== null && EPOCH.test(a.epoch), `wire: X-Access-Epoch ${a.epoch}`);
      },
    },
    {
      id: 'permission-names',
      title: "a permission without ':' becomes <type>:<permission>; one with ':' is used as given",
      run: async () => {
        const short = booleans(await checks(app(), { checks: docs.map((id) => request(id, 'edit')) }), 4, 'short names');
        const full = booleans(await checks(app(), { checks: docs.map((id) => request(id, 'doc:edit')) }), 4, 'full names');
        same(short, full, 'permission names');
      },
    },
    {
      id: 'isolation',
      title: 'a malformed or unknown entry is false and never fails the batch',
      run: async () => {
        const a = await checks(app(), { checks: [request('1'), { object: null, permission: 'edit' }, request('1', 'nope'), { object: { type: 'unknown-type', id: '1' }, permission: 'edit' }, request('3')] });
        same(booleans(a, 5, 'isolation'), [true, false, false, false, true], 'isolation: answers');
        check((a.reasons as unknown[])[0] === null, 'isolation: an allowed entry has a null reason');
      },
    },
    {
      id: 'subject',
      title: "the subject is the session's principal: another subject is false with subject_mismatch; no subject or the caller's own is the caller",
      run: async () => {
        // As 'other' about 'me', who can edit doc 1: an app that honours the body subject answers true first.
        const a = await checks(app(), { checks: [request('1', 'edit'), { object: { type: 'doc', id: '1' }, permission: 'view' }, request('1', 'view', { subject: { type: 'user', id: 'other' } })] }, 'other');
        same(booleans(a, 3, 'subject'), [false, true, true], 'subject: answers (true first means the app answered for the body subject)');
        check((a.reasons as unknown[])[0] === 'subject_mismatch', () => `subject: reason ${JSON.stringify((a.reasons as unknown[])[0])}`);
      },
    },
    {
      id: 'anonymous',
      title: 'an anonymous caller may ask and gets false where no grant reaches it',
      run: async () => {
        const a = await checks(app(), { checks: docs.map((id) => ({ object: { type: 'doc', id }, permission: 'view' })) }, 'anonymous');
        same(booleans(a, 4, 'anonymous'), [false, false, false, false], 'anonymous: answers (user:* does not cover anonymous)');
      },
    },
    {
      id: 'type-level',
      title: "object id '*' asks at the type level",
      run: async () => {
        const a = await checks(app(), { checks: [request('*', 'view'), request('*', 'edit')] });
        same(booleans(a, 2, 'type-level'), [true, false], 'type-level: view through user:* at $global, no global edit');
      },
    },
    {
      id: 'limit',
      title: "a batch of ckit's default maximum (100) is answered",
      run: async () => {
        const a = await checks(app(), { checks: Array.from({ length: 100 }, (_, i) => request(docs[i % 4])) });
        booleans(a, 100, 'limit');
      },
    },
    {
      id: 'access-field',
      title: 'each $access entry of a list row equals what /user/access/checks answers for that row',
      run: async () => {
        const a = app();
        const res = await fetch(`${a.baseUrl}${CLIENT_ACCESS_FIXTURE.listPath}`, { headers: { accept: 'application/json', ...a.headers('me') } });
        check(res.status === 200, `access-field: list status ${res.status}`);
        const rows = (await res.json()) as { id: unknown; $access?: Record<string, unknown> }[];
        same(rows.map((r) => String(r.id)).sort(), docs, 'access-field: listed ids (user:* views every doc)');
        for (const row of rows) {
          for (const [permission, value] of Object.entries(row.$access ?? fail(`access-field: row ${String(row.id)} has no $access`))) {
            const [answer] = booleans(await checks(a, { checks: [request(String(row.id), permission)] }), 1, `access-field ${String(row.id)} ${permission}`);
            check(value === answer, `access-field: row ${String(row.id)} $access['${permission}'] = ${String(value)}, checks = ${answer}`);
          }
        }
      },
    },
    {
      id: 'epoch',
      title: 'X-Access-Epoch is stable for a session and differs between principals',
      run: async () => {
        const first = (await checks(app(), { checks: [request('1')] })).epoch;
        const again = (await checks(app(), { checks: [request('1')] })).epoch;
        const other = (await checks(app(), { checks: [] }, 'other')).epoch;
        check(first !== null && first === again, `epoch: ${first} then ${again}`);
        check(other !== null && other !== first, `epoch: other principal ${other}, me ${first}`);
      },
    },
    {
      id: 'push',
      title: 'an assignment to the caller pushes authz.changed on GET /user/access/events, and checks then follow it',
      run: async () => {
        const a = app();
        const abort = new AbortController();
        const res = await fetch(`${a.baseUrl}/user/access/events`, { headers: { accept: 'text/event-stream', ...a.headers('me') }, signal: abort.signal });
        try {
          check(res.status === 200 && res.headers.get('content-type')?.startsWith('text/event-stream') === true, `push: events status ${res.status}, content-type ${res.headers.get('content-type')}`);
          const pending = nextEvent(res, 'authz.changed', timeoutMs);
          // A failing assign aborts the stream below; pending's rejection is then not the failure to report.
          pending.catch(() => undefined);
          await a.assign('me', 'doc.editor', { type: 'doc', id: '2' });
          const data = JSON.parse(await pending) as { objects?: { type: string; id: string }[] };
          if (data.objects)
            check(
              data.objects.some((o) => o.type === 'doc' && o.id === '2'),
              () => `push: objects ${JSON.stringify(data.objects)} leave out doc:2`,
            );
          same(booleans(await checks(a, { checks: [request('2')] }), 1, 'push'), [true], 'push: doc 2 after the grant');
        } finally {
          abort.abort();
        }
      },
    },
  ];
}

/** Starts the app once, runs every check in order, stops the app. */
export function runClientAccessConformance(name: string, harness: ClientAccessHarness, opts: ClientAccessOptions = {}): void {
  let app: ClientAccessApp | undefined;
  const checksInOrder = clientAccessConformanceChecks(() => app ?? fail('the app did not start'), opts);
  describe(name, function () {
    this.timeout((opts.timeoutMs ?? 5000) * 3);
    before(async () => {
      app = await harness();
    });
    after(async () => {
      await app?.stop();
      app = undefined;
    });
    for (const c of checksInOrder) {
      if (opts.skip?.includes(c.id)) it(c.title);
      else it(c.title, () => c.run());
    }
  });
}
