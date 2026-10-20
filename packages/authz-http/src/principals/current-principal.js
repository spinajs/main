var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable } from '@spinajs/di';
import { UNATTENDED } from '@spinajs/authz';
import { Parameter, Route, RouteArgs } from '@spinajs/http';
import '../storage.js';
/** Route arg of `@CurrentPrincipal()`: the request's principal, UNATTENDED without one (as `authz().current()`). */
let CurrentPrincipalArg = class CurrentPrincipalArg extends RouteArgs {
    get SupportedType() {
        return 'CurrentPrincipalArg';
    }
    async extract(callData, _args, _param, req) {
        return { CallData: callData, Args: req.storage?.Principal ?? UNATTENDED };
    }
};
CurrentPrincipalArg = __decorate([
    Injectable()
], CurrentPrincipalArg);
export { CurrentPrincipalArg };
/** The request's principal (design §11.1); `@User()` (users-http) stays the identity record. */
export function CurrentPrincipal() {
    return Route(Parameter('CurrentPrincipalArg', null));
}
//# sourceMappingURL=current-principal.js.map