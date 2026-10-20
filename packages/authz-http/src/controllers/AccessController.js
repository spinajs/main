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
import { BaseController, BasePath, Body, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Autoinject } from '@spinajs/di';
import { AuthzDomains } from '@spinajs/authz';
import { _check_arg, _is_array, _max_length } from '@spinajs/util';
import { HasPrincipal, IsAuthenticated } from '../access/principal-policies.js';
import { MAX_ACCESS_CHECKS, answerClientChecks } from '../client-access/checks.js';
import { AccessEventStream, SseAccessPushTransport } from '../client-access/sse.js';
import '../storage.js';
/** The caller's own access (design §10, §11.4), in the domain `authz.http.access.domain` (default root). */
let AccessController = class AccessController extends BaseController {
    async summary(req) {
        const authz = await this.Domains.service(this.AccessDomain);
        return new Ok(await authz.summary(req.storage.Principal));
    }
    /** ckit's `createHttpChecker` wire format: `{ checks }` → `{ results, reasons }` (design §10.2). */
    async checks(req, checks) {
        _check_arg(_is_array(), _max_length(MAX_ACCESS_CHECKS))(checks, 'checks');
        const authz = await this.Domains.service(this.AccessDomain);
        return new Ok(await answerClientChecks(authz, req.storage.Principal, checks, { authz: this.Authz, domains: this.Domains, log: this.Log }));
    }
    /** `authz.changed` server-sent events for the caller (design §10.4); authenticated only, as the socket transport. */
    async events(req) {
        return new AccessEventStream(this.Transport, req.storage.Principal);
    }
};
__decorate([
    Config('authz.http.access.domain'),
    __metadata("design:type", String)
], AccessController.prototype, "AccessDomain", void 0);
__decorate([
    Config('authz'),
    __metadata("design:type", Object)
], AccessController.prototype, "Authz", void 0);
__decorate([
    Logger('authz-http'),
    __metadata("design:type", Log)
], AccessController.prototype, "Log", void 0);
__decorate([
    Autoinject(SseAccessPushTransport),
    __metadata("design:type", SseAccessPushTransport)
], AccessController.prototype, "Transport", void 0);
__decorate([
    Autoinject(AuthzDomains),
    __metadata("design:type", AuthzDomains)
], AccessController.prototype, "Domains", void 0);
__decorate([
    Get('/'),
    Policy(HasPrincipal),
    __param(0, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AccessController.prototype, "summary", null);
__decorate([
    Post('checks'),
    Policy(HasPrincipal),
    __param(0, Req()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Array]),
    __metadata("design:returntype", Promise)
], AccessController.prototype, "checks", null);
__decorate([
    Get('events'),
    Policy(IsAuthenticated),
    __param(0, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AccessController.prototype, "events", null);
AccessController = __decorate([
    BasePath('user/access')
], AccessController);
export { AccessController };
//# sourceMappingURL=AccessController.js.map