import { User } from './models/User.js';

export function _user(identifier: number | string | User): () => Promise<User> {
  if (identifier instanceof User) {
    return () => Promise.resolve(identifier);
  }
  return () => User.query().whereAnything(identifier).populate('Metadata').firstOrFail();
}
