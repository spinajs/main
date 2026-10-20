import type { Principal } from '@spinajs/authz';

/** What the fake reads from a request; an express Request fits it. */
export interface FakeRequestLike {
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface FakePrincipalSourceOptions {
  readonly name?: string;
  readonly order?: number;
  /** Header whose value is a key of `principals`. */
  readonly header?: string;
  readonly principals?: Readonly<Record<string, Principal>>;
  /** Used instead of the header lookup when given. */
  readonly authenticate?: (req: FakeRequestLike) => Principal | null | Promise<Principal | null>;
}

/**
 * A structural mirror of authz-http's PrincipalSource (name, order, authenticate); the kit does not
 * depend on authz-http. Register it under authz-http's token in tests that need one.
 */
export class FakePrincipalSource {
  readonly name: string;
  readonly order: number;
  readonly requests: FakeRequestLike[] = [];

  constructor(private readonly opts: FakePrincipalSourceOptions = {}) {
    this.name = opts.name ?? 'fake';
    this.order = opts.order ?? 0;
  }

  async authenticate(req: FakeRequestLike): Promise<Principal | null> {
    this.requests.push(req);
    if (this.opts.authenticate) return this.opts.authenticate(req);
    if (!this.opts.header) return null;
    const headers = req.headers ?? {};
    const name = Object.keys(headers).find((k) => k.toLowerCase() === this.opts.header!.toLowerCase());
    const raw = name === undefined ? undefined : headers[name];
    const key = Array.isArray(raw) ? raw[0] : raw;
    const principals = this.opts.principals ?? {};
    return typeof key === 'string' && Object.hasOwn(principals, key) ? principals[key] : null;
  }
}
