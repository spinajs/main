var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { DI, Injectable } from '@spinajs/di';
import { LinkResolver } from '@spinajs/authz';
import { Log, Logger } from '@spinajs/log';
import { Config } from '@spinajs/configuration';
import { PrincipalSource } from '../api.js';
import '../storage.js';
export { LinkResolver };
/** The link principal when no LinkResolver is registered: it denies every check. */
export function deadLinkPrincipal(companion) {
    return Object.freeze({
        type: 'link',
        id: 'unresolved',
        authenticated: true,
        source: 'link',
        ...(companion ? { companions: Object.freeze([{ type: companion.type, id: companion.id }]) } : {}),
        ceiling: Object.freeze({ resources: Object.freeze([]), reason: 'link_invalid' }),
        attributes: Object.freeze({}),
    });
}
/**
 * A link token in the request (`authz.http.links`: query parameter, header or cookie, each
 * optional) replaces the principal the earlier sources found, which becomes its companion
 * (order 110, design §11.1, B38). PrincipalMiddleware runs it after the first-non-null sources.
 */
let LinkPrincipalSource = class LinkPrincipalSource extends PrincipalSource {
    constructor() {
        super(...arguments);
        this.name = 'link';
        this.order = 110;
        // Warned once: any request can carry a token, so a warning per request would let anyone flood the log.
        this.warned = false;
    }
    async authenticate(req) {
        const token = this.token(req);
        if (token === undefined) {
            return null;
        }
        const companion = req.storage?.Principal;
        // Per call: registerRbac binds the resolver at the root domain's boot, after this source is built.
        const resolver = (await DI.RootContainer.resolveOptional(LinkResolver));
        if (!resolver) {
            if (!this.warned)
                this.Log.warn('a request carries a share link token, but no LinkResolver is registered; links deny everything');
            this.warned = true;
            return deadLinkPrincipal(companion);
        }
        return resolver.principal(token, companion);
    }
    token(req) {
        // A links section the schema never saw (an app whose Configuration did not validate authz.http) yields no link principal.
        if (typeof this.Links !== 'object' || this.Links === null)
            return undefined;
        const { query, header, cookie } = this.Links;
        const pick = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);
        return ((query !== null ? pick(req.query?.[query]) : undefined) ??
            (header !== null ? pick(req.headers?.[header.toLowerCase()]) : undefined) ??
            (cookie !== null ? pick(req.signedCookies?.[cookie] ?? req.cookies?.[cookie]) : undefined));
    }
};
__decorate([
    Logger('authz-http'),
    __metadata("design:type", Log)
], LinkPrincipalSource.prototype, "Log", void 0);
__decorate([
    Config('authz.http.links'),
    __metadata("design:type", Object)
], LinkPrincipalSource.prototype, "Links", void 0);
LinkPrincipalSource = __decorate([
    Injectable(PrincipalSource)
], LinkPrincipalSource);
export { LinkPrincipalSource };
//# sourceMappingURL=link-source.js.map