var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable } from '@spinajs/di';
import { PrincipalSource } from '../api.js';
import '../storage.js';
/**
 * The principal authn-http resolved from a key, token or session and left in
 * `req.storage.AuthnPrincipal` (design §11.1, D26); a session still pending MFA leaves none.
 */
let AuthnPrincipalSource = class AuthnPrincipalSource extends PrincipalSource {
    constructor() {
        super(...arguments);
        this.name = 'authn';
        this.order = 50;
    }
    async authenticate(req) {
        return req.storage?.AuthnPrincipal ?? null;
    }
};
AuthnPrincipalSource = __decorate([
    Injectable(PrincipalSource)
], AuthnPrincipalSource);
export { AuthnPrincipalSource };
//# sourceMappingURL=authn-source.js.map