# Domain exceptions

A domain exception is your own subclass of `Exception` or of a semantic class such as `Forbidden`. It names the rule that failed (`InvoiceLocked`, `InvitationRefused`), can carry a stable code, and keeps the HTTP status of the class it extends.

Use one whenever callers or clients must tell two failures of the same kind apart.

## How it works

1. You declare `class InvoiceLocked extends Forbidden {}` and throw it.
2. Callers that only care about the kind catch it with `err instanceof Forbidden`. Callers that care about the rule use `err instanceof InvoiceLocked`.
3. In an HTTP request, `@spinajs/http`'s `__resolve_error_response__()` looks up `InvoiceLocked` by class name in `__http_error_map__`.
4. With no exact entry, it walks up the prototype chain to `Forbidden`, finds `ForbiddenResponse`, and answers 403.
5. With no mapped class anywhere in the chain, the answer is HTTP 500 (`ServerError`) and a warning is logged.

An exact registration for `InvoiceLocked` wins over the inherited `Forbidden` one. See [HTTP error mapping](03-http-error-mapping.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Exception` and its subclasses | None: plain classes, not in DI | The sixteen exported classes | Domain subclasses in `@spinajs/orm` (`OrmException`), `@spinajs/validation` (`ValidationFailed`), `@spinajs/util` (`TimeoutRejectedException`), `@spinajs/teams` (`InvitationRefused`), `@spinajs/configuration-http` (`ConfigWriteRefused`) | Subclass the class whose meaning and HTTP status fit; add fields in the constructor; set `name`. |

### Which base class to extend

| Your failure | Extend | Inherited HTTP status |
| --- | --- | --- |
| The caller may not do this | `Forbidden` | 403 |
| The caller is not signed in, or the credentials are wrong | `AuthenticationFailed` | 401 |
| A specific input value is wrong | `InvalidArgument` | 400 |
| The request as a whole is wrong | `BadRequest` | 400 |
| The target does not exist | `ResourceNotFound` | 404 |
| The target already exists, or the state conflicts | `ResourceDuplicated` | 409 |
| An internal fault the client cannot fix | `UnexpectedServerError` or `IOFail` | 500 |
| A programming or state error that never reaches HTTP | `InvalidOperation` or `Exception` | 500 (unmapped) |

### What to override

`Exception` has no hooks or abstract members. A subclass customizes three things in its constructor:

- `name`: set `this.name = new.target.name`. `Exception` leaves it as `'Error'`.
- Public fields: every own enumerable field is spread into the HTTP error body. Use them for the client contract, for example a `code`.
- Private context: define it with `Object.defineProperty(this, key, { value, enumerable: false })` so the HTTP body and `JSON.stringify` skip it.

### Domain exception: custom implementation

```ts sample
import { Forbidden } from '@spinajs/exceptions';

export const INVOICE_LOCK_REASONS = ['exported', 'paid', 'cancelled'] as const;
export type InvoiceLockReason = (typeof INVOICE_LOCK_REASONS)[number];

/** `code` is part of the API contract; `invoice` stays on the server. */
export class InvoiceLocked extends Forbidden {
  declare readonly invoice: { id: number; customerId: number };

  constructor(public readonly code: InvoiceLockReason, invoice: { id: number; customerId: number }) {
    super(`invoice ${invoice.id} is locked: ${code}`);
    this.name = new.target.name;
    Object.defineProperty(this, 'invoice', { value: invoice, enumerable: false });
  }
}

export function editInvoice(invoice: { id: number; customerId: number; status: string }): void {
  if (invoice.status === 'exported' || invoice.status === 'paid' || invoice.status === 'cancelled') {
    throw new InvoiceLocked(invoice.status, invoice);
  }
}

try {
  editInvoice({ id: 12, customerId: 3, status: 'paid' });
} catch (err) {
  if (err instanceof InvoiceLocked) {
    console.log(err.code, err.invoice.customerId); // paid 3
  }
  if (err instanceof Forbidden) {
    console.log(JSON.stringify({ ...err, message: err.message }));
    // {"code":"paid","name":"InvoiceLocked","message":"invoice 12 is locked: paid"}
  }
}
```

Thrown from a controller, `InvoiceLocked` answers 403 with `code`, `name` and `message` in the body, and without `invoice`.

## Important behaviour

- The HTTP mapping matches by class **name**, not by identity. A domain class named like a mapped class (your own `BadRequest`) takes that class's status, whatever it extends.
- Two domain classes with the same name in different packages share one map entry.
- A minifier that renames classes breaks the lookup; a renamed exception misses the map and answers 500.
- `this.name = new.target.name` makes `name` an own enumerable field, so it appears in the HTTP body. That is what `@spinajs/authz` and `@spinajs/teams` do.
- A constructor parameter property (`public readonly code`) is enumerable. A `declare` field plus `Object.defineProperty(..., { enumerable: false })` keeps a value out of the body.

## Best practices

- Extend the semantic class whose HTTP status is right, not `Exception`: a `class GroupNotOwned extends Forbidden {}` answers 403 with no extra mapping.
- Export a closed list of codes (`as const`) next to the class when clients branch on them, as `@spinajs/teams` does with `INVITATION_REFUSALS`.
- Keep the message human-readable and the `code` stable; clients must not parse the message.
- Group a package's exceptions in one `errors.ts` and export them from the package entry, so callers can `instanceof` them.

## Patterns and antipatterns

```ts
// Don't: a plain Error subclass has no mapping, so a refusal answers 500 and logs a warning
export class InvoiceLocked extends Error {}

// Do: extend the semantic class; the 403 is inherited
export class InvoiceLocked extends Forbidden {}
```

```ts
// Don't: the whole user row, with its password hash, lands in the 403 body
export class AccountSuspended extends Forbidden {
  constructor(public user: User) {
    super(`account ${user.id} is suspended`);
  }
}

// Do: keep server-side context non-enumerable
export class AccountSuspended extends Forbidden {
  declare readonly user: User;
  constructor(user: User) {
    super(`account ${user.id} is suspended`);
    this.name = new.target.name;
    Object.defineProperty(this, 'user', { value: user, enumerable: false });
  }
}
```

## Examples

### Separate "already enrolled" from "not started" in a two-step flow

```ts sample
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';

export class PhoneAlreadyVerified extends ResourceDuplicated {
  constructor(userId: number) {
    super(`user ${userId} already has a verified phone`);
    this.name = new.target.name;
  }
}

export class VerificationNotStarted extends ResourceNotFound {
  constructor(userId: number) {
    super(`no phone verification in progress for user ${userId}`);
    this.name = new.target.name;
  }
}

export class WrongVerificationCode extends InvalidArgument {
  constructor(public readonly attemptsLeft: number) {
    super('verification code does not match', 'code', 'WRONG_CODE');
    this.name = new.target.name;
  }
}

interface Pending {
  code: string;
  attemptsLeft: number;
}

const verified = new Set<number>();
const pending = new Map<number, Pending>();

export function confirmPhone(userId: number, code: string): void {
  if (verified.has(userId)) throw new PhoneAlreadyVerified(userId); // 409
  const entry = pending.get(userId);
  if (!entry) throw new VerificationNotStarted(userId); // 404

  if (entry.code !== code) {
    entry.attemptsLeft -= 1;
    throw new WrongVerificationCode(entry.attemptsLeft); // 400, body carries fieldName, errorCode, attemptsLeft
  }

  pending.delete(userId);
  verified.add(userId);
}
```

### Wrap a third-party failure without leaking it

```ts sample
import { UnexpectedServerError } from '@spinajs/exceptions';

export class PaymentGatewayFailed extends UnexpectedServerError {
  declare readonly gatewayResponse: unknown;

  constructor(public readonly paymentId: string, gatewayResponse: unknown) {
    super(`payment ${paymentId} could not be captured`);
    this.name = new.target.name;
    Object.defineProperty(this, 'gatewayResponse', { value: gatewayResponse, enumerable: false });
  }
}

export async function capture(paymentId: string): Promise<void> {
  const response = await fetch(`https://payments.example.com/v1/payments/${paymentId}/capture`, { method: 'POST' });
  if (!response.ok) {
    throw new PaymentGatewayFailed(paymentId, await response.text());
  }
}
```

## Related

- [Exception classes](01-exception-classes.md): the base classes and the status each one gets.
- [HTTP error mapping](03-http-error-mapping.md): give a domain exception its own status instead of the inherited one.
- [`@spinajs/http`](../http/README.md): spreads the exception's enumerable fields into the error body.
