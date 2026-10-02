// Boot and programming errors.
export class AuthzConfigError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UnknownPermission extends AuthzConfigError {}
