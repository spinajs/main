var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
const nonEmpty = { type: 'string', minLength: 1 };
// One type list, not an anyOf with a null branch: coerceTypes would turn '' into null there and accept it.
const nullableName = { type: ['string', 'null'], minLength: 1 };
export const AUTHZ_HTTP_CONFIGURATION_SCHEMA = {
    $id: 'spinajs/authz-http.configuration.schema.json',
    $configurationModule: 'authz.http',
    description: 'HTTP authorization configuration (authz.http.*)',
    type: 'object',
    properties: {
        services: {
            type: 'array',
            default: [],
            items: {
                type: 'object',
                required: ['name', 'header', 'token'],
                properties: {
                    name: nonEmpty,
                    header: nonEmpty,
                    token: { anyOf: [nonEmpty, { type: 'array', minItems: 1, items: nonEmpty }] },
                    attributes: { type: 'object' },
                },
            },
        },
        explainRoute: {
            type: 'object',
            default: {},
            properties: { enabled: { type: 'boolean', default: false }, permission: { ...nonEmpty, default: 'authz:explain' } },
        },
        links: {
            type: 'object',
            default: {},
            properties: { query: { ...nullableName, default: 'link' }, header: { ...nullableName, default: 'X-Authz-Link' }, cookie: { ...nullableName, default: null } },
        },
        access: { type: 'object', default: {}, properties: { domain: { ...nonEmpty, default: 'root' } } },
        admin: { type: 'object', default: {}, properties: { domain: { ...nonEmpty, default: 'root' } } },
        events: { type: 'object', default: {}, properties: { maxStreamsPerPrincipal: { type: 'integer', minimum: 1, default: 5 } } },
    },
};
registerConfigurationSchemaAtImport(AUTHZ_HTTP_CONFIGURATION_SCHEMA);
let AuthzHttpConfigBootstrapper = class AuthzHttpConfigBootstrapper extends Bootstrapper {
    bootstrap() {
        registerConfigurationSchema(AUTHZ_HTTP_CONFIGURATION_SCHEMA);
    }
};
AuthzHttpConfigBootstrapper = __decorate([
    Injectable(Bootstrapper)
], AuthzHttpConfigBootstrapper);
export { AuthzHttpConfigBootstrapper };
/** The configured services as ServicePrincipalSource matches them. */
export function servicePrincipals(services) {
    // The schema requires a name; a nameless entry from an unvalidated configuration must not authenticate.
    return services.filter((s) => typeof s.name === 'string' && s.name !== '').map((s) => ({
        name: s.name,
        header: s.header.toLowerCase(),
        tokens: typeof s.token === 'string' ? [s.token] : s.token,
        attributes: Object.freeze({ ...(s.attributes ?? {}) }),
    }));
}
//# sourceMappingURL=http-config.js.map