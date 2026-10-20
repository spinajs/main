# Rules, policies and scope attributes

Routes that store RBAC rules and ABAC policies as rows, and edit the attributes of a scope node, each through one `AuthzAdmin` command. Rules and policies kept in config are not touched; these routes manage the rows only.

## How it works

| Route | Command | Body | Query |
| --- | --- | --- | --- |
| `GET /authz/rules` | `list({ kind: 'rules' })` | none | `scope`, `limit`, `offset` |
| `PUT /authz/rules/:id` | `rule.put` | a rule (`AuthzRuleBody`) | `reason`, `idempotencyKey`, `dryRun` |
| `DELETE /authz/rules/:id` | `rule.delete` | none | `reason`, `idempotencyKey`, `dryRun` |
| `GET /authz/policies` | `list({ kind: 'policies' })` | none | `scope`, `limit`, `offset` |
| `PUT /authz/policies/:id` | `policy.put` | a policy (`AuthzPolicyBody`) | `reason`, `idempotencyKey`, `dryRun` |
| `DELETE /authz/policies/:id` | `policy.delete` | none | `reason`, `idempotencyKey`, `dryRun` |
| `GET /authz/scopes/:type/:id/attributes` | `list({ kind: 'attributes', scope })` | none | none |
| `PATCH /authz/scopes/:type/:id/attributes` | `scope.setAttributes` | a patch object (`AuthzAttributesPatch`) | `reason`, `idempotencyKey`, `dryRun` |
| `PUT /authz/scopes/:type/:id/attributes` | `scope.replaceAttributes` | the attributes object (`AuthzAttributesBody`) | `reason`, `idempotencyKey`, `dryRun` |

Put a rule or a policy:

1. `putRule()` or `putPolicy()` takes the body object (else `400 invalid_request`) and sets its `id` to the path id. An `id` in the body that differs answers `400 invalid_request`, `field: 'id'`.
2. `decodeCommand` turns `rule.expiresAt` or `policy.expiresAt` from an ISO 8601 string into a `Date`.
3. The route runs `{ kind: 'rule.put', rule }` or `{ kind: 'policy.put', policy }`: insert, or replace by id. The server sets `source`.
4. `AuthzAdmin` validates the row (`rule_not_compilable`, `not_list_filterable`, ...), checks `authz:rules.manage` at the rule's `scope` or `authz:policies.manage` at the policy's `scope` (`$global` without one), and applies it.

Scope attributes:

1. The path `:type/:id` is the scope node.
2. `PATCH` deep-merges the body into the node's attributes; `null` at a path deletes it. `PUT` replaces all attributes with the body.
3. `AuthzAdmin` checks `authz:scope.manage` at the node and validates the result against the attribute schema of the scope type (`400 invalid_attributes`).
4. `GET` checks `authz:attributes.read` at the node and answers `{ items: [attributes], total: 1 }`.

## Request bodies

A rule (`AuthzRuleBody`; required `kind` and `scope`):

| Key | Type | Meaning |
| --- | --- | --- |
| `kind` | `'restrict' \| 'cap' \| 'threshold'` | The rule kind (not the command kind). |
| `scope` | `{ type, id? }` | Where the rule applies. |
| `expiresAt` | ISO 8601 string or `null` | When the rule stops applying. |
| `resourceTypes`, `subjects`, `when`, `allow`, `ladder`, `maxRole`, `stripTags`, `assignments`, `permissions`, `resource`, `minRole`, `at`, `reason` | | The fields of the rule kinds, as `RuleDef` in `@spinajs/authz` declares them. |

A policy (`AuthzPolicyBody`; required `effect` and `permissions`):

| Key | Type | Meaning |
| --- | --- | --- |
| `effect` | `'permit' \| 'deny'` | What the policy decides. |
| `permissions` | `string[]` | Permission globs. |
| `resourceTypes`, `principalTypes`, `actorTypes` | `string[]` | Whom and what it covers. |
| `scope` | `{ type, id? }` | Where it applies; `$global` when absent. |
| `when`, `fields`, `reason`, `priority`, `expiresAt` | | A condition, a field set, the deny reason, the priority (default `500`), an expiry. |

What each field means is part of the models: see [the RBAC model](../authz-rbac/README.md) and [the ABAC model](../authz-abac/README.md).

## Important behaviour

- **A rule id is bound to its scope.** Putting an existing rule id at another scope answers `409 conflict`.
- **Policies need `@spinajs/authz-abac`.** It registers the policy handler and reader; without it the policy routes answer `404 not_found`.
- **Rules need `@spinajs/authz-rbac`**, which registers the rule handler and the reader of rules, assignments and links.
- **A bad date reaches `AuthzAdmin` as a string.** `expiresAt: 'soon'` is not decoded and is refused as `400 invalid_command` with the field `rule.expiresAt` or `policy.expiresAt`.
- **`scope.forget`** (remove everything held at a node) has no route; send it through [`POST /authz/commands`](02-command-batches.md).

## Examples

### Turn off public links for one organisation

```ts sample
export async function disablePublicLinks(baseUrl: string, bearer: string, orgId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/authz/scopes/org/${encodeURIComponent(orgId)}/attributes?reason=${encodeURIComponent('security review')}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policies: { public_links: false } }),
  });
  if (res.status !== 200) throw new Error(`attributes refused: ${res.status}`);
}
```

### Require the editor role for edits on a project

```ts sample
export async function requireEditorForEdits(baseUrl: string, bearer: string, projectId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/authz/rules/${encodeURIComponent(`edit-threshold-${projectId}`)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'threshold', scope: { type: 'project', id: projectId }, permissions: ['file:edit'], minRole: 'editor' }),
  });
  if (res.status !== 200) throw new Error(`rule refused: ${res.status}`);
}
```

## Related

- [Admin routes](01-admin-routes.md): encodings, answers and status codes.
- [AuthzAdmin](../authz/10-authz-admin.md): `rule.put`, `policy.put` and the list-permission validator.
- [`@spinajs/authz-abac`](../authz-abac/README.md): the policy model.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the rule handler and store.
