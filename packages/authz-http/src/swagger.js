import { parsePermission } from '@spinajs/authz';
import { routeAccess } from './access/descriptor.js';
import { extractorInfo } from './access/extractors.js';
const IN = { param: 'path', body: 'body', query: 'query' };
function resourceOf(rule) {
    const info = extractorInfo(rule.options.resource);
    if (!rule.options.resource)
        return { type: parsePermission(rule.permissions[0]).resource };
    if (!info)
        return {};
    if (info.from === 'model')
        return { in: 'path', name: info.name, model: info.model?.name };
    return { ...(info.type !== undefined ? { type: info.type } : {}), ...(info.from ? { in: IN[info.from] } : {}), ...(info.name !== undefined ? { name: info.name } : {}), ...(info.by !== undefined ? { by: info.by } : {}) };
}
/**
 * What `@Access`, `@AllowAnonymous` and `@Unscoped` declare for one route, as OpenAPI vendor
 * extensions read from `ACCESS_DESCRIPTOR`; undefined for a route no `@Access` guards. For
 * http-swagger (plan C7).
 */
export function swaggerAccess(controller, method) {
    const access = routeAccess(controller, method);
    const rule = access.route ?? access.controller;
    if (!rule)
        return undefined;
    const domain = rule.options.domain;
    return {
        'x-authz-permission': [...rule.permissions],
        ...(access.route && access.controller ? { 'x-authz-controller-permission': [...access.controller.permissions] } : {}),
        'x-authz-resource': resourceOf(rule),
        ...(domain !== undefined && domain !== 'root' ? { 'x-authz-domain': domain } : {}),
        ...(access.anonymous ? { 'x-authz-anonymous': true } : {}),
        ...(access.unscoped !== undefined ? { 'x-authz-unscoped': access.unscoped } : {}),
        ...(access.unfilteredInput !== undefined ? { 'x-authz-unfiltered-input': access.unfilteredInput } : {}),
    };
}
//# sourceMappingURL=swagger.js.map