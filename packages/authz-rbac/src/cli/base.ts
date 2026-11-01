import { AuthzService, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';
import { AuthzCliBase } from '@spinajs/authz/cli';
import { Orm } from '@spinajs/orm';

// Registers the RBAC write handlers of AuthzAdmin: the CLI loads only the command modules.
import '../admin/index.js';

/**
 * Resolves AuthzService only when the command runs it, so a failing authz boot becomes a message; tests set `Authz`.
 * A command whose run touches the RBAC DB stores resolves the `Orm` first, which applies the
 * `Migration.OnStartup` migrations an app process applies before serving.
 */
export abstract class AuthzCliCommand extends AuthzCliBase {
  public Authz?: AuthzService;

  /** Whether this command reads or writes the DB stores. The assignments, membership and admin backend are DB-backed. */
  protected touchesDb(): boolean {
    return true;
  }

  protected async authz(): Promise<AuthzService> {
    if (!this.Authz) {
      if (this.touchesDb()) {
        await ((await this.Container.resolve(Orm)) as Orm).Migrator.ready();
      }
      this.Authz = (await this.Container.resolve(AuthzService)) as AuthzService;
    }
    return this.Authz;
  }

  protected async admin(): Promise<AuthzAdmin> {
    return (await this.authz()).admin();
  }

  /** As SYSTEM with reason 'cli'; a bad command line never boots authz. */
  protected async asSystem(run: () => Promise<void>): Promise<void> {
    await (await this.authz()).runAs(SYSTEM, 'cli', run);
  }
}
