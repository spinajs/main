var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { ceilingHash, principalKey } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import { PRINCIPAL_MIDDLEWARE_ORDER } from '../principals/middleware.js';
import '../storage.js';
export const ACCESS_EPOCH_HEADER = 'X-Access-Epoch';
export const ACCESS_EPOCH_MIDDLEWARE_ORDER = PRINCIPAL_MIDDLEWARE_ORDER + 1;
/**
 * Changes when the principal's access may change while no authz data does (design §10.4): login, role
 * switch, MFA elevation and impersonation all rotate the session, which changes `authn.sessionHandle`.
 */
export function accessEpoch(principal) {
    return createHash('sha256')
        .update(principalKey(principal) + (principal.authn?.sessionHandle ?? '') + ceilingHash(principal.ceiling))
        .digest('hex')
        .slice(0, 16);
}
let AccessEpochMiddleware = class AccessEpochMiddleware extends ServerMiddleware {
    constructor() {
        super();
        this.Order = ACCESS_EPOCH_MIDDLEWARE_ORDER;
    }
    // In before(): after() never runs for a matched controller route.
    before() {
        return (req, res, next) => {
            const principal = req.storage.Principal;
            if (principal)
                res.setHeader(ACCESS_EPOCH_HEADER, accessEpoch(principal));
            next();
        };
    }
    after() {
        return null;
    }
};
AccessEpochMiddleware = __decorate([
    Injectable(ServerMiddleware),
    __metadata("design:paramtypes", [])
], AccessEpochMiddleware);
export { AccessEpochMiddleware };
//# sourceMappingURL=epoch.js.map