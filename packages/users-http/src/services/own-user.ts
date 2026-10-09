import { Forbidden } from '@spinajs/exceptions';
import type { Request } from '@spinajs/http';
import { typedExtractor } from '@spinajs/authz-http';

/**
 * The `user` ref of the caller's own row. Any other principal is refused here, so the check never runs on a row
 * the caller did not sign in as, whatever unconditional `user:read` it holds.
 */
export const ownUser = typedExtractor('user', (req: Request) => {
  const principal = req.storage.Principal;
  if (principal?.type !== 'user' || typeof principal.id !== 'string' || principal.id === '') {
    throw new Forbidden('this route serves the signed-in user only');
  }
  return { type: 'user', id: principal.id };
});
