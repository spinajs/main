import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { SocketException } from '@spinajs/http-socket-common';
import { authoritativeSchema, checkSocketContract, loadRuntimeManifest, type Manifest, type ManifestMode, type SocketContractEntry, type SocketControllerEntry, type TypeRef } from '@spinajs/manifest';
import type { IRegisteredHandler, ISocketControllerDescriptor } from './interfaces.js';

/** Manifest ids are relative ('spinajs/pkg/Name') and Ajv would resolve a $ref against the $id of the schema holding it. */
const absolute = (id: string): string => `https://manifest.spinajs.invalid/${id}`;

function prepare(value: unknown, ids: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((member) => prepare(member, ids));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('x-'))
      .map(([key, member]) => [key, (key === '$ref' || key === '$id') && typeof member === 'string' && ids.has(member) ? absolute(member) : prepare(member, ids)]),
  );
}

const INSTANCES = new WeakMap<Manifest, Ajv>();

/** Strict on purpose: no coercion, defaults or removal, so a payload is accepted as the contract says or refused. */
function ajvFor(manifest: Manifest): Ajv {
  let ajv = INSTANCES.get(manifest);
  if (!ajv) {
    const ids = new Set(Object.keys(manifest.schemas));
    ajv = new Ajv({ strict: false, allErrors: true });
    for (const [id, schema] of Object.entries(manifest.schemas)) {
      ajv.addSchema({ ...(prepare(schema, ids) as object), $id: absolute(id) });
    }
    INSTANCES.set(manifest, ajv);
  }
  return ajv;
}

const describeError = (e: ErrorObject) => ({ path: e.instancePath, keyword: e.keyword, message: e.message ?? 'invalid' });

function validatorOf(manifest: Manifest, ref: TypeRef): ((payload: unknown) => void) | undefined {
  const id = authoritativeSchema(manifest, ref);
  if (id === undefined) return undefined;

  const validate: ValidateFunction | undefined = ajvFor(manifest).getSchema(absolute(id));
  if (!validate) {
    throw new InvalidOperation(`manifest schema ${id} cannot be compiled`);
  }

  return (payload) => {
    if (!validate(payload)) {
      throw new SocketException('invalid_argument', 'payload does not match the socket contract', { details: { errors: (validate.errors ?? []).map(describeError) } });
    }
  };
}

interface IResolved {
  entry: SocketControllerEntry | undefined;
  contract: SocketContractEntry | undefined;
  problems: string[];
}

/**
 * Binds socket controllers to the contracts of the application manifest: `SOCK001` (a handler the contract declares is missing)
 * and `SOCK002`/`SOCK003` (payload or result incompatible) fail the build in `require` mode and are logged in `prefer`;
 * payloads of the handlers are validated against the contract schemas. `off` leaves the wire untouched.
 */
@Injectable()
export class SocketContractEnforcer {
  @Logger('http-socket')
  protected Log: Log;

  @Autoinject(Configuration)
  protected Cfg: Configuration;

  protected cached: { key: string; manifest: Manifest | undefined } | undefined;

  public mode(): ManifestMode {
    return this.Cfg.get<ManifestMode>('system.manifest.mode', 'off');
  }

  /** `undefined` for `off`, and for `prefer` without a readable manifest */
  public manifest(): Manifest | undefined {
    const mode = this.mode();
    if (mode === 'off') return undefined;

    const path = this.Cfg.get<string>('system.manifest.path', 'app.manifest.json');
    const key = `${mode}:${path}`;
    if (this.cached?.key !== key) {
      this.cached = { key, manifest: loadRuntimeManifest({ mode, path }) };
    }
    return this.cached.manifest;
  }

  public bind(controllerName: string, descriptor: ISocketControllerDescriptor, commands: IRegisteredHandler[], events: IRegisteredHandler[]): void {
    if (!descriptor.Contract) return;

    const manifest = this.manifest();
    if (!manifest) return;

    const { entry, contract, problems } = this.resolve(manifest, controllerName, descriptor);
    if (entry && contract) {
      problems.push(...checkSocketContract(manifest, entry, contract).map((i) => i.message), ...this.unhandled(controllerName, contract, commands, events));
    }
    this.report(controllerName, [...new Set(problems)]);

    if (contract) {
      this.attach(manifest, contract, commands, events);
    }
  }

  protected resolve(manifest: Manifest, controllerName: string, descriptor: ISocketControllerDescriptor): IResolved {
    const named = manifest.socketControllers.filter((c) => c.className === controllerName);
    const entry = named.length > 1 ? named.find((c) => c.prefix === (descriptor.Prefix ?? '')) : named[0];
    if (!entry) {
      return { entry, contract: undefined, problems: [`${controllerName} is not in the manifest; run spinajs build`] };
    }

    const problems: string[] = [];
    const runtimeId = descriptor.Contract?.id;
    if (entry.contract !== undefined && runtimeId !== undefined && entry.contract !== runtimeId) {
      problems.push(`${controllerName} is bound to contract ${runtimeId} at runtime but to ${entry.contract} in the manifest; run spinajs build`);
    }

    const id = runtimeId ?? entry.contract;
    const contract = manifest.socketContracts.find((c) => c.id === id);
    if (!contract) {
      problems.push(`contract ${id ?? '(unnamed)'} bound to ${controllerName} is not in the manifest; run spinajs build`);
    }
    return { entry, contract, problems };
  }

  /** The manifest describes the build; the registered handlers are what runs. */
  protected unhandled(controllerName: string, contract: SocketContractEntry, commands: IRegisteredHandler[], events: IRegisteredHandler[]): string[] {
    const missing = (kind: string, names: string[], handlers: IRegisteredHandler[]) =>
      names.filter((name) => !handlers.some((h) => h.fullName === name)).map((name) => `handler-missing: ${controllerName} has no @${kind} for ${name} declared by contract ${contract.id}`);

    return [...missing('Command', Object.keys(contract.commands), commands), ...missing('OnEvent', Object.keys(contract.clientEvents), events)];
  }

  protected attach(manifest: Manifest, contract: SocketContractEntry, commands: IRegisteredHandler[], events: IRegisteredHandler[]): void {
    for (const handler of commands) {
      const expected = contract.commands[handler.fullName];
      handler.contractValidator = expected && validatorOf(manifest, expected.payload);
    }

    for (const handler of events) {
      const expected = contract.clientEvents[handler.fullName];
      handler.contractValidator = expected && validatorOf(manifest, expected);
    }
  }

  protected report(controllerName: string, problems: string[]): void {
    if (problems.length === 0) return;

    if (this.mode() === 'require') {
      throw new InvalidOperation(`Socket controller ${controllerName} does not satisfy its contract:\n${problems.join('\n')}`);
    }
    for (const problem of problems) {
      this.Log.warn({ controller: controllerName, problem }, 'Socket controller ${controller} does not satisfy its contract: ${problem}');
    }
  }
}
