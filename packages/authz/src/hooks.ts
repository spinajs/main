import type { ActionName } from '@spinajs/hooks';
import type { AuthzAdminOptions, AuthzCommand, AuthzCommandResult } from './contracts/admin.js';
import type { Decision } from './contracts/decision.js';
import type { Permission } from './contracts/permission.js';
import type { Principal, ResourceRef } from './contracts/principal.js';

/** The actions @spinajs/authz declares. */
export type AuthzActionName = Extract<ActionName, `authz.${string}`>;

declare module '@spinajs/hooks' {
  interface HookActions {
    /** Before the commands of a batch are validated; `commands` is mutable (every command is checked again). The output says whether the batch was a replay or a dry run. */
    'authz.admin.batch': { input: { actor: Principal; commands: readonly AuthzCommand[]; opts?: AuthzAdminOptions }; output: { results: readonly AuthzCommandResult[]; replayed: boolean; dryRun: boolean } };
    /** Per command, after validate() and before AdminGuard.check(); a changed `command` is validated and permission-checked again. */
    'authz.admin.command': { input: { actor: Principal; command: AuthzCommand }; output: { command: AuthzCommand } };
    /** Opt-in (authz.hooks.check): after the decision cache lookup of check, can and assert. A refusal denies; nothing is mutable. */
    'authz.check': { input: { principal: Principal; permission: Permission; resource: ResourceRef }; output: Decision };
  }
}
