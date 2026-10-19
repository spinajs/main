import type { AuthzDomains, AuthzService, Permission, Principal, ResourceRef } from '@spinajs/authz';
import type { Log } from '@spinajs/log';
export declare const MAX_ACCESS_CHECKS = 100;
/** `reasons[i]` codes the endpoint sets itself; a denial carries the decision's own `reason.code`. */
export declare const CLIENT_CHECK_REASONS: Readonly<{
    readonly invalid: 'invalid_request';
    readonly subjectMismatch: 'subject_mismatch';
    readonly conditional: 'conditional';
    readonly fieldDenied: 'field_denied';
}>;
export interface ClientChecksAnswer {
    readonly results: boolean[];
    readonly reasons: (string | null)[];
}
export interface ClientCheck {
    readonly permission: Permission;
    readonly resource: ResourceRef;
    readonly field?: {
        readonly name: string;
        readonly mode: 'read' | 'write';
    };
}
export interface ClientCheckOptions {
    /** The `authz` config section; `decisionFields` reads `fields.neverRead` from it. */
    readonly authz: unknown;
    /** The host AuthzDomains, which `decisionFields` reads the domain's config lineage from. */
    readonly domains: AuthzDomains;
    readonly log: Log;
}
/** One `checks[]` entry (ckit's `{ object, permission, subject?, context? }`) as a check, or the reason it is answered false. `checkAll` throws on a malformed entry, so none may reach it. */
export declare function readClientCheck(raw: unknown, principal: Principal): ClientCheck | string;
/** Design §10.2: only a definite allow is true; a bad entry costs its own answer, never the batch. */
export declare function answerClientChecks(service: AuthzService, principal: Principal, raw: readonly unknown[], opts: ClientCheckOptions): Promise<ClientChecksAnswer>;
//# sourceMappingURL=checks.d.ts.map