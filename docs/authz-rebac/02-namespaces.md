# Namespaces

A namespace describes one resource type: its **relations**, which hold tuples, and its **permissions**, which are rewrites computed from relations. It is Keto's OPL written as JSON under `authz.rebac.namespaces` (or the `namespaces` option of `RebacModel`).

## How it works

### Shape

```ts
authz: {
  rebac: {
    store: 'DbTupleStore',                       // or 'MemoryTupleStore'
    limit: { maxDepth: 8, maxCalls: 10000 },
    permissions: { 'doc:read': 'doc#read', 'doc:edit': 'doc#edit', 'doc:view': 'doc#view' },
    namespaces: {
      group: { relations: { member: ['user', 'group#member'] } },
      folder: {
        relations: { parent: ['folder'], viewer: ['user', 'group#member'] },
        permissions: { view: { union: ['viewer', 'parent->view'] } },
      },
      doc: {
        relations: { parent: ['folder'], owner: ['user'], viewer: ['user', 'group#member'], editor: ['user'], approved: ['user'], banned: ['user'] },
        permissions: {
          read: { union: ['owner', 'viewer', 'parent->view'] },
          edit: { intersection: ['editor', 'approved'] },
          view: { exclusion: { base: 'read', subtract: 'banned' } },
        },
      },
    },
  },
}
```

- `relations`: relation to its allowed subject types. `'user'` admits a principal (or an object) of that type; `'group#member'` admits the subject set `group:<id>#member`; `'folder'` (a namespace) admits an object as subject, which is what a tuple-to-userset follows.
- `permissions`: permission to its rewrite.
- `permissions` at the top: a SpinaJS permission to `<namespace>#<relation or permission>`. Only mapped permissions route to the model.

### Rewrites

| JSON | Short form | Keto OPL | Meaning |
| --- | --- | --- | --- |
| `{ "computed": "viewer" }` | `'viewer'` | `this.permits.viewer(ctx)` | the relation or permission `viewer` of the same object |
| `{ "tupleToUserset": { "tupleset": "parent", "computed": "view" } }` | `'parent->view'` | `this.related.parent.traverse((p) => p.permits.view(ctx))` | `view` on every object the `parent` tuples name |
| `{ "union": [...] }` | | `a \|\| b` | any branch |
| `{ "intersection": [...] }` | | `a && b` | every branch |
| `{ "exclusion": { "base": a, "subtract": b } }` | | `a && !b` | the base without the subtracted subjects |

A relation's own tuples ("this" in Zanzibar) are not a node: naming the relation reads them, subject sets included.

### Boot checks

`init` fails with `AuthzConfigError` when:

- a namespace, relation or permission name does not match `[A-Za-z_][A-Za-z0-9_.-]*`, or a namespace has keys other than `relations` and `permissions`;
- a name is both a relation and a permission;
- a subject type `X#r` names no namespace `X`, or `X` has no `r`;
- a computed name is not a relation or permission of the namespace;
- a tupleset is not a relation, admits no namespace type, or one of those types lacks the computed name;
- computed usersets form a cycle (`a -> b -> a`): it would never reach a tuple;
- a union or intersection is empty, or a value is not a rewrite;
- a permission maps to no target, or not in the form `<namespace>#<name>`.

The JSON schema `AUTHZ_REBAC_CONFIGURATION_SCHEMA` (`authz.rebac`) checks the shape of the config section; the compiler checks the rest, also for options passed in code.

### Tuples that fit

`NamespaceSchema.problem(tuple)` tells why a tuple does not fit: `unknown_relation` (no namespace, no such relation, or a permission) or `subject_not_allowed` (a subject type or subject set the relation does not list). The `tuple.write` command refuses such tuples.

## See also

- [The ReBAC model](01-rebac-model.md)
- [Lists](04-lists.md): which rewrites a list plan can express
