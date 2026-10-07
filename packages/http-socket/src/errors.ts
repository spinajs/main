import { randomUUID } from 'node:crypto';
import { Constructor, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { AuthenticationFailed, BadRequest, Forbidden, InvalidArgument, InvalidOperation, JsonValidationFailed, MethodNotImplemented, NotSupported, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { ValidationFailed } from '@spinajs/validation';
import { AccessDenied, isProduction } from '@spinajs/authz';
import type { DenyReason } from '@spinajs/authz';
import { DEFAULT_RETRYABLE, ErrorCode, SocketError, SocketException } from '@spinajs/http-socket-common';

export abstract class SocketErrorMapping {
  public abstract map(error: Error): SocketError;
}

// Module-level rather than a DI map value (as @HandleException does): DI.clearCache() drops
// cache entries, and the decorators that fill this map run only once per process.
const SOCKET_ERROR_MAP = new Map<string, Constructor<SocketErrorMapping>>();

/**
 * Registers the decorated mapping for one or more exception types. Lookup walks the prototype
 * chain, so a domain subclass of a mapped exception maps the same way unless it has its own entry.
 */
export function HandleSocketException(exception: Constructor<Error> | Constructor<Error>[]) {
  return (target: Constructor<SocketErrorMapping>) => {
    for (const e of Array.isArray(exception) ? exception : [exception]) {
      SOCKET_ERROR_MAP.set(e.name, target);
    }
  };
}

export function resolveSocketErrorMapping(error: unknown): Constructor<SocketErrorMapping> | null {
  for (let ctor = (error as { constructor?: unknown } | null | undefined)?.constructor; typeof ctor === 'function' && ctor !== Object; ctor = Object.getPrototypeOf(ctor)) {
    const name = (ctor as { name?: string }).name;
    if (name && SOCKET_ERROR_MAP.has(name)) {
      return SOCKET_ERROR_MAP.get(name)!;
    }
  }

  return null;
}

export function codeMapping(code: ErrorCode): new () => { map(error: Error): SocketError } {
  return class extends SocketErrorMapping {
    public map(error: Error): SocketError {
      return { code, message: error.message, retryable: DEFAULT_RETRYABLE[code] };
    }
  };
}

@HandleSocketException([InvalidArgument, BadRequest, JsonValidationFailed])
export class InvalidArgumentMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    const field = (error as InvalidArgument).fieldName;
    return { code: 'invalid_argument', message: error.message, retryable: false, ...(typeof field === 'string' ? { details: { field } } : {}) };
  }
}

@HandleSocketException(ValidationFailed)
export class ValidationFailedMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    return { code: 'invalid_argument', message: error.message, retryable: false, details: (error as ValidationFailed).details };
  }
}

@HandleSocketException(AuthenticationFailed)
export class UnauthenticatedMapping extends codeMapping('unauthenticated') {}

@HandleSocketException(Forbidden)
export class ForbiddenMapping extends codeMapping('forbidden') {}

// priority and sortKey only order the deny reasons; authz-http leaves them out of its 403 body (B23)
function publicReason(reason: DenyReason): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reason)) {
    if (key !== 'priority' && key !== 'sortKey') {
      out[key] = value;
    }
  }
  return out;
}

/** The socket form of authz-http's 403 body. Never a trace: B41 forbids it in production, and sockets do not offer explain. */
@HandleSocketException(AccessDenied)
export class AccessDeniedMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    const decision = (error as AccessDenied).decision;
    return {
      code: 'forbidden',
      message: error.message,
      retryable: false,
      details: { permission: decision.permission, resource: decision.resource, ...(decision.reason ? { reason: publicReason(decision.reason) } : {}) },
    };
  }
}

@HandleSocketException(ResourceNotFound)
export class NotFoundMapping extends codeMapping('not_found') {}

@HandleSocketException(ResourceDuplicated)
export class ConflictMapping extends codeMapping('conflict') {}

@HandleSocketException(InvalidOperation)
export class FailedPreconditionMapping extends codeMapping('failed_precondition') {}

@HandleSocketException([NotSupported, MethodNotImplemented])
export class UnimplementedMapping extends codeMapping('unimplemented') {}

@HandleSocketException(SocketException)
export class SocketExceptionMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    return (error as SocketException).toWire();
  }
}

@Injectable()
export class SocketErrorMapper {
  @Logger('http-socket')
  protected Log: Log;

  @Config('configuration.isProduction')
  protected IsProduction: boolean | undefined;

  /**
   * @param context - what failed, for the log line ( eg. `command docs.open` )
   */
  public toWire(error: unknown, context: string): SocketError {
    const mapping = resolveSocketErrorMapping(error);

    if (mapping && error instanceof Error) {
      try {
        return new mapping().map(error);
      } catch (mappingError) {
        return this.internal(mappingError, `${context} (error mapping ${mapping.name} failed)`);
      }
    }

    return this.internal(error, context);
  }

  protected internal(error: unknown, context: string): SocketError {
    const errorId = randomUUID();
    const err = error instanceof Error ? error : new Error(String(error));

    this.Log.error(err, `Socket ${context} failed, errorId: ${errorId}`);

    if (isProduction(this.IsProduction)) {
      return { code: 'internal', message: 'Internal server error', retryable: false, errorId };
    }

    return { code: 'internal', message: err.message, retryable: false, errorId, details: { name: err.name, stack: err.stack } };
  }
}
