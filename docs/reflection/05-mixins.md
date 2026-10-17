# Mixins

`use` and `delegate` copy methods from other classes or object literals into a class. They are re-exported from [`typescript-mix`](https://www.npmjs.com/package/typescript-mix) and are the only exports of the package's `browser` build. `@spinajs/orm` composes its query builders with `@use`.

## How it works

### `@use(...mixins)`

1. `@use(A, B)` decorates a property of the client class, by convention `this!: this`. It runs once, when the class is defined.
2. It records the own property names of the client prototype.
3. It walks the mixins from last to first. For a class it reads `Mixin.prototype`; for an object literal, the object itself.
4. For each own property of the mixin that is a method or a getter/setter, and whose name the client prototype does not own, it defines the property on the client prototype.
5. Because the walk runs last to first, a method present in several mixins ends up from the **first** mixin listed.

### `@delegate(fn)`

1. `@delegate(fn)` decorates a property of the client class.
2. It assigns `fn` to that property name on the client prototype.

TypeScript does not see mixed-in members. Declare an interface with the class's name that extends the mixins; declaration merging then types them.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@use(...mixins)` | property (any name; `this` by convention) | Classes or object literals | Copies the mixins' own methods and accessors onto the class prototype, skipping names the class prototype owns |
| `@delegate(method)` | property | A function | Sets the function as that property on the class prototype |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Mixed-in behaviour | none: applied to the class prototype at definition time | none | Any class or object literal | List it in `@use(...)`; override a mixed-in method by declaring it in the class itself |
| `@spinajs/orm` builder mixins | `@use(WhereBuilder, LimitBuilder, OrderByBuilder, ...)` on `SelectQueryBuilder` and others | The ORM's builders | Your builder subclass | See [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md) |

### Mixin: custom implementation

Write a mixin as a class whose methods use only members the client declares. Mixin fields and constructors never run in the client, so the client declares and initializes the state.

```ts sample
import { delegate, use } from '@spinajs/reflection';

/** Timestamps for any record that keeps CreatedAt / UpdatedAt. */
export class Timestamped {
  public CreatedAt!: Date;
  public UpdatedAt!: Date;

  public touch(): void {
    this.UpdatedAt = new Date();
  }

  public get AgeInDays(): number {
    return Math.floor((Date.now() - this.CreatedAt.getTime()) / 86_400_000);
  }
}

/** Soft delete as an object literal mixin. */
export const SoftDeletable = {
  DeletedAt: undefined as Date | undefined,
  softDelete(this: { DeletedAt?: Date }): void {
    this.DeletedAt = new Date();
  },
  isDeleted(this: { DeletedAt?: Date }): boolean {
    return this.DeletedAt !== undefined;
  },
};

function formatInvoiceNumber(this: Invoice): string {
  return `INV/${this.CreatedAt.getFullYear()}/${String(this.Sequence).padStart(5, '0')}`;
}

// Declaration merging types the mixed-in members.
export interface Invoice extends Timestamped {
  softDelete(): void;
  isDeleted(): boolean;
}

export class Invoice {
  @use(Timestamped, SoftDeletable)
  this!: this;

  @delegate(formatInvoiceNumber)
  public number!: () => string;

  public CreatedAt = new Date('2026-01-15');
  public UpdatedAt = new Date('2026-01-15');
  public DeletedAt?: Date;

  constructor(public Sequence: number) {}
}

const invoice = new Invoice(42);
invoice.touch();
console.log(invoice.number(), invoice.AgeInDays, invoice.isDeleted());
// INV/2026/00042 <days> false
invoice.softDelete();
```

## Important behaviour

- **The class wins over its mixins.** A method the class declares itself is never replaced.
- **Mixins win over the superclass.** A mixed-in method shadows an inherited method of the same name, because only the class's own names are protected.
- **First listed mixin wins** when two mixins define the same method.
- **Only methods and accessors are copied.** Fields, field initializers and constructors of a mixin are ignored.
- **Only the mixin's own members are copied.** Methods a mixin class inherits from its own superclass are not.
- **Static members are not copied.**
- **The prototype is changed for good.** Every instance and every subclass sees the mixed-in methods; there is no undo.
- **No type checking of mixins.** `@use` accepts any class or object; the merged interface is your promise that the members exist.

## Best practices

- Pair every `@use` with a merged interface, as `@spinajs/orm` does for its builders.
- Keep mixins stateless: read and write only fields the client declares.
- Use `@delegate` for one shared function, `@use` for a group of related methods.

## Patterns and antipatterns

```ts
// Don't: the mixin's field initializer never runs in the client
class Counted {
  public Count = 0;
  public increment() { this.Count++; }
}
class DownloadStats {
  @use(Counted) this!: this;
}
// new DownloadStats().increment() turns Count into NaN

// Do: the client owns the state
class DownloadStats {
  @use(Counted) this!: this;
  public Count = 0;
}
```

## Related

- [`typescript-mix`](https://www.npmjs.com/package/typescript-mix): the upstream library.
- [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md): how the ORM's mixed-in builders are extended.
