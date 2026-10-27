import { DI } from '@spinajs/di';
import { withProblemFields } from '@spinajs/http';
import { Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { Hooks } from '@spinajs/hooks';
import { hookRefusalOf, runCredentialAdmin } from '@spinajs/authn/hooks';
import type { CredentialAdminAction, Principal } from '@spinajs/authn/contracts';

type Refusal = 'forbidden' | 'protected_role' | 'escalation';

const REFUSALS: Record<Refusal, string> = {
  forbidden: 'you may not administer credentials of this user',
  protected_role: 'the user holds a protected role',
  escalation: 'the user holds rights you do not hold',
};

// @spinajs/http spreads an error's own enumerable props into the body: { error, message }, as authn-http answers.
const coded = <E extends Error>(err: E, code: string): E => withProblemFields(err, { error: code });

/**
 * Runs `effect` as authn's `authn.admin.credentials` action for `actor` acting on user `uuid` (A25, SR-10), the action
 * authn-http's credential admin routes run: a CredentialAdminRule must admit it (users registers
 * AuthzCredentialAdminRule), and every other before hook of the action must let it through. A rule's refusal answers
 * 403 with its code (`forbidden`, `protected_role`, `escalation`), or 404 `not_found`; another hook's 403
 * `{ error: 'action_refused', code }`, `hook_error` for a hook that failed. With no rule registered nobody can tell who
 * may administer whom, so every call is refused `forbidden`. A refusal of an action `effect` runs is rethrown.
 */
export async function withCredentialAdmin<T>(actor: Principal, uuid: string, action: CredentialAdminAction, effect: () => Promise<T>, hooks?: Hooks): Promise<T> {
  const runner = hooks ?? ((await DI.resolve(Hooks)) as Hooks);
  try {
    return await runCredentialAdmin(runner, { actor, target: { type: 'user', id: uuid }, action }, effect, () => ({}));
  } catch (err) {
    const refusal = hookRefusalOf(err, 'authn.admin.credentials');
    if (!refusal) {
      throw err;
    }
    if (refusal.code === 'not_found') {
      throw coded(new ResourceNotFound('No such user'), 'not_found');
    }
    if (Object.hasOwn(REFUSALS, refusal.code)) {
      throw coded(new Forbidden(REFUSALS[refusal.code as Refusal]), refusal.code);
    }
    throw withProblemFields(new Forbidden('the action was refused'), { error: 'action_refused', code: refusal.code });
  }
}
