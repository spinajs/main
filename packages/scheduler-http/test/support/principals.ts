import { TRUE } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { PrincipalSource } from '@spinajs/authz-http';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';
import type { Request } from '@spinajs/http';

import { SCHEDULER_MANAGE, SCHEDULER_READ, SCHEDULER_RUN } from '../../src/permissions.js';

export const TEST_USER_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** What a user principal carries as `identity`: the user record, whose Login names the caller in `triggeredBy`. */
const TEST_USER = { Id: 7, Uuid: TEST_USER_UUID, Login: 'tester', Email: 'tester@spinajs.pl' };

const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  'scheduler-reader': [SCHEDULER_READ],
  'scheduler-operator': [SCHEDULER_READ, SCHEDULER_RUN],
  'scheduler-admin': [SCHEDULER_READ, SCHEDULER_RUN, SCHEDULER_MANAGE],
};

/**
 * `x-test-role: <role>` signs the request in as the one test user holding that role, `x-test-token`
 * also marks it as an api-token request. Registered by class: DI never returns factory registrations
 * from Array.ofType.
 */
export class TestRoleSource extends PrincipalSource {
  public readonly name = 'scheduler-test-role';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const role = req.headers['x-test-role'];
    if (typeof role !== 'string' || role === '') {
      return null;
    }

    const token = req.headers['x-test-token'];
    return userPrincipal(TEST_USER_UUID, {
      source: typeof token === 'string' && token !== '' ? 'token' : 'session',
      // the role is part of the decision cache key, so one user id with several roles never shares a decision
      attributes: { role },
      identity: TEST_USER,
    });
  }
}

/** Grants each test role its scheduler permissions; any other role, `nobody` included, gets no opinion and so a 403. */
export function roleModel(): StaticModel {
  return new StaticModel({
    name: 'scheduler-test-roles',
    votes: (r) => ((ROLE_PERMISSIONS[String(r.principal.attributes.role)] ?? []).includes(r.permission) ? { permitWhen: TRUE } : {}),
  });
}
