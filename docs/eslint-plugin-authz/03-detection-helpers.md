# Detection helpers

The package exports the pieces `require-accessible` is built from. Use them to write a lint rule of your own about `@AccessResource` models, such as "no `.unscoped()` in controllers", without re-implementing model detection.

## How it works

1. Your rule gets the TypeScript program from `ESLintUtils.getParserServices(context)` (`@typescript-eslint/utils`) and its type checker.
2. It maps an ESTree node to its TypeScript node with `services.esTreeNodeToTSNodeMap.get(node)` and takes the symbol of its type.
3. `isAccessResourceClass(symbol, checker, extra, cache)` answers whether that symbol is an access-resource class.
4. `primaryKeyOf(symbol, checker)` returns the name of its `@Primary()` property, when one is visible.

## Exports

| Export | Kind | Meaning |
| --- | --- | --- |
| `isAccessResourceClass(symbol, checker, extra, cache)` | function | `true` when `symbol` (after alias resolution) is a class decorated `@AccessResource`, extends one, or its name is in `extra`. `undefined` gives `false`. |
| `primaryKeyOf(symbol, checker, seen?)` | function | The property decorated `@Primary()` on the class or a class it extends; `undefined` when none is visible, as for a `.d.ts` base. |
| `QUERY_ROOTS` | `ReadonlySet<string>` | Static members that start a select builder: `where`, `query`, `select`, `all`, `whereExists`, `whereNotExists`, `populate`. |
| `PRIMARY_KEY_READS` | `ReadonlySet<string>` | Static reads of one primary-key value: `get`, `getOrFail`. |
| `KEY_LIST_READS` | `ReadonlySet<string>` | Static reads of a primary-key list: `find`, `findOrFail`. |
| `READ_SHORTCUTS` | `ReadonlySet<string>` | Other static reads that return a promise at once: `getOrNew`, `getOrCreate`, `first`, `last`, `newest`, `oldest`, `count`, `exists`. |
| `EXECUTING_MEMBERS` | `ReadonlySet<string>` | Builder members that run the query: `first`, `firstOrFail`, `firstOrThrow`, `orThrow`, `all`, `execute`, `asRaw`, `resultExists`, `selectCount`, `then`. |
| `SCOPING_MEMBERS` | `ReadonlySet<string>` | `accessible`, `unscoped`. |
| `requireAccessible` | rule module | The `require-accessible` rule, built with `ESLintUtils.RuleCreator`. |
| `RequireAccessibleOptions` | interface | `{ resources?: readonly string[] }`. |
| `RequireAccessibleMessageIds` | type | `'unscopedQuery' \| 'unscopedShortcut'`. |
| `rules`, `configs` | objects | What ESLint reads ([ESLint setup](01-eslint-setup.md#exports-eslint-reads)). |

## Important behaviour

- **Create one `cache` per `create()` call**, as `require-accessible` does. `isAccessResourceClass()` stores every answer in the `Map<ts.Symbol, boolean>` you pass, and writes a provisional `false` first, so an inheritance cycle in a broken program ends.
- **`extra` matches by class name.** It is how `require-accessible` applies its `resources` option; pass the same names in your rule.
- **The decorator is matched by name.** The helper resolves import aliases and reads `@AccessResource` and `@ns.AccessResource`, but does not check the module the decorator comes from.
- **`.d.ts` classes have no decorators.** Both helpers see only declarations with source; a compiled model counts only through `extra`, and has no visible primary key.

## Examples

### Forbid `.unscoped()` on access resources in controllers

```ts
// lint-rules/no-unscoped.ts
import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import type ts from 'typescript';
import { QUERY_ROOTS, isAccessResourceClass } from '@spinajs/eslint-plugin-authz';

const createRule = ESLintUtils.RuleCreator((name) => `https://lint.example.com/rules/${name}`);

const nameOf = (callee: TSESTree.Node): string | undefined =>
  callee.type === AST_NODE_TYPES.MemberExpression && !callee.computed && callee.property.type === AST_NODE_TYPES.Identifier ? callee.property.name : undefined;

export const noUnscoped = createRule({
  name: 'no-unscoped',
  meta: {
    type: 'problem',
    docs: { description: 'Forbid .unscoped() on @AccessResource queries', recommended: 'error', requiresTypeChecking: true },
    messages: { unscoped: '{{model}}: .unscoped() is not allowed here; use .accessible(permission).' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const cache = new Map<ts.Symbol, boolean>();

    return {
      CallExpression(node): void {
        if (nameOf(node.callee) !== 'unscoped' || node.callee.type !== AST_NODE_TYPES.MemberExpression) return;

        // walk down Task.where(...).populate(...).unscoped(...) to Task.where(...)
        let root: TSESTree.Node = node.callee.object;
        while (root.type === AST_NODE_TYPES.CallExpression && root.callee.type === AST_NODE_TYPES.MemberExpression && root.callee.object.type === AST_NODE_TYPES.CallExpression) {
          root = root.callee.object;
        }
        if (root.type !== AST_NODE_TYPES.CallExpression || root.callee.type !== AST_NODE_TYPES.MemberExpression) return;
        const member = nameOf(root.callee);
        if (member === undefined || !QUERY_ROOTS.has(member)) return;

        const model = root.callee.object;
        const symbol = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(model)).getSymbol();
        if (!isAccessResourceClass(symbol, checker, new Set(), cache)) return;

        context.report({ node, messageId: 'unscoped', data: { model: context.getSourceCode().getText(model) } });
      },
    };
  },
});
```

Ship the rule in a plugin of your own and turn it on for controller files only, next to `@spinajs/authz/require-accessible`:

```js
// .eslintrc.cjs
module.exports = {
  extends: ['plugin:@spinajs/authz/recommended'],
  overrides: [{ files: ['src/controllers/**/*.ts'], rules: { '@acme/no-unscoped': 'error' } }],
};
```

## Related

- [The `require-accessible` rule](02-require-accessible.md): the rule these helpers drive.
- [`@spinajs/authz-orm`](../authz-orm/README.md): `@AccessResource` and `.unscoped()`.
