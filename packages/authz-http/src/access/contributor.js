var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { DI, Injectable } from '@spinajs/di';
import { AuthzContributor, parsePermission } from '@spinajs/authz';
import { BaseController } from '@spinajs/http';
import { ACCESS_CLASS, accessDescriptorOf } from './descriptor.js';
import { extractorType } from './extractors.js';
/**
 * Feeds the permissions every registered controller's `@Access` names to boot rule 7 of the
 * domain it checks in (design §6.5): an unregistered permission, or one checked on a type outside
 * its types, fails that domain's boot (B02). Controllers registered after a domain booted are
 * checked by the next boot only.
 */
let AccessContributor = class AccessContributor extends AuthzContributor {
    contribute(domain) {
        const permissionRefs = [];
        for (const type of new Set(DI.getRegisteredTypes(BaseController) ?? [])) {
            const descriptor = accessDescriptorOf(type);
            if (!descriptor)
                continue;
            for (const [key, rule] of descriptor.Access) {
                if ((rule.options.domain ?? 'root') !== domain)
                    continue;
                const source = `@Access on ${type.name}${key === ACCESS_CLASS ? '' : `.${String(key)}`}`;
                for (const permission of rule.permissions) {
                    // Without an extractor the check runs on the type-level ref of the permission resource.
                    const resourceType = rule.options.resource ? extractorType(rule.options.resource) : parsePermission(permission).resource;
                    permissionRefs.push(resourceType === undefined ? { permission, source } : { permission, type: resourceType, source });
                }
            }
        }
        return { permissionRefs };
    }
};
AccessContributor = __decorate([
    Injectable(AuthzContributor)
], AccessContributor);
export { AccessContributor };
//# sourceMappingURL=contributor.js.map