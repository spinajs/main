var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { AuthzDomains, isPermission, parsePermission } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy, Query, Req } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { _check_arg, _is_string, _non_empty, _one_of } from '@spinajs/util';
import { forbidden, holdsExplain, unauthenticated } from '../access/policy.js';
import { explainTree } from './tree.js';
import '../storage.js';
function splitKey(raw, what) {
    const key = _check_arg(_is_string(_non_empty()))(raw, what);
    const at = key.indexOf(':');
    const rawType = at < 0 ? key : key.slice(0, at);
    const id = at < 0 ? undefined : key.slice(at + 1);
    // principalKey escapes '%' and ':' in the type part only.
    const type = rawType.replace(/%3A/gi, ':').replace(/%25/g, '%');
    if (type === '' || id === '')
        throw new InvalidArgument(`${what} must be <type>:<id>`, what);
    return id === undefined ? { type } : { type, id };
}
/** Allows a caller who holds `authz.http.explainRoute.permission` in the access domain. */
export class ExplainPolicy extends BasePolicy {
    isEnabled() {
        return true;
    }
    async execute(req) {
        const principal = req.storage.Principal;
        if (!principal?.authenticated)
            throw unauthenticated('the explain route needs an authenticated principal');
        const { held, decision } = await holdsExplain(await this.Domains.service(this.AccessDomain), principal, this.ExplainPermission);
        if (!held)
            throw forbidden(decision);
    }
}
__decorate([
    Config('authz.http.access.domain'),
    __metadata("design:type", String)
], ExplainPolicy.prototype, "AccessDomain", void 0);
__decorate([
    Config('authz.http.explainRoute.permission'),
    __metadata("design:type", String)
], ExplainPolicy.prototype, "ExplainPermission", void 0);
__decorate([
    Autoinject(AuthzDomains),
    __metadata("design:type", AuthzDomains)
], ExplainPolicy.prototype, "Domains", void 0);
/**
 * `GET /authz/explain?principal=<type>:<id>&permission=&resource=<type>[:<id>]&format=decision|tree`: the decision with
 * its trace (design §11.4). Mounted only by ExplainControllerSource: when
 * `authz.http.explainRoute.enabled` and never in production (H19, B41).
 */
let ExplainController = class ExplainController extends BaseController {
    async explain(_req, principal, permission, resource, format) {
        _check_arg(_one_of([undefined, '', 'decision', 'tree'], new InvalidArgument("format must be 'decision' or 'tree'", 'format')))(format, 'format');
        const target = splitKey(principal, 'principal');
        if (target.id === undefined)
            throw new InvalidArgument('principal must be <type>:<id>', 'principal');
        if (!isPermission(permission))
            throw new InvalidArgument('permission must be a permission name', 'permission');
        const ref = resource === undefined || resource === '' ? { type: parsePermission(permission).resource } : splitKey(resource, 'resource');
        const subject = Object.freeze({ type: target.type, id: target.id, authenticated: target.type !== 'anonymous' && target.type !== 'unattended', source: 'explain', attributes: Object.freeze({}) });
        const authz = await this.Domains.service(this.AccessDomain);
        const decision = await authz.explain({ principal: subject, permission, resource: ref });
        return new Ok(format === 'tree' ? explainTree(decision) : decision);
    }
};
__decorate([
    Config('authz.http.access.domain'),
    __metadata("design:type", String)
], ExplainController.prototype, "AccessDomain", void 0);
__decorate([
    Autoinject(AuthzDomains),
    __metadata("design:type", AuthzDomains)
], ExplainController.prototype, "Domains", void 0);
__decorate([
    Get('explain'),
    Policy(ExplainPolicy),
    __param(0, Req()),
    __param(1, Query()),
    __param(2, Query()),
    __param(3, Query()),
    __param(4, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String]),
    __metadata("design:returntype", Promise)
], ExplainController.prototype, "explain", null);
ExplainController = __decorate([
    BasePath('authz')
], ExplainController);
export { ExplainController };
//# sourceMappingURL=controller.js.map