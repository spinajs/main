import { Middleware } from '../decorators.js';
import { BotCheckMiddleware } from './middleware.js';

/**
 * Guards a route, or every route of a controller, with the bot check `http.bot.checks.<check>`. The check is a no-op
 * until both `http.bot.enabled` and its own `enabled` are true. Declare it after other route middlewares: it runs last.
 */
export function BotCheck(check: string): (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => void {
  return Middleware(BotCheckMiddleware, check);
}
