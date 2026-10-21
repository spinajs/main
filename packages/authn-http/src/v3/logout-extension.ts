import type { IContainer } from '@spinajs/di';
import type { Request } from '@spinajs/http';
import type { Log } from '@spinajs/log';
import type { Session } from '@spinajs/authn/contracts';

/**
 * Registered with Array.ofType. `POST /auth/logout` calls every extension after it revoked the session; the first
 * redirect any of them answers sends the browser on (303), or is reported as `{ endSession }` to a script (200).
 */
export abstract class AuthnLogoutExtension {
  /** Runs after the session is revoked; the first redirect wins. */
  abstract afterLogout(session: Session, req: Request): Promise<{ readonly redirect?: string } | void>;
}

/**
 * Runs every registered extension in order and answers the first redirect. A failing extension is logged and skipped:
 * the session is already revoked, so the logout has happened whatever an extension does.
 */
export async function runLogoutExtensions(container: IContainer, session: Session, req: Request, log: Pick<Log, 'warn'>): Promise<string | undefined> {
  const extensions: AuthnLogoutExtension[] = await container.resolve(Array.ofType(AuthnLogoutExtension));
  let redirect: string | undefined;
  // A resolve of the abstract base itself would leave an instance of it in the list; it extends nothing.
  for (const ext of extensions.filter((e) => e?.constructor !== AuthnLogoutExtension && typeof e?.afterLogout === 'function')) {
    try {
      const answer = (await ext.afterLogout(session, req)) as { readonly redirect?: unknown } | undefined;
      if (redirect === undefined && typeof answer?.redirect === 'string' && answer.redirect !== '') redirect = answer.redirect;
    } catch (err) {
      log.warn({ extension: ext.constructor.name, errorName: err instanceof Error ? err.name : typeof err }, 'authn-http: the logout extension ${extension} failed: ${errorName}');
    }
  }
  return redirect;
}
