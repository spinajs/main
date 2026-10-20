var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { PrincipalSource } from '../api.js';
import { servicePrincipals } from '../http-config.js';
const digest = (s) => createHash('sha256').update(s, 'utf8').digest();
// Equal-length digests, so neither the token's length nor its first differing byte shows in the timing.
const sameToken = (presented, expected) => timingSafeEqual(digest(presented), digest(expected));
function servicePrincipal(s) {
    return Object.freeze({ type: 'service', id: s.name, authenticated: true, source: 'service', attributes: s.attributes });
}
/**
 * `service:<name>` for a request whose configured header carries one of the service's tokens
 * (`authz.http.services`, design §11.1). Runs before the authn principal (order 40 < 50), so a
 * configured service header wins over any authn credential. A wrong token yields nothing: the
 * header may be one other credentials share.
 */
let ServicePrincipalSource = class ServicePrincipalSource extends PrincipalSource {
    constructor() {
        super(...arguments);
        this.name = 'service';
        this.order = 40;
    }
    async authenticate(req) {
        for (const service of servicePrincipals(this.Services ?? [])) {
            const presented = req.headers?.[service.header];
            if (typeof presented !== 'string' || presented.length === 0) {
                continue;
            }
            // Every token is compared, matched or not.
            const matches = service.tokens.map((t) => sameToken(presented, t));
            if (matches.includes(true)) {
                return servicePrincipal(service);
            }
        }
        return null;
    }
};
__decorate([
    Config('authz.http.services'),
    __metadata("design:type", Object)
], ServicePrincipalSource.prototype, "Services", void 0);
ServicePrincipalSource = __decorate([
    Injectable(PrincipalSource)
], ServicePrincipalSource);
export { ServicePrincipalSource };
//# sourceMappingURL=service-source.js.map