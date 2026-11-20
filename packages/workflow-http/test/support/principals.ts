import { TRUE } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { PrincipalSource } from '@spinajs/authz-http';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';
import type { Request } from '@spinajs/http';

import { WORKFLOW_MANAGE, WORKFLOW_READ, WORKFLOW_READ_PAYLOAD, WORKFLOW_SIGNAL } from '../../src/permissions.js';

export const TEST_USER_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  'workflow-reader': [WORKFLOW_READ],
  'workflow-auditor': [WORKFLOW_READ, WORKFLOW_READ_PAYLOAD],
  'workflow-signaler': [WORKFLOW_READ, WORKFLOW_SIGNAL],
  'workflow-admin': [WORKFLOW_READ, WORKFLOW_SIGNAL, WORKFLOW_MANAGE],
};

/** `x-test-role: <role>` signs in as the test user holding that role; `x-test-scoped: 1` adds a ceiling, as a scoped token would. */
export class TestRoleSource extends PrincipalSource {
  public readonly name = 'workflow-test-role';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const role = req.headers['x-test-role'];
    if (typeof role !== 'string' || role === '') return null;
    const principal = userPrincipal(TEST_USER_UUID, { source: 'session', attributes: { role } });
    return req.headers['x-test-scoped'] === '1' ? { ...principal, ceiling: { permissions: [WORKFLOW_READ, WORKFLOW_SIGNAL] } } : principal;
  }
}

export function roleModel(): StaticModel {
  return new StaticModel({
    name: 'workflow-test-roles',
    votes: (r) => ((ROLE_PERMISSIONS[String(r.principal.attributes.role)] ?? []).includes(r.permission) ? { permitWhen: TRUE } : {}),
  });
}
