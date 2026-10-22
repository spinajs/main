import { AuthzService, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';
import { AuthzCliBase } from '@spinajs/authz/cli';
import { OrmMigrator } from '@spinajs/orm';

// Registers the RBAC write handlers of AuthzAdmin: the CLI loads only the command modules.
import '../admin/index.js';

/**
 * Resolves AuthzService only when the command runs it, so a failing authz boot becomes a message; tests set `Authz`.
 * A command whose run touches the RBAC DB stores resolves `OrmMigrator` first: their queries need the
 * `Migration.OnStartup` pass an app process runs before serving.
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
        await this.Container.resolve(OrmMigrator);
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
