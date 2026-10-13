import { v4 as uuidv4 } from 'uuid';
import type { Class } from '@spinajs/di';
import { DI } from '@spinajs/di';
import { AuthorizationModel, AuthzService, principalKey } from '@spinajs/authz';
import { instantiateWorld, testHost } from '@spinajs/authz-testing';
import type { BehaviourAuthz, BehaviourHarness, HarnessSession, HttpHandle, HttpRequest, HttpResponse, World } from '@spinajs/authz-testing';
import type { BaseController } from '@spinajs/http';
import { User } from '@spinajs/users';

import { startUsersHttpApp, stopUsersHttpApp } from './http-app.js';
import { ownedCache } from './owned-cache.js';

// World keys this harness has no place for; a fixture that sets one fails at setup instead of passing unheard.
const UNSUPPORTED: readonly (keyof World)[] = ['now', 'adapters', 'scopes', 'relations', 'domains', 'rbac', 'abac', 'rebac', 'scopeAttributes'];

function permissionsOf(world: World): Record<string, unknown> {
  return Object.fromEntries(
    world.permissions.map((p) => {
      if (typeof p === 'string') return [p, {}];
      const { name, source: _source, ...def } = p;
      return [name, structuredClone(def)];
    }),
  );
}

/**
 * `runBehaviour` harness over the lane's http app (`startUsersHttpApp`), one app per case. Root plays the world's root:
 * the world's kit models are registered in root before it boots, and `combine`, `permissions` and `config.<key>` go to
 * `authz.*`. Each `lane.http.identities` entry becomes a users row; users accepts only v4 UUIDs as `Uuid`, so the row
 * gets a fresh one and a request of that world principal signs that row in through the app's SessionIssuer. The route
 * then sees users' principal of the row, not the world's object.
 */
export function usersHttpHarness(controllers: readonly Class<BaseController>[]): BehaviourHarness {
  const owned = ownedCache();

  return {
    facets: ['engine', 'http'],
    domain: 'root',

    async beforeAll() {
      owned.begin();
    },

    async afterAll() {
      owned.reset();
    },

    async setup(world): Promise<HarnessSession> {
      for (const key of UNSUPPORTED) {
        if (world[key] !== undefined) throw new Error(`users-http harness: world.${key} is not supported`);
      }
      const http = world.lane?.http;
      if (http?.routes || http?.env || http?.config) throw new Error('users-http harness: lane.http serves the users-http controllers and identities only');

      const kit = instantiateWorld(world);
      const undo = kit.models.map((m) => testHost.registerInRoot(AuthorizationModel as unknown as Class<AuthorizationModel>, testHost.instance(m)));
      const dispose = async () => {
        try {
          await stopUsersHttpApp();
        } finally {
          for (const u of undo) u();
          owned.reset();
        }
      };

      try {
        const config: Record<string, unknown> = { 'authz.combine': structuredClone(world.combine) };
        for (const [key, value] of Object.entries(world.config ?? {})) if (value !== undefined) config[`authz.${key}`] = structuredClone(value);
        if (world.config?.cache === undefined) config['authz.cache.maxEntries'] = 0;

        const app = await startUsersHttpApp({ controllers, config, permissions: permissionsOf(world) });

        const rows = new Map<string, string>();
        for (const [key, record] of Object.entries(http?.identities ?? {})) {
          if (!key.startsWith('user:')) throw new Error(`users-http harness: identity ${key} is not a user`);
          const uuid = uuidv4();
          await new User({ ...record, Uuid: uuid }).insert();
          rows.set(key, uuid);
        }

        const request = async (req: HttpRequest): Promise<HttpResponse> => {
          if (req.method === 'PUT') throw new Error('users-http harness: the app client sends no PUT');
          let client = app.anonymous();
          if (req.principal) {
            const uuid = rows.get(principalKey(req.principal));
            if (!uuid) throw new Error(`users-http harness: ${principalKey(req.principal)} has no identity in lane.http.identities`);
            client = await app.signIn(uuid);
          }
          const res = await client.send(req.method, req.path, req.body, { ...(req.headers ?? {}) });
          return { status: res.status, body: res.body };
        };
        const lane: HttpHandle = {
          request,
          logs: () => {
            throw new Error('users-http harness: the app log is not captured');
          },
        };

        return {
          authz: (await DI.resolve(AuthzService)) as unknown as BehaviourAuthz,
          kit,
          domain: 'root',
          lane: { http: lane },
          dispose,
        };
      } catch (e) {
        await dispose();
        throw e;
      }
    },
  };
}
