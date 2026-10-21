var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Autoinject, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_DEFAULTS, AuthzConfigError, AuthzService, authzStorage } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { PrincipalSource } from '../api.js';
import { LinkPrincipalSource } from './link-source.js';
import '../storage.js';
/** The principal of a request no source recognised, while `authz.principals.anonymous.enabled` is on. */
export const ANONYMOUS = Object.freeze({
    type: 'anonymous',
    id: 'anonymous',
    authenticated: false,
    source: 'anonymous',
    attributes: Object.freeze({}),
});
/** Runs after authn-http's AuthnMiddleware (Order 5), which leaves its principal in `req.storage.AuthnPrincipal`. */
export const PRINCIPAL_MIDDLEWARE_ORDER = 10;
/**
 * Resolves the request's principal (design §11.1): the registered `PrincipalSource`s run in ascending
 * `order` and the first non-null answer wins; with none, the anonymous principal when
 * `authz.principals.anonymous.enabled`, else no principal at all. The principal goes to
 * `req.storage.Principal`, the store the action's AsyncLocalStorage runs with, and the root
 * domain preloads it in that store.
 */
let PrincipalMiddleware = class PrincipalMiddleware extends ServerMiddleware {
    constructor() {
        super();
        // The server swallows a listener's errors, so a root that cannot boot stops it: a bad authz config must not serve.
        this.onListening = (server) => {
            this.rootService().catch((err) => {
                this.Log.error(err, 'the root authz domain failed to boot; stopping the http server');
                const stop = server?.stop;
                if (typeof stop === 'function')
                    stop.call(server).catch(() => undefined);
            });
        };
        this.Order = PRINCIPAL_MIDDLEWARE_ORDER;
    }
    async resolve() {
        // The http server resolves its middlewares before the controllers register, and the root
        // boot checks the @Access permissions of the registered controllers (B02): boot once it listens.
        await super.resolve();
        this.Sources = [...this.Sources].sort((a, b) => a.order - b.order);
        DI.RootContainer.once('http.server.listening', this.onListening);
    }
    async dispose() {
        DI.RootContainer.removeListener('http.server.listening', this.onListening);
        await super.dispose();
    }
    before() {
        return (req, _res, next) => {
            this.attach(req).then(() => next(), next);
        };
    }
    after() {
        return null;
    }
    /** The root AuthzService, booted once; `authz()` works in actions after it. */
    rootService() {
        // DI.resolve answers the cached instance itself, not a promise, once the app resolved AuthzService first.
        this.authz ??= (async () => (await DI.resolve(AuthzService)))().catch((err) => {
            this.authz = undefined;
            throw err;
        });
        return this.authz;
    }
    async attach(req) {
        const authz = await this.rootService();
        const principal = await this.authenticate(req);
        if (principal) {
            req.storage.Principal = principal;
            // In the request's store, so what models keep per request at preload reaches the checks.
            await authzStorage().run(req.storage, () => authz.preload(principal));
        }
    }
    /**
     * First non-null of the plain sources; then a link source may replace it, with it as the link's
     * companion (left in req.storage.Principal for the link source to read).
     */
    async authenticate(req) {
        const sources = this.Sources;
        let principal = null;
        for (const source of sources.filter((s) => !(s instanceof LinkPrincipalSource))) {
            principal = await this.ask(source, req);
            if (principal)
                break;
        }
        if (principal)
            req.storage.Principal = principal;
        for (const source of sources.filter((s) => s instanceof LinkPrincipalSource)) {
            const link = await this.ask(source, req);
            if (link) {
                principal = link;
                break;
            }
        }
        return principal ?? (this.AnonymousEnabled !== false ? ANONYMOUS : null);
    }
    async ask(source, req) {
        const principal = await source.authenticate(req);
        // SYSTEM and UNATTENDED come only from runAs, @Job and @Unscoped (design §14.1).
        if (principal && (principal.type === 'system' || principal.type === 'unattended')) {
            throw new AuthzConfigError(`principal source ${source.name} returned a ${principal.type} principal`);
        }
        return principal;
    }
};
__decorate([
    Logger('authz-http'),
    __metadata("design:type", Log)
], PrincipalMiddleware.prototype, "Log", void 0);
__decorate([
    Config('authz.principals.anonymous.enabled', { defaultValue: AUTHZ_DEFAULTS.principals.anonymous.enabled }),
    __metadata("design:type", Boolean)
], PrincipalMiddleware.prototype, "AnonymousEnabled", void 0);
__decorate([
    Autoinject(PrincipalSource),
    __metadata("design:type", Array)
], PrincipalMiddleware.prototype, "Sources", void 0);
PrincipalMiddleware = __decorate([
    Injectable(ServerMiddleware),
    __metadata("design:paramtypes", [])
], PrincipalMiddleware);
export { PrincipalMiddleware };
//# sourceMappingURL=middleware.js.map