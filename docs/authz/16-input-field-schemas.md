# Input field schemas

`@spinajs/authz` holds the JSON-schema fields the authz packages validate their input against: request DTOs embed them, and the principal sources, the admin core and the stores check the same fields again.

## How it works

- The package root exports the field fragments, `bodyOf`, `fieldSchema`, `AUTHZ_FIELD_SCHEMAS`, `isValidField` and `PERMISSION_MAX_LENGTH`.
- A fragment has no `$id`, so it can appear several times in one schema. `bodyOf(required, properties, id)` builds a closed object schema (`additionalProperties: false`) and `fieldSchema(id, field)` a schema of one field; both need an `$id` starting with `authz.`, which `@spinajs/validation` validates without type coercion.
- `AUTHZ_FIELD_SCHEMAS` holds one standalone schema per fragment (`authz.field.linkToken`, `authz.field.serviceToken`, ...), for `DataValidator.tryValidate`.
- `isValidField(schema, value)` checks one value with a module-local ajv: no coercion, no defaults, no container.

## Fields

| Fragment | Shape |
| --- | --- |
| `idField` | string, 1 to 160 (the longest id column) |
| `typeField` | string, 1 to 64 |
| `nameField`, `fieldNameField` | string, 1 to 128 |
| `permissionField` | a permission name (`PERMISSION_PATTERN`), at most `PERMISSION_MAX_LENGTH` (256) |
| `reasonField` | string, at most 512 |
| `idempotencyKeyField` | string, 1 to 128 |
| `linkTokenField` | string, 1 to 512 |
| `serviceTokenField` | string, 1 to 1024 |
| `changeTagField`, `changeTagsField` | a string of at most 256; at most 1000 of them |
| `resourceRefField` | `{ type, id? }` |
| `principalRefField` | `{ type, id }` |
| `pageField` | `{ limit (0..500), offset (>= 0), after (1..512) }` |
| `writeOptionsField` | `{ reason, idempotencyKey, dryRun }` |

## Checks on the way in

| Where | Check | Answer |
| --- | --- | --- |
| `LinkPrincipalSource` | `linkTokenField` | the denying link principal (`link_invalid`), without asking the `LinkResolver` |
| `ServicePrincipalSource` | `serviceTokenField` | no service principal; `authz.http.services` tokens take the same cap at boot |
| `AuthzAdmin.execute` options | `reasonField`, `idempotencyKeyField` | `AuthzAdminFailure('invalid_batch')` naming the field |
| `readId` | `idField` | `AuthzAdminFailure('invalid_command')` naming the field |
| `isPermission` | `PERMISSION_MAX_LENGTH` | `false`; `parsePermission` throws `AuthzConfigError` |
| `DbAssignmentStore` | role 128, scope type and id 64, stored tags 512 | `AuthzAdminFailure('invalid_command')` or `('invalid_tags')` |
| `DbTupleStore.write` | the namespaces of every `RebacModel` over the store | `AuthzConfigError` with the problem code |
| `QueueChangeBus` | `changeTagsField` | a received change past the caps is dropped; one published past them goes out as `['*']` |

## Related

- [Authentication field schemas](../authn/15-input-field-schemas.md)
- [AuthzAdmin](10-authz-admin.md)
