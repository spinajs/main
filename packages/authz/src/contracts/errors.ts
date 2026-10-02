export class AuthzConfigError extends Error {
  // boot/programming errors
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UnknownPermission extends AuthzConfigError {}
