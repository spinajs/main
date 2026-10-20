import { AuthzService, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';
import { AuthzCliBase } from '@spinajs/authz/cli';

// Registers the RBAC write handlers of AuthzAdmin: the CLI loads only the command modules.
import '../admin/index.js';

/** Resolves AuthzService only when the command runs it, so a failing authz boot becomes a message; tests set `Authz`. */
export abstract class AuthzCliCommand extends AuthzCliBase {
  public Authz?: AuthzService;

  protected async authz(): Promise<AuthzService> {
    return (this.Authz ??= (await this.Container.resolve(AuthzService)) as AuthzService);
  }

  protected async admin(): Promise<AuthzAdmin> {
    return (await this.authz()).admin();
  }

  /** As SYSTEM with reason 'cli'; a bad command line never boots authz. */
  protected async asSystem(run: () => Promise<void>): Promise<void> {
    await (await this.authz()).runAs(SYSTEM, 'cli', run);
  }
}
