import { DI } from '@spinajs/di';

/**
 * JSON schemas for the auth endpoints' RESPONSE bodies.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 * The auth controllers already annotate their returns with the interface names
 * from `interfaces.ts` (`@returns {ILoginResponse}`, `{IActiveRoleResponse}`,
 * …). Those annotations resolved to nothing: the swagger builder asks its
 * `SchemaProvider`s for a schema by name, no provider knows a plain TypeScript
 * interface, and `inferSchemaFromString` then falls back to
 * `{ type: 'object', description: '<name>' }` — an object with no properties.
 *
 * The published spec therefore described `/auth/login`, `/auth/2fa/verify` and
 * both `/auth/active-role` operations as returning an empty object. Generated
 * clients believed it: every one of those responses typed as `object`, and
 * codegen that builds models from response schemas had nothing to build from.
 *
 * Registering the schemas under the SAME names the annotations already use is
 * what makes them resolve — no controller annotation changes, and the component
 * names in the spec are the ones the code has always claimed.
 *
 * ---------------------------------------------------------------------------
 * Why raw registration and not `@Schema`
 * ---------------------------------------------------------------------------
 * `@Schema` is sugar for exactly the call below, keyed on the decorated class's
 * name. Using it here would mean declaring classes called `ILoginResponse` and
 * friends purely to carry a name — and they would collide with the interfaces of
 * that name this package already exports. These describe responses; there is
 * nothing to construct.
 *
 * ---------------------------------------------------------------------------
 * Keep in sync with `interfaces.ts`
 * ---------------------------------------------------------------------------
 * The schemas below describe what the endpoints really put on the wire, which is
 * what a client validator has to accept. Where that differs from the interface,
 * the wire wins and the difference is called out in a comment.
 */

/** `format: date-time` as the backend emits it — `dateTimeFormat: 'iso'`, offset included. */
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true } as const;

/**
 * One metadata row as dehydrated onto the wire.
 *
 * `Value` is a string regardless of `Type`: the column stores text and `Type`
 * says how to read it. A client that wants the decoded value decodes it itself.
 */
export const UserMetadataEntrySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User metadata entry',
  type: 'object',
  properties: {
    Id: { type: 'integer' },
    Key: { type: 'string' },
    Type: {
      type: 'string',
      enum: ['number', 'float', 'string', 'json', 'boolean', 'datetime'],
    },
    Value: { type: 'string', nullable: true },
  },
};

/**
 * A reference to the entry schema above, by the tag the builder resolves.
 *
 * `expandNamedSchemas` turns any node whose `description` names a registered
 * schema into a `$ref` to that component — this is how the builder expresses a
 * reference, and it is worth using rather than inlining the object three times.
 *
 * Not merely tidier: the metadata entry carries an enum, and an enum inline
 * inside a `oneOf` arm (which `ILoginResponse` is) makes generators emit type
 * references that index the union by a key only one arm has. Giving the entry
 * its own component takes the enum out of the union entirely.
 */
const userMetadataEntryRef = { description: 'IUserMetadataEntry' } as const;

/**
 * The user's own columns, as `dehydrateWithRelations({ dateTimeFormat: 'iso' })`
 * produces them.
 *
 * `Password` is deliberately absent. It is a column on the ORM model, so any
 * endpoint documented as returning the model advertises it as part of the
 * response — it is never actually sent, and a spec must not say otherwise.
 *
 * `IsActive` is an integer, not a boolean: the column is a tinyint and the
 * driver hands back 0/1.
 */
const userProperties = {
  Uuid: { type: 'string' },
  Email: { type: 'string', format: 'email' },
  Login: { type: 'string' },
  Role: {
    type: 'array',
    items: { type: 'string' },
    description: 'Every role assigned to the user — the set /auth/active-role may switch between',
  },
  IsActive: { type: 'integer', description: '1 when the account is active' },
  CreatedAt: dateTime,
  RegisteredAt: nullableDateTime,
  DeletedAt: nullableDateTime,
  LastLoginAt: nullableDateTime,
  Metadata: { type: 'array', items: userMetadataEntryRef },
} as const;

/**
 * `required` on a RESPONSE, kept to the bare minimum on purpose.
 *
 * A response schema describes what a client must ACCEPT, not what it may send,
 * and `required` there is a promise a client validator will enforce — one this
 * codebase has already been bitten by, when response components were built from
 * the write contract and `User.Password` came out `required`. Every ordinary row
 * then failed validation. Response components are built without `required` for
 * that reason, and hand-written ones have no business reinstating it.
 *
 * The practical edge: a client generated from this spec and deployed before the
 * backend that fills a new field would reject every response outright, instead of
 * seeing the field missing and saying so.
 *
 * `Uuid` is the one exception, and it is structural rather than a data guarantee:
 * `ILoginResponse` is a union, and an arm with nothing required matches any
 * object at all — including the two-factor replies, which would then never reach
 * their own arms.
 */
const USER_REQUIRED = ['Uuid'];

/**
 * Flattened RBAC grants: resource → action → permission descriptor.
 *
 * The resource and action keys are data, so the schema can only describe the
 * shape two levels down. `additionalProperties` carries it.
 */
const grantsMap = {
  type: 'object',
  description:
    "Resolved grants for the active role, in accesscontrol's own format: " +
    "resource → 'action:possession' → attributes. Feed it back into new AccessControl().",
  properties: {
    $extend: {
      type: 'array',
      items: { type: 'string' },
      description: 'Roles this one inherits from. Sits alongside the resources, and is not one.',
    },
  },
  additionalProperties: {
    type: 'object',
    description: "One resource's permissions, keyed 'action:possession' (e.g. 'read:any')",
    additionalProperties: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** `IUserWithGrants` — the payload a completed login or 2FA verification returns. */
export const UserWithGrantsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'User with grants',
  type: 'object',
  properties: {
    ...userProperties,
    ActiveRole: {
      type: 'string',
      description: 'Role whose grants are in effect; defaults to Role[0] at login',
    },
    Grants: grantsMap,
  },
  required: USER_REQUIRED,
};

/**
 * `ITwoFactorAuthRequired` — password accepted, TOTP still owed.
 *
 * The flag is a plain boolean, not `const: true`. A single-value const becomes a
 * one-member enum in the emitted spec, and an enum inside a `oneOf` arm is what
 * makes generators reach for `Union["TheKey"]` — a key only one arm has. The
 * discriminator is which key is PRESENT, which `required` already states.
 */
export const TwoFactorAuthRequiredSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Two-factor verification required',
  type: 'object',
  properties: {
    TwoFactorAuthRequired: {
      type: 'boolean',
      description: 'Always true; the session is parked awaiting a TOTP code',
    },
  },
  required: ['TwoFactorAuthRequired'],
};

/** `ITwoFactorInitRequired` — password accepted, enrolment owed before TOTP. */
export const TwoFactorInitRequiredSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Two-factor enrolment required',
  type: 'object',
  properties: {
    TwoFactorInitRequired: {
      type: 'boolean',
      description: 'Always true; the user must enrol a TOTP device before continuing',
    },
  },
  required: ['TwoFactorInitRequired'],
};

/**
 * `ILoginResponse` — the three shapes `/auth/login` can answer with.
 *
 * A discriminated union rather than one object with everything optional: the
 * caller branches on which key is present, and a schema that makes all of them
 * optional would validate a response carrying none.
 */
export const LoginResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Login response',
  // Two-factor arms first. A validator walks the arms in order and takes the
  // first that matches; the user arm requires only `Uuid` (see USER_REQUIRED),
  // so putting it first would let it swallow a two-factor reply.
  oneOf: [TwoFactorAuthRequiredSchema, TwoFactorInitRequiredSchema, UserWithGrantsSchema],
};

/** `IActiveRoleResponse` — what both `/auth/active-role` operations answer with. */
export const ActiveRoleResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Active role',
  type: 'object',
  properties: {
    ActiveRole: { type: 'string', description: 'Role whose grants are now in effect' },
    Grants: grantsMap,
  },
};

/**
 * `IWhoamiResponse` — `/auth/whoami`.
 *
 * The user's own columns plus the two fields the session contributes. It is NOT
 * the `User` ORM model, which is what this endpoint used to be documented as:
 * that model knows nothing of `ActiveRole` or `Authorized` — the two fields a
 * client needs most here — and does carry `Password`.
 */
export const WhoamiResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Current session user',
  type: 'object',
  properties: {
    ...userProperties,
    ActiveRole: {
      type: 'string',
      description: 'Role whose grants are in effect for this session',
    },
    Authorized: {
      type: 'boolean',
      description:
        'False while the session has passed the password step but still owes 2FA. ' +
        'Absent on sessions minted before this field existed, which were fully authorized.',
    },
  },
  required: USER_REQUIRED,
};

/** `IEnable2faResponse` — the OTP provisioning URI from `/auth/2fa/setup`. */
export const Enable2faResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Two-factor enrolment',
  type: 'object',
  properties: {
    otp: {
      type: 'string',
      description: 'OTP provisioning URI to scan with an authenticator app',
    },
  },
};

/**
 * Registers a schema under the name controllers reference it by.
 *
 * Same registry and same call `@Schema` makes, so `DtoSchemaProvider` resolves
 * these exactly as it resolves a decorated DTO.
 */
function registerResponseSchema(name: string, schema: object): void {
  DI.register(schema).asMapValue('__schemas__', name);
}

registerResponseSchema('IUserMetadataEntry', UserMetadataEntrySchema);
// `/user/grants` and `/grants` answer with the map on its own.
registerResponseSchema('IGrantsMap', { $schema: 'http://json-schema.org/draft-07/schema#', title: 'Grants map', ...grantsMap });
registerResponseSchema('IUserWithGrants', UserWithGrantsSchema);
registerResponseSchema('ITwoFactorAuthRequired', TwoFactorAuthRequiredSchema);
registerResponseSchema('ITwoFactorInitRequired', TwoFactorInitRequiredSchema);
registerResponseSchema('ILoginResponse', LoginResponseSchema);
registerResponseSchema('IActiveRoleResponse', ActiveRoleResponseSchema);
registerResponseSchema('IWhoamiResponse', WhoamiResponseSchema);
registerResponseSchema('IEnable2faResponse', Enable2faResponseSchema);
