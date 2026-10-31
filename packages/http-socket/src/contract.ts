import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { Autoinject, Container, Injectable, type IContainer } from '@spinajs/di';
import { Configuration, effectiveManifestOf, type EffectiveManifest } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { SocketException } from '@spinajs/http-socket-common';
import { manifestSchemaKey, manifestValidatorOf, prepareManifestSchemas, sanitizeError, schemaOfClass, type IValidationError } from '@spinajs/validation';
import { authoritativeSchema, checkSocketContract, loadRuntimeManifest, resolveTypeRef, type Manifest, type ManifestMode, type SocketContractEntry, type SocketControllerEntry, type TypeRef } from '@spinajs/manifest';
import { PayloadArg } from './args.js';
import type { IRegisteredHandler, ISocketControllerDescriptor, ISocketHandlerDescriptor } from './interfaces.js';

const MAX_REPORTED_ERRORS = 10;

const relativeId = (key: string): string => (key.startsWith(manifestSchemaKey('')) ? key.slice(manifestSchemaKey('').length) : key);

interface IContractAjv {
  ajv: Ajv;
  /** Keys of the schemas Ajv refused */
  refused: Set<string>;
}

const INSTANCES = new WeakMap<Manifest, IContractAjv>();

/** A manifest holds every package's configuration schemas too; one Ajv refuses only matters to a contract that needs it, which then fails to compile. */
function addIfValid(ajv: Ajv, schema: object): boolean {
  try {
    if (ajv.validateSchema(schema) !== true) return false;
    ajv.addSchema(schema);
    return true;
  } catch {
    // A `$schema` Ajv does not know ( 2020-12 ) throws instead of failing the check.
    return false;
  }
}

/**
 * Strict on purpose: no coercion, defaults or removal, so a payload is accepted as the contract says or refused.
 * `strictSchema` stops a keyword or format this instance lacks compiling to nothing, which would leave the rule unenforced.
 * `verbose` gives `sanitizeError` the rule behind an error: the message of a `$data` rule carries another field's value.
 */
function contractAjvOf(manifest: Manifest): IContractAjv {
  let instance = INSTANCES.get(manifest);
  if (!instance) {
    const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: true, $data: true, verbose: true });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    ajv.addKeyword('$configurationModule');
    const refused = new Set<string>();
    for (const schema of prepareManifestSchemas(manifest)) {
      if (!addIfValid(ajv, schema)) refused.add(schema.$id);
    }
    instance = { ajv, refused };
    INSTANCES.set(manifest, instance);
  }
  return instance;
}

function describeError(e: ErrorObject) {
  const { instancePath, keyword, message } = sanitizeError(e as IValidationError);
  return { path: instancePath, keyword, message: message ?? 'invalid' };
}

class UnusableSchema extends Error {}

/** Ajv messages and stacks carry schema internals; only what names the fix is worth reporting. */
function compileFailure(manifest: Manifest, error: unknown): string {
  if (error instanceof UnusableSchema) return error.message;

  const { missingRef, missingSchema, message } = (error ?? {}) as { missingRef?: unknown; missingSchema?: unknown; message?: unknown };
  if (typeof missingRef === 'string') {
    const target = typeof missingSchema === 'string' ? missingSchema : missingRef;
    return contractAjvOf(manifest).refused.has(target) ? `${relativeId(target)} is not a valid JSON Schema` : `unresolved $ref ${relativeId(missingRef)}`;
  }
  return typeof message === 'string' && /^(strict mode: |unknown format )/.test(message) ? message : 'the schema is not valid';
}

type Validator = (payload: unknown) => void;

/** The command's `schema`, the `@Payload(schema)` or the DTO's `@Schema` wins in `PayloadArg`; the derived schema is then not compiled. */
function hasExplicitPayloadSchema(handler: IRegisteredHandler): boolean {
  if (handler.descriptor.Options.schema) return true;
  return [...handler.descriptor.Parameters.values()].some((p) => p.Type === PayloadArg && (!!p.Schema || schemaOfClass(p.RuntimeType) !== undefined));
}

function validatorOf(manifest: Manifest, ref: TypeRef): Validator | undefined {
  if (ref.schema !== undefined && !Object.hasOwn(manifest.schemas, ref.schema)) {
    throw new UnusableSchema(`${ref.schema} is not in the manifest`);
  }

  const id = authoritativeSchema(manifest, ref);
  if (id === undefined) return undefined;

  const validate: ValidateFunction | undefined = contractAjvOf(manifest).ajv.getSchema(manifestSchemaKey(id));
  if (!validate) {
    throw new UnusableSchema(`${id} is not a valid JSON Schema`);
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

  @Autoinject(Container)
  protected Container: IContainer;

  protected cached: { key: string; manifest: Manifest | undefined } | undefined;

  public mode(): ManifestMode {
    return this.effective().settings.mode;
  }

  /** `undefined` for `off`, and for `prefer` without a readable manifest */
  public manifest(): Manifest | undefined {
    return this.effective().manifest;
  }

  /** The configuration source's decision; `system.manifest` and the file it names only for an app built without that source. */
  protected effective(): EffectiveManifest {
    const decided = effectiveManifestOf(this.Container);
    if (decided) return decided;

    const settings = { mode: this.Cfg.get<ManifestMode>('system.manifest.mode', 'off'), path: this.Cfg.get<string>('system.manifest.path', 'app.manifest.json') };
    if (settings.mode === 'off') return { settings, manifest: undefined };

    const key = `${settings.mode}:${settings.path}`;
    if (this.cached?.key !== key) {
      this.cached = { key, manifest: loadRuntimeManifest(settings) };
    }
    return { settings, manifest: this.cached.manifest };
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

    this.bindDerived(manifest, controllerName, label, descriptor, [...commands, ...events]);
  }

  /**
   * A build without decorator metadata leaves the `@Payload` type undefined; the manifest names it ( `TypeRef.ref` ).
   * Runs before the handlers register, so schemas and hydration see what the metadata would have given. A payload it
   * cannot type fails the boot in `require` and stays untyped, with a warning, in `prefer`.
   */
  public async runtimeTypes(controllerName: string, descriptor: ISocketControllerDescriptor): Promise<void> {
    const untyped = [...descriptor.Handlers.values()].flatMap((h) => [...h.Parameters.values()].filter((p) => p.Type === PayloadArg && p.RuntimeType === undefined).map((p) => ({ handler: h, param: p })));
    const manifest = untyped.length > 0 ? this.manifest() : undefined;
    if (!manifest) return;

    const named = manifest.socketControllers.filter((c) => c.className === controllerName && c.prefix === (descriptor.Prefix ?? ''));
    const entry = named.length === 1 ? named[0] : undefined;
    const payloadOf = (handler: ISocketHandlerDescriptor): TypeRef | undefined =>
      handler.Kind === 'command' ? entry?.commands.find((c) => c.handler === String(handler.Method))?.payload : entry?.events.find((e) => e.name === handler.Name)?.payload;

    for (const { handler, param } of untyped) {
      const ref = payloadOf(handler)?.ref;
      try {
        if (!ref) {
          throw new Error('the manifest records no runtime type for it, run spinajs build');
        }
        param.RuntimeType = await resolveTypeRef(ref, manifest);
      } catch (error) {
        const problem = `the @Payload of ${controllerName}::${String(handler.Method)} has no runtime type and the build emits no decorator metadata: ${(error as Error).message}`;
        if (this.mode() === 'require') {
          throw new InvalidOperation(problem);
        }
        this.Log.warn({ problem }, 'Socket runtime types: ${problem}');
      }
    }
  }

  /**
   * A handler no contract validates gets the schema the manifest derived from its `@Payload` type; `PayloadArg` applies
   * it when no explicit schema does. JSON payloads are never coerced. One that cannot compile is a problem like any other.
   */
  protected bindDerived(manifest: Manifest, controllerName: string, label: string, descriptor: ISocketControllerDescriptor, handlers: IRegisteredHandler[]): void {
    const named = manifest.socketControllers.filter((c) => c.className === controllerName && c.prefix === (descriptor.Prefix ?? ''));
    if (named.length !== 1) return;

    const entry = named[0];
    const payloadOf = (handler: IRegisteredHandler): TypeRef | undefined =>
      handler.descriptor.Kind === 'command' ? entry.commands.find((c) => c.handler === String(handler.descriptor.Method))?.payload : entry.events.find((e) => e.name === handler.descriptor.Name)?.payload;

    const problems: string[] = [];
    for (const handler of handlers) {
      const id = handler.contractValidator || hasExplicitPayloadSchema(handler) ? undefined : payloadOf(handler)?.schema;
      if (id === undefined) continue;
      try {
        handler.payloadValidator = manifestValidatorOf(manifest).validator(id, { coerce: false });
      } catch (error) {
        problems.push(`the derived payload schema of ${handler.fullName} cannot be compiled: ${(error as Error).message}`);
      }
    }
    this.report(label, problems);
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
      return { entry, problems: [`contract ${id} is declared twice in the manifest (${found.map((c) => `${c.source.file}:${c.source.line}`).join(', ')}); give one of them a different id`] };
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
        return { validators: [], problem: `contract ${contract.id} cannot be enforced: the schema of ${handler.fullName} cannot be compiled, ${compileFailure(manifest, error)}` };
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
