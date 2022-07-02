import '@spinajs/http';
import { User } from '@spinajs/rbac';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    user: User;
  }
}
