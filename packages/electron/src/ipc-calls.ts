import { DI } from "@spinajs/di";
import { Orm } from "@spinajs/orm";
import { Log } from "@spinajs/log-common";
import { AuthzConfigError, AuthzService, SYSTEM, authz } from "@spinajs/authz";

const log = () => DI.resolve(Log, ["ipc"]);

// Importing @spinajs/authz registers the service in every app, so DI.check alone cannot tell; an app that never booted authz makes authz() throw and the call runs as is.
function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  if (!DI.check(AuthzService)) {
    return fn();
  }
  try {
    return authz().runAs(SYSTEM, "electron-ipc", fn);
  } catch (err) {
    if (err instanceof AuthzConfigError) {
      return fn();
    }
    throw err;
  }
}

export function callOnOrmConnection(connection: string, method: string, ...args: any[]): Promise<any> {
  return asSystem(async () => {
    log().trace(`call on __spinajsIpcBridge::callOnOrmConnection(), method: ${method}`);

    const _s = await DI.get(Orm);
    if (!_s) {
      const msg = `call on __spinajsIpcBridge::callOnOrmConnection() failed, method: ${method}`;
      const error = new Error(msg);
      log().error(msg);

      // inform render process
      throw error;
    }

    const _conn = _s.Connections.get(connection);
    if (!_conn) {
      const msg = `call on __spinajsIpcBridge::callOnOrmConnection() failed, method: ${method}, connection: ${connection}"`;
      const error = new Error(msg);
      log().error(msg);

      // inform render process
      throw error;
    }

    return (_conn as any)
      [method](...args)
      .then((result: any) => {
        return result;
      })
      .catch((err: unknown) => {
        const msg = `call on __spinajsIpcBridge::callOnOrmConnection() failed, method: ${method}, connection: ${connection}`;
        const error = new Error(msg, {
          cause: err,
        });
        log().error(msg);

        // inform render process
        return error;
      });
  });
}

export function callService(method: string, service: string, resolveArgs: any[], ...args: any[]): Promise<any> {
  return asSystem(async () => {
    log().trace(`call on __spinajsIpcBridge::call(), method: ${method}, service: ${service}`);

    const _s = await DI.resolve<any>(service, resolveArgs ?? undefined);
    if (!_s) {
      const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, no service named: ${service} exists in DI container`;
      const error = new Error(msg);
      log().error(msg);

      // inform render process
      return error;
    }

    if (method in _s && typeof _s[method] === "function") {
      try {
        return await _s[method](...args);
      } catch (err) {
        const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, on service: ${service}, cause: ${err.message}`;
        log().error(msg);

        throw new Error(msg, {
          cause: err,
        });
      }
    } else {
      const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, not found in service named: ${service}`;
      log().error(msg);

      throw new Error(msg);
    }
  });
}

// Answers through event.returnValue, so it cannot await runAs: it runs unattended and a scoped ORM query or an authz check inside it fails closed.
export function callServiceSync(event: { returnValue: unknown }, method: string, service: string, ...args: any[]): void {
  log().trace(`call on __spinajsIpcBridge::callSync(), method: ${method}, service: ${service}`);

  const _s = DI.get<any>(service);
  if (!_s) {
    const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, no service named: ${service} exists in DI container`;
    log().error(msg);

    // we return error, in render process preload we check & throw
    event.returnValue = new Error(msg);
  }

  if (method in _s && typeof _s[method] === "function") {
    try {
      event.returnValue = _s[method](...args);
    } catch (err) {
      const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, no service named: ${service}, cause: ${err.message}`;
      log().error(msg);

      // we return error, in render process preload we check & throw
      event.returnValue = new Error(msg);
    }
  } else {
    const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, not found in service named: ${service}`;
    log().error(msg);

    // we return error, in render process preload we check & throw
    event.returnValue = new Error(msg);
  }
}
