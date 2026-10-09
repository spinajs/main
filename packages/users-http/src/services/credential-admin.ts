import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { CredentialAdminGuard } from '@spinajs/authn/contracts';
import type { CredentialAdminAction, Principal } from '@spinajs/authn/contracts';

type Refusal = 'forbidden' | 'protected_role' | 'escalation';

const REFUSALS: Record<Refusal, string> = {
  forbidden: 'you may not administer credentials of this user',
  protected_role: 'the user holds a protected role',
  escalation: 'the user holds rights you do not hold',
};

// @spinajs/http spreads an error's own enumerable props into the body: { error, message }, as authn-http answers.
const coded = <E extends Error>(err: E, code: string): E => Object.assign(err, { error: code });

/**
 * Refuses unless authn's CredentialAdminGuard answers `ok: true` for `actor` acting on user `uuid` (A25, SR-10), the
 * guard authn-http's credential admin routes ask. 403 with the guard's code (`forbidden`, `protected_role`,
 * `escalation`; any other answer is `forbidden`), 404 `not_found`. With no guard registered nobody can tell who may
 * administer whom, so every call is refused.
 */
export async function assertCredentialAdmin(actor: Principal, uuid: string, action: CredentialAdminAction, container: IContainer = DI.RootContainer): Promise<void> {
  if (!container.hasRegistered(CredentialAdminGuard as unknown as Class<CredentialAdminGuard>)) {
    throw coded(new Forbidden('no credential admin guard is registered'), 'forbidden');
  }

  const guard = (await container.resolve(CredentialAdminGuard)) as CredentialAdminGuard;
  const verdict: unknown = await guard.allowed(actor, { type: 'user', id: uuid }, action);
  // A guard written past the types may answer anything; only `ok: true` opens the effect.
  if ((verdict as { ok?: unknown } | null)?.ok === true) {
    return;
  }

  const code = (verdict as { code?: unknown } | null)?.code;
  if (code === 'not_found') {
    throw coded(new ResourceNotFound('No such user'), 'not_found');
  }

  const known: Refusal = typeof code === 'string' && Object.hasOwn(REFUSALS, code) ? (code as Refusal) : 'forbidden';
  throw coded(new Forbidden(REFUSALS[known]), known);
}
