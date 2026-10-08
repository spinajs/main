import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { Access, typedExtractor } from '@spinajs/authz-http';
import type { User } from '@spinajs/users';

import { CurrentUser } from '../args/current-user.js';

/**
 * The `user` ref of the caller's own row. Any other principal is refused here, so the check never runs on a row
 * the caller did not sign in as, whatever unconditional `user:read` it holds.
 */
const ownUser = typedExtractor('user', (req: Request) => {
  const principal = req.storage.Principal;
  if (principal?.type !== 'user' || typeof principal.id !== 'string' || principal.id === '') {
    throw new Forbidden('this route serves the signed-in user only');
  }
  return { type: 'user', id: principal.id };
});

/**
 * The signed-in user's own account.
 * @tags User
 */
@BasePath('user')
export class UserController extends BaseController {
  /**
   * Current user profile
   * The signed-in user's record with its metadata (reserved keys left out), limited to the fields its roles read on
   * it: with users' shipped `user` role, Email and Login.
   * @security cookieAuth
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — not a user principal, or no `user:read` on its own record
   */
  @Get('/')
  @Access('user:read', { resource: ownUser, subject: 'load', fields: 'filter' })
  public async refresh(@CurrentUser() user: User) {
    return new Ok(user.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }
}
