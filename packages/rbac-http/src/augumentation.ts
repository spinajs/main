import '@spinajs/http';
import { ISession, User } from '@spinajs/rbac';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    user: User | null;
    session: ISession | null;
  }
}
