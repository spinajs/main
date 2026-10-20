# Descriptor inheritance

`getInheritedDescriptor` gives each class its own copy of a metadata descriptor, pre-filled with everything inherited from its base classes. Use it when you write decorators that store per-class data (routes, columns, tags) and subclasses must inherit that data without writing into their parent's copy. `@spinajs/http`, `@spinajs/orm`, `@spinajs/orm-http` and `@spinajs/http-socket` store their decorator data this way.

## How it works

`getInheritedDescriptor(target, symbol, createDefault)`:

1. Returns the descriptor `target` **owns** under `symbol` (`Reflect.getOwnMetadata`), when there is one.
2. Otherwise calls `collapseInheritedDescriptor(target, symbol, createDefault)`:
   1. walks the prototype chain from `target` up and takes the **nearest** object that owns a descriptor under `symbol`;
   2. merges it onto a fresh `createDefault()` with the rules below.
3. Stores the result as `target`'s own metadata and returns it. Later calls return the same object, which your decorators mutate.

Only the nearest ancestor is merged: every stored descriptor is already collapsed, so it carries all of its own ancestors' data. `target` can be a constructor or a prototype; both chains are followed by `Object.getPrototypeOf`, and descriptors are matched by identity, never by class name.

### Merge rules

| Value in the default / ancestor | Result |
| --- | --- |
| Either is an array | A new array: default's elements, then the ancestor's |
| Default is a `Map` | A new `Map`: default's entries, then the ancestor's (the ancestor wins a key) |
| Ancestor's value is `null`, `undefined` or empty and the default's is not empty | The default's value |
| Anything else | The ancestor's value, by reference |

Arrays and maps are rebuilt one level deep: their **elements** are still the ancestor's objects. Plain nested objects are shared outright.

## API

| Function | Returns | Side effect |
| --- | --- | --- |
| `getInheritedDescriptor<T>(target, symbol, createDefault)` | The descriptor `target` owns | Stores it on first call |
| `collapseInheritedDescriptor<T>(target, symbol, createDefault)` | A fresh collapsed copy | None |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Your decorator metadata | Your `symbol` on each class, via `reflect-metadata` | none | none | Call `getInheritedDescriptor(target, MY_SYMBOL, createDefault)` in each decorator, then mutate the returned descriptor |

### A decorator whose data subclasses inherit

```ts sample
import { getInheritedDescriptor } from '@spinajs/di';

const AUDIT = Symbol('audit');

type AuditDescriptor = {
  Category: string;
  Fields: string[];
};

const createDefault = (): AuditDescriptor => ({ Category: '', Fields: [] });

function AuditCategory(category: string) {
  return (target: object) => {
    getInheritedDescriptor<AuditDescriptor>(target, AUDIT, createDefault).Category = category;
  };
}

function Audited() {
  return (prototype: object, property: string) => {
    // Property decorators get the prototype; store on the constructor.
    getInheritedDescriptor<AuditDescriptor>(prototype.constructor, AUDIT, createDefault).Fields.push(property);
  };
}

@AuditCategory('billing')
class Invoice {
  @Audited()
  public Total: number;
}

class CorrectionInvoice extends Invoice {
  @Audited()
  public Reason: string;
}

console.log(getInheritedDescriptor<AuditDescriptor>(Invoice, AUDIT, createDefault));
console.log(getInheritedDescriptor<AuditDescriptor>(CorrectionInvoice, AUDIT, createDefault));
// { Category: 'billing', Fields: [ 'Total' ] }
// { Category: 'billing', Fields: [ 'Total', 'Reason' ] }
```

## Important behaviour

- The first call on a class stores its descriptor. Data an ancestor gains **after** that is not seen by the subclass. Decorators of a base class run before the subclass is defined, so this only bites code that mutates descriptors later at runtime.
- Mutating an element of an inherited array or `Map` in place (`descriptor.Routes.get('x').Path = '/y'`) changes the ancestor's element too. Replace elements (`map.set(key, { ...old, Path: '/y' })`) or copy them right after the first call.
- A nested plain object is shared with the ancestor. Prefer flat descriptors: scalars, arrays and `Map`s.
- `createDefault()` must return every key with its real type (an empty array, an empty `Map`); the merge decides by the default's type.
- Use a `symbol` per decorator family; a shared symbol mixes unrelated data.

## Best practices

- Call `collapseInheritedDescriptor` when you only read, eg. in tooling, so you do not leave stored metadata behind on classes nobody decorated.
- Keep the descriptor type and `createDefault` next to the decorators and export a getter, so readers never touch the symbol.

## Related

- [Custom injection decorators](11-custom-injection-decorators.md): the DI's own injection descriptor, which uses `reflect-metadata` directly instead.
- [`@spinajs/http`](../http/README.md), [`@spinajs/orm`](../orm/README.md): decorator families built on this function.
