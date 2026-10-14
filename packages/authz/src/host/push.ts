import { Singleton } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

import { AuthzConfigError } from '../contracts/errors.js';
import type { ResourceRef } from '../contracts/principal.js';
import { resourceKey } from '../contracts/resource.js';
import { AccessPushTransport, ChangeAudience } from '../contracts/service.js';
import type { AccessChangedEvent, AuthzChange, ChangeBus } from '../contracts/service.js';
import { engineLog } from './log.js';
import type { HostLog } from './log.js';

/** The event name every push transport sends an AccessChangedEvent under (design §10.4). */
export const AUTHZ_CHANGED_EVENT = 'authz.changed';

type Audience = { readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] };

const EVERYONE: Audience = Object.freeze({ principals: '*' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nameOf = (v: unknown): string => {
  try {
    if (isObject(v) && typeof v.name === 'string') return v.name;
    return isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v);
  } catch {
    return '<unreadable>';
  }
};

async function chain<T>(container: IContainer, token: Class<T>): Promise<T[]> {
  return container.hasRegistered(token) ? [...(await container.resolve(Array.chainOf(token)))] : [];
}

/** Throws on a malformed answer, which widens the push to every session. */
function readAudience(raw: unknown): Audience {
  if (!isObject(raw)) throw new Error(`expected { principals, objects? }, got ${raw === null ? 'null' : typeof raw}`);
  const p = raw.principals;
  if (p !== '*' && !(Array.isArray(p) && p.every((x) => typeof x === 'string'))) throw new Error('principals must be "*" or a list of principal keys');
  const principals = p === '*' ? '*' : Object.freeze([...(p as string[])]);
  const o = raw.objects;
  if (o === undefined) return { principals };
  if (!Array.isArray(o) || !o.every((r) => isObject(r) && typeof r.type === 'string' && r.type !== '' && (r.id === undefined || typeof r.id === 'string'))) throw new Error('objects must be a list of resource refs');
  return { principals, objects: (o as ResourceRef[]).map((r) => Object.freeze(r.id === undefined ? { type: r.type } : { type: r.type, id: r.id })) };
}

/**
 * Resource-access plan decision 4: each AuthzChange of the root ChangeBus becomes one AccessChangedEvent
 * per registered transport, for the principals the ChangeAudiences name. Audiences and transports are
 * resolved per change, so ones registered after boot count.
 */
@Singleton()
export class AccessChangeRouter {
  protected log: HostLog = engineLog('authz-push');

  start(bus: ChangeBus, container: IContainer): () => void {
    const off: unknown = bus.subscribe((change) => {
      void this.route(change, container);
    });
    if (typeof off !== 'function') throw new AuthzConfigError('AccessChangeRouter: ChangeBus.subscribe did not return an unsubscribe function');
    return off as () => void;
  }

  /** Never rejects: the change is committed, so a failure here is logged and that push dropped. */
  async route(change: AuthzChange, container: IContainer): Promise<void> {
    try {
      const transports = await chain(container, AccessPushTransport);
      if (transports.length === 0) return;
      const audience = await this.audienceOf(change, container);
      if (audience.principals !== '*' && audience.principals.length === 0) return;
      const event: AccessChangedEvent = Object.freeze(audience.objects === undefined ? {} : { objects: Object.freeze(audience.objects) });
      await Promise.all(
        transports.map(async (t) => {
          try {
            await t.push(audience.principals, event);
          } catch (e) {
            this.log.error(`authz push: transport ${JSON.stringify(nameOf(t))} failed: ${describeError(e)}`);
          }
        }),
      );
    } catch (e) {
      this.log.error(`authz push: routing a change failed: ${describeError(e)}`);
    }
  }

  private async audienceOf(change: AuthzChange, container: IContainer): Promise<Audience> {
    const tags: unknown = isObject(change) ? change.tags : undefined;
    if (!Array.isArray(tags) || tags.includes('*')) return EVERYONE;
    const audiences = await chain(container, ChangeAudience);
    if (audiences.length === 0) return EVERYONE;
    const answers = await Promise.all(
      audiences.map(async (a) => {
        try {
          return readAudience(await a.audience(change));
        } catch (e) {
          this.log.error(`authz push: audience ${JSON.stringify(nameOf(a))} failed, pushing to every session: ${describeError(e)}`);
          return EVERYONE;
        }
      }),
    );
    const principals: readonly string[] | '*' = answers.some((a) => a.principals === '*') ? '*' : Object.freeze([...new Set(answers.flatMap((a) => a.principals as readonly string[]))].sort());
    if (!answers.every((a) => a.objects !== undefined)) return { principals };
    const objects = new Map<string, ResourceRef>();
    for (const a of answers) for (const o of a.objects!) objects.set(resourceKey(o), o);
    return { principals, objects: [...objects.values()] };
  }
}
