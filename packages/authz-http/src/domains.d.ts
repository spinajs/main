import { DecisionAudit, DefaultAuthzDomains } from '@spinajs/authz';
import type { DomainConfig } from '@spinajs/authz';
/** `domain`'s configuration as its service booted with it; before that boot, merged from `authz`, the caller's `authz` section. */
export declare function domainConfig(authz: unknown, domains: DefaultAuthzDomains, domain: string): DomainConfig;
type AuditEntry = Parameters<DecisionAudit['record']>[0];
/** Records an `unscoped` bypass with the domain's DecisionAudit when the domain's `audit.unscoped` is on. */
export declare function auditUnscoped(domain: string, entry: AuditEntry): Promise<void>;
export {};
//# sourceMappingURL=domains.d.ts.map