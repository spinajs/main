import { Argon2PasswordHasher } from '@spinajs/authn-local';

/** The 3.0 hasher without a pepper or the container, for seeding password hashes. */
export const testHasher = new Argon2PasswordHasher({});
