import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { SocketException } from '@spinajs/http-socket-common';
import { authoritativeSchema, checkSocketContract, loadRuntimeManifest, type Manifest, type ManifestMode, type SocketContractEntry, type SocketControllerEntry, type TypeRef } from '@spinajs/manifest';
import type { IRegisteredHandler, ISocketControllerDescriptor } from './interfaces.js';

const MAX_REPORTED_ERRORS = 10;

/** Manifest ids are relative ('spinajs/pkg/Name'); Ajv would resolve a $ref against the $id of the schema holding it, so every id is made absolute. */
const BASE = 'https://manifest.spinajs.invalid/';
const absolute = (id: string): string => `${BASE}${id}`;
const relativeId = (url: string): string => (url.startsWith(BASE) ? url.slice(BASE.length) : url);

function prepare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((member) => prepare(member));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('x-'))
      .map(([key, member]) => [key, key === '$ref' && typeof member === 'string' && !member.startsWith('#') ? absolute(member) : prepare(member)]),
  );
}

const INSTANCES = new WeakMap<Manifest, Ajv>();

/** Strict on purpose: no coercion, defaults or removal, so a payload is accepted as the contract says or refused. */
function ajvFor(manifest: Manifest): Ajv {
  let ajv = INSTANCES.get(manifest);
  if (!ajv) {
    ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    for (const [id, schema] of Object.entries(manifest.schemas)) {
      ajv.addSchema({ ...(prepare(schema) as object), $id: absolute(id) });
    }
    INSTANCES.set(manifest, ajv);
  }
  return ajv;
}

const describeError = (e: ErrorObject) => ({ path: e.instancePath, keyword: e.keyword, message: e.message ?? 'invalid' });

/** Ajv messages and stacks carry schema internals; only the unresolved reference is worth reporting. */
function compileFailure(error: unknown): string {
  const missing = (error as { missingRef?: unknown } | null)?.missingRef;
  return typeof missing === 'string' ? `unresolved $ref ${relativeId(missing)}` : 'the schema is not valid';
}

type Validator = (payload: unknown) => void;

function validatorOf(manifest: Manifest, ref: TypeRef): Validator | undefined {
  const id = authoritativeSchema(manifest, ref);
  if (id === undefined) return undefined;

  const validate: ValidateFunction | undefined = ajvFor(manifest).getSchema(absolute(id));
  if (!validate) {
    throw new Error('the schema is not valid');
  }

  return (payload) => {
    if (!validate(payload)) {
      const errors = validate.errors ?? [];
      throw new SocketException('invalid_argument', 'payload does not match the socket contract', { details: { errors: errors.slice(0, MAX_REPORTED_ERRORS).map(describeError), total: errors.length } });
    }
  };
}

interface IResolved {
  entry?: SocketControllerEntry;
  contract?: SocketContractEntry;
  problems: string[];
}

interface ICompiled {
  validators: Array<[IRegisteredHandler, Validator | undefined]>;
  problem?: string;
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
    const manifest = this.manifest();
    if (!manifest) return;

    const label = descriptor.Prefix ? `${controllerName} (prefix '${descriptor.Prefix}')` : controllerName;
    const { entry, contract, problems } = this.resolve(manifest, controllerName, label, descriptor);
    if (entry && contract) {
      problems.push(...checkSocketContract(manifest, entry, contract).map((i) => i.message), ...this.unhandled(controllerName, contract, commands, events));
    }

    const compiled = contract && this.compile(manifest, contract, commands, events);
    if (compiled?.problem) {
      problems.push(compiled.problem);
    }
    this.report(label, [...new Set(problems)]);

    for (const [handler, validator] of compiled?.validators ?? []) {
      handler.contractValidator = validator;
    }
  }

  /**
   * A controller is identified by class name plus prefix, the only parts of its manifest entry that exist at runtime.
   * The manifest's binding is authoritative: a contract declared in code that disagrees with it is a problem, and a
   * controller the manifest binds is enforced in `require` even when its code declares no contract.
   */
  protected resolve(manifest: Manifest, controllerName: string, label: string, descriptor: ISocketControllerDescriptor): IResolved {
    const declared = descriptor.Contract !== undefined;
    const runtimeId = descriptor.Contract?.id;

    const named = manifest.socketControllers.filter((c) => c.className === controllerName && c.prefix === (descriptor.Prefix ?? ''));
    const bound = runtimeId === undefined ? [] : named.filter((c) => c.contract === runtimeId);
    const candidates = bound.length > 0 ? bound : named;

    if (candidates.length > 1) {
      return { problems: [`${label} matches ${candidates.length} manifest entries (${candidates.map((c) => c.id).join(', ')}); the binding is ambiguous, rename a controller or give it its own prefix`] };
    }

    const entry = candidates[0];
    if (!entry) {
      return { problems: declared ? [`${label} is not in the manifest; run spinajs build`] : [] };
    }

    if (!declared) {
      return this.manifestBound(manifest, entry, label);
    }

    if (runtimeId !== undefined && entry.contract !== undefined && entry.contract !== runtimeId) {
      return { entry, problems: [`${label} is bound to contract ${runtimeId} at runtime but to ${entry.contract} in the manifest; run spinajs build`] };
    }

    const id = runtimeId ?? entry.contract;
    if (id === undefined) {
      return { entry, problems: [`contract of ${controllerName} is not in the manifest: give it an explicit id with defineContract('<id>') or export it from a package with a manifest fragment`] };
    }
    return this.contractOf(manifest, entry, id, label);
  }

  /** The code declares no contract but the manifest binds one: `require` enforces the manifest, `prefer` only reports. */
  protected manifestBound(manifest: Manifest, entry: SocketControllerEntry, label: string): IResolved {
    if (entry.contract === undefined) return { problems: [] };

    const enforced = this.mode() === 'require';
    const problem = enforced ? `declares no contract; enforcing ${entry.contract} from the manifest` : `declares no contract but the manifest binds ${entry.contract}; it is not enforced`;
    this.Log.warn({ controller: label, problem }, 'Socket controller ${controller} ${problem}');
    return enforced ? this.contractOf(manifest, entry, entry.contract, label) : { problems: [] };
  }

  protected contractOf(manifest: Manifest, entry: SocketControllerEntry, id: string, label: string): IResolved {
    const found = manifest.socketContracts.filter((c) => c.id === id);
    if (found.length > 1) {
      return { entry, problems: [`contract ${id} is declared twice in the manifest (${found.map((c) => `${c.source.file}:${c.source.line}`).join(', ')}); give one of them an explicit id`] };
    }
    return { entry, contract: found[0], problems: found[0] ? [] : [`contract ${id} bound to ${label} is not in the manifest; run spinajs build`] };
  }

  /** The manifest describes the build; the registered handlers are what runs. */
  protected unhandled(controllerName: string, contract: SocketContractEntry, commands: IRegisteredHandler[], events: IRegisteredHandler[]): string[] {
    const missing = (kind: string, names: string[], handlers: IRegisteredHandler[]) =>
      names.filter((name) => !handlers.some((h) => h.fullName === name)).map((name) => `handler-missing: ${controllerName} has no @${kind} for ${name} declared by contract ${contract.id}`);

    return [...missing('Command', Object.keys(contract.commands), commands), ...missing('OnEvent', Object.keys(contract.clientEvents), events)];
  }

  /** All or nothing per contract: a schema that cannot compile leaves every handler of that contract unvalidated. */
  protected compile(manifest: Manifest, contract: SocketContractEntry, commands: IRegisteredHandler[], events: IRegisteredHandler[]): ICompiled {
    const validators: ICompiled['validators'] = [];
    const targets: Array<[IRegisteredHandler, TypeRef | undefined]> = [...commands.map((h): [IRegisteredHandler, TypeRef | undefined] => [h, contract.commands[h.fullName]?.payload]), ...events.map((h): [IRegisteredHandler, TypeRef | undefined] => [h, contract.clientEvents[h.fullName]])];

    for (const [handler, ref] of targets) {
      try {
        validators.push([handler, ref && validatorOf(manifest, ref)]);
      } catch (error) {
        return { validators: [], problem: `contract ${contract.id} cannot be enforced: the schema of ${handler.fullName} cannot be compiled, ${compileFailure(error)}` };
      }
    }
    return { validators };
  }

  protected report(label: string, problems: string[]): void {
    if (problems.length === 0) return;

    if (this.mode() === 'require') {
      throw new InvalidOperation(`Socket controller ${label} does not satisfy its contract:\n${problems.join('\n')}`);
    }
    for (const problem of problems) {
      this.Log.warn({ controller: label, problem }, 'Socket controller ${controller} does not satisfy its contract: ${problem}');
    }
  }
}
