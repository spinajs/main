var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthzConfigError, AuthzDomains, DefaultAuthzDomains, authzStorage, compileFieldGlobs, filterObject, subtractFieldGlobs } from '@spinajs/authz';
import { BadRequest } from '@spinajs/exceptions';
import { isPlainObject } from '@spinajs/util';
import { ArgInputFilter, DataTransformer, RouteMiddleware } from '@spinajs/http';
import { routeAccess, routeDomain } from './access/descriptor.js';
import { domainConfig } from './domains.js';
const PRIMITIVES = new Set(['String', 'Number', 'BigInt', 'Boolean']);
/** Route args that carry what the caller writes; query, url, header and cookie args are not writes. */
export const BODY_ARGS = new Set(['FromBody', 'BodyFieldRouteArgs', 'FromForm', 'FromFormField', 'FromCSV', 'FromJSONFile', 'FromXmlRouteArgs', 'AsDbModel']);
/**
 * The decision's field sets without the domain's `fields.neverRead`, and the domain's write mode
 * (design §11.3, B17). Without a decision (a route another policy group admitted) only
 * `neverRead` applies, in the route's domain. `authz` is the `authz` section its caller reads through @Config.
 */
export function decisionFields(authz, domains, decision, domain = decision?.domain ?? 'root') {
    // Only the host's AuthzDomains tells a domain's config lineage, and its fields.neverRead must not be skipped.
    if (!(domains instanceof DefaultAuthzDomains))
        throw new AuthzConfigError('field filtering needs the host AuthzDomains to read the domain fields config');
    const { neverRead, writeMode } = domainConfig(authz, domains, domain).fields;
    const without = (globs) => (neverRead.length === 0 ? globs : subtractFieldGlobs(globs, neverRead));
    return { read: without(decision?.fields.read ?? ['*']), write: without(decision?.fields.write ?? ['*']), writeMode };
}
const isObject = (v) => v !== null && typeof v === 'object';
/** Dotted leaf paths present in `before` (JSON-shaped) and missing from `after`; array elements share their array's path. */
function removedPaths(before, after, prefix = '') {
    const out = [];
    for (const key of Object.keys(before)) {
        const value = before[key];
        const path = Array.isArray(before) ? prefix : prefix === '' ? key : `${prefix}.${key}`;
        const kept = isObject(after) && Object.hasOwn(after, key) ? after[key] : undefined;
        if (isObject(value) && Object.keys(value).length > 0)
            out.push(...removedPaths(value, kept, path));
        else if (kept === undefined)
            out.push(path);
    }
    return [...new Set(out)];
}
function notWritable(fields) {
    return Object.assign(new BadRequest(`fields not writable: ${fields.join(', ')}`), { error: 'fields_not_writable', fields });
}
/**
 * Strips, or in `reject` mode refuses with 400, the body input the route's decision does not let
 * the caller write (`decision.fields.write` minus `fields.neverRead`, design §11.3, B17). A named
 * primitive body field is checked by its name. A route another policy group admitted (no decision)
 * still loses `neverRead`; a route without `@Access`, or with `@UnfilteredInput`, is not filtered.
 */
let AuthzInputFieldFilter = class AuthzInputFieldFilter extends ArgInputFilter {
    filter(input, parameter) {
        if (!BODY_ARGS.has(String(parameter.Type)))
            return input;
        const store = authzStorage().getStore();
        const mark = store?.AuthzHttpRoute;
        const decision = store?.AuthzDecision;
        // Untouched: a route without @Access (login and password routes carry passwords), or one that opted out.
        if ((!mark && !decision) || mark?.unfilteredInput !== undefined)
            return input;
        const { write, writeMode } = decisionFields(this.Authz, this.Domains, decision, decision?.domain ?? mark?.domain);
        // A list holding anything but records is a field of the record, checked by the parameter name (a client
        // must not turn ['admin'] into a record list by adding {}). Objects and lists of records are records.
        const field = !isObject(input) || PRIMITIVES.has(parameter.RuntimeType?.name ?? '') || (Array.isArray(input) && (input.length === 0 || input.some((v) => !isPlainObject(v))));
        if (field) {
            if (compileFieldGlobs(write).allows(parameter.Name))
                return input;
            if (writeMode === 'reject')
                throw notWritable([parameter.Name]);
            return undefined;
        }
        const filtered = filterObject(write, input);
        const removed = removedPaths(JSON.parse(JSON.stringify(input)), filtered);
        if (removed.length === 0)
            return input;
        if (writeMode === 'reject')
            throw notWritable(removed);
        return filtered;
    }
};
__decorate([
    Config('authz'),
    __metadata("design:type", Object)
], AuthzInputFieldFilter.prototype, "Authz", void 0);
__decorate([
    Autoinject(AuthzDomains),
    __metadata("design:type", AuthzDomains)
], AuthzInputFieldFilter.prototype, "Domains", void 0);
AuthzInputFieldFilter = __decorate([
    Injectable(ArgInputFilter)
], AuthzInputFieldFilter);
export { AuthzInputFieldFilter };
function readable(authz, domains, data, decision, domain) {
    if ((!decision && domain === undefined) || !isObject(data))
        return data;
    return filterObject(decisionFields(authz, domains, decision, decision?.domain ?? domain).read, data);
}
/** `x-data-transform: authz-fields`: the response data limited to what the route's decision lets the caller read. */
let AuthzFieldTransformer = class AuthzFieldTransformer extends DataTransformer {
    get Type() {
        return 'authz-fields';
    }
    transform(data, request) {
        const storage = request.storage;
        return readable(this.Authz, this.Domains, data, storage?.AuthzDecision, storage?.AuthzHttpRoute?.domain);
    }
};
__decorate([
    Config('authz'),
    __metadata("design:type", Object)
], AuthzFieldTransformer.prototype, "Authz", void 0);
__decorate([
    Autoinject(AuthzDomains),
    __metadata("design:type", AuthzDomains)
], AuthzFieldTransformer.prototype, "Domains", void 0);
AuthzFieldTransformer = __decorate([
    Injectable(DataTransformer)
], AuthzFieldTransformer);
export { AuthzFieldTransformer };
/** Added by `@Access(…, { fields: 'filter' })`: the response data limited to `decision.fields.read` (B17). */
let AuthzFieldsMiddleware = class AuthzFieldsMiddleware extends RouteMiddleware {
    isEnabled(route, controller) {
        const access = routeAccess(controller, route.Method);
        return (access.route ?? access.controller)?.options.fields === 'filter';
    }
    async onBefore() { }
    // http calls this without awaiting it, so the data is replaced before the first await.
    async onResponse(response, route, controller) {
        const decision = authzStorage().getStore()?.AuthzDecision;
        const domain = routeDomain(routeAccess(controller, route.Method));
        const authz = this.Authz;
        const domains = this.Domains;
        const holder = response;
        const data = holder.responseData;
        holder.responseData = Promise.all(Array.isArray(data) ? data : [data]).then((resolved) => readable(authz, domains, Array.isArray(data) ? resolved : resolved[0], decision, domain));
    }
    async onAfter() { }
};
__decorate([
    Config('authz'),
    __metadata("design:type", Object)
], AuthzFieldsMiddleware.prototype, "Authz", void 0);
__decorate([
    Autoinject(AuthzDomains),
    __metadata("design:type", AuthzDomains)
], AuthzFieldsMiddleware.prototype, "Domains", void 0);
AuthzFieldsMiddleware = __decorate([
    NewInstance()
], AuthzFieldsMiddleware);
export { AuthzFieldsMiddleware };
//# sourceMappingURL=fields.js.map