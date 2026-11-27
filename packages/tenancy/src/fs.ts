import { realpathSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PassThrough } from 'node:stream';
import { Config, Configuration } from '@spinajs/configuration';
import { DI, Injectable, isConstructor } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { FsMiddleware, FsProviderLayer, fs, fsNative, normalizeFsPath, publishedFs } from '@spinajs/fs';
import type { FsActionContext, FsTarget, FsTargetSpec, IFileInfo, IFsUploadOptions, IStat, IWriteStreamOptions, IZipResult } from '@spinajs/fs';
import { TenantRequired } from './errors.js';
import { TENANCY_DEFAULTS } from './schema.js';
import { isTenantId, tenantScope } from './scope.js';

const PLACEHOLDER = '${tenant}';

type SignedUrlOptions = NonNullable<Parameters<fs['signedUrl']>[1]>;

export interface TenantFsSettings {
  /** Names of the providers whose files belong to one tenant each. */
  readonly prefixed: ReadonlySet<string>;
  /** Where a tenant's files live in a prefixed provider; ends with '/', holds `${tenant}` once. */
  readonly prefix: string;
  /** Per prefixed provider, the tenants with a provider of their own, by tenant id. */
  readonly dedicated: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface TenantFsTarget {
  readonly fs: fs;
  readonly path: string;
  /** The tenant's prefix on the wrapped provider, without the final '/'; absent on a dedicated provider. */
  readonly prefix?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function prefixOf(value: unknown): string {
  const prefix = typeof value === 'string' ? value : TENANCY_DEFAULTS.fs.prefix;
  if (prefix.split(PLACEHOLDER).length !== 2) throw new InvalidOption(`tenancy.fs.prefix ${prefix} must hold ${PLACEHOLDER} exactly once`);
  const segments = prefix.replace(PLACEHOLDER, 'tenant').split('/');
  if (prefix.startsWith('/') || prefix.includes('\\') || segments.some((s) => s === '.' || s === '..')) {
    throw new InvalidOption(`tenancy.fs.prefix ${prefix} must be a relative path with no '.' or '..' segment`);
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

// A dedicated provider that is listed itself, or that two tenants share, would show one tenant's files to another.
function dedicatedOf(value: unknown, prefixed: ReadonlySet<string>): Map<string, Map<string, string>> {
  const dedicated = new Map<string, Map<string, string>>();
  const owners = new Map<string, string>();
  for (const [provider, tenants] of Object.entries(isRecord(value) ? value : {})) {
    if (!isRecord(tenants)) continue;
    const own = new Map<string, string>();
    for (const [tenant, name] of Object.entries(tenants)) {
      if (!isTenantId(tenant) || typeof name !== 'string' || name === '') continue;
      const owner = owners.get(name);
      if (prefixed.has(name) || (owner !== undefined && owner !== tenant)) {
        throw new InvalidOption(`tenancy.fs.dedicated.${provider}.${tenant} names "${name}", which ${prefixed.has(name) ? 'tenancy.fs.prefixed lists' : `is dedicated to the tenant "${owner}" too`}: a dedicated provider belongs to one tenant`);
      }
      owners.set(name, tenant);
      own.set(tenant, name);
    }
    dedicated.set(provider, own);
  }
  return dedicated;
}

/** `tenancy.fs` with its defaults; throws InvalidOption for a prefix that could leave its provider or a shared dedicated provider. */
export function tenantFsSettings(value: unknown): TenantFsSettings {
  const section = isRecord(value) ? value : {};
  const prefixed = new Set(Array.isArray(section.prefixed) ? section.prefixed.filter((name): name is string => typeof name === 'string') : []);
  return { prefixed, prefix: prefixOf(section.prefix), dedicated: dedicatedOf(section.dedicated, prefixed) };
}

function tenantOf(provider: string): string {
  const scope = tenantScope();
  if (scope?.kind === 'tenant') return scope.tenant.id;
  throw new TenantRequired(
    scope
      ? `fs "${provider}" keeps files per tenant and this code runs across all tenants (${scope.reason}); enter one tenant with runInTenant()`
      : `fs "${provider}" keeps files per tenant and this code runs with no tenant scope; enter one with runInTenant()`,
  );
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * fsNative follows symbolic links, so a link below the tenant's root (planted outside the fs API) would lead to another
 * tenant's files. The nearest existing ancestor of the path must really lie at or under the root it lexically lies under.
 */
function assertNoLinkOut(t: TenantFsTarget, shown: string): void {
  const base = t.fs instanceof fsNative ? t.fs.BasePath : undefined;
  const realBase = base === undefined ? undefined : realpathOrUndefined(base);
  if (base === undefined || realBase === undefined) return;
  const root = t.prefix ?? '';
  let probe = t.path;
  let real = realpathOrUndefined(join(base, probe));
  while (real === undefined && probe !== '') {
    probe = probe.includes('/') ? probe.slice(0, probe.lastIndexOf('/')) : '';
    real = realpathOrUndefined(join(base, probe));
  }
  if (real !== undefined && !inside(join(realBase, probe.length >= root.length ? root : probe), real)) {
    throw new InvalidArgument(`fs path ${JSON.stringify(shown)} leads out of the tenant's files through a symbolic link`, 'path');
  }
}

/**
 * A prefixed provider as code sees it: paths are the application's own, and a file lands under the tenant's prefix of
 * the provider it wraps, or on the tenant's dedicated provider. Middlewares run on this provider with the application's
 * paths; the wrapped provider's actions run inside the action, below them, where no middleware runs again.
 */
export class TenantFs extends fs {
  constructor(
    public readonly inner: fs,
    private readonly settings: () => TenantFsSettings,
  ) {
    super();
  }

  public get Name(): string {
    return this.inner.Name;
  }

  public override get BasePath(): string | undefined {
    return this.inner.BasePath;
  }

  public resolvePath(path: string): string {
    const target = this.target(this.ownPath(path));
    return target.fs.resolvePath(target.path);
  }

  // A path this view returned (resolvePath, download, unzip) is absolute on the wrapped or the dedicated provider: it is
  // read relative to the tenant's root before the action normalises it, or it would be prefixed a second time.
  protected override runAction<R>(action: string, targets: readonly FsTargetSpec[], args: unknown[], impl: (targets: readonly FsTarget[], args: unknown[]) => Promise<R>, opts?: { stream?: boolean }): Promise<R> {
    try {
      return super.runAction(action, targets.map((spec) => ((spec.fs ?? this) === this ? { ...spec, path: this.ownPath(spec.path) } : spec)), args, impl, opts);
    } catch (err: unknown) {
      // A public action rejects rather than throws (fs runAction's own rule).
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private ownPath(raw: string): string {
    if (!isAbsolute(raw)) return raw;
    const root = this.target('');
    const base = root.fs.BasePath;
    const full = resolve(raw);
    const own = base === undefined ? undefined : join(base, root.path);
    return own !== undefined && inside(own, full) ? relative(own, full).split(sep).join('/') : raw;
  }

  public tmppath(ext?: string): string {
    return this.inner.tmppath(ext);
  }

  /** The provider and path `path` of the current tenant maps to; throws TenantRequired outside a tenant scope. */
  public target(raw: string): TenantFsTarget {
    const tenant = tenantOf(this.Name);
    // resolvePath() and target() are public and no action normalises their argument: 'x/../../beta/y' behind the prefix would name another tenant's file.
    const path = normalizeFsPath(raw, this.inner.BasePath);
    const settings = this.settings();
    const own = settings.dedicated.get(this.Name)?.get(tenant);
    let target: TenantFsTarget;
    if (own !== undefined) {
      const provider = publishedFs(own);
      if (provider === undefined) throw new InvalidOption(`tenancy.fs.dedicated.${this.Name}.${tenant} names the provider "${own}", which is not configured`);
      target = { fs: provider, path };
    } else {
      const prefix = settings.prefix.replace(PLACEHOLDER, tenant);
      target = { fs: this.inner, path: `${prefix}${path}`.replace(/\/$/, ''), prefix: prefix.slice(0, -1) };
    }
    assertNoLinkOut(target, raw);
    return target;
  }

  protected doDownload(path: string): Promise<string> {
    const t = this.target(path);
    return t.fs.download(t.path);
  }

  protected async doUpload(srcPath: string, destPath: string, options?: IFsUploadOptions): Promise<void> {
    const t = await this.writable(destPath);
    this.assertOwnSource(srcPath);
    return t.fs.upload(srcPath, t.path, options);
  }

  protected doRead(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const t = this.target(path);
    return t.fs.read(t.path, encoding);
  }

  protected doReadStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    const t = this.target(path);
    return t.fs.readStream(t.path, encoding);
  }

  protected async doWrite(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const t = await this.writable(path);
    return t.fs.write(t.path, data, encoding);
  }

  protected async doWriteStream(path: string, readStream: NodeJS.ReadableStream | undefined, options: IWriteStreamOptions): Promise<WriteStream | PassThrough> {
    const t = await this.writable(path);
    return readStream === undefined ? t.fs.writeStream(t.path, options) : t.fs.writeStream(t.path, readStream, options);
  }

  protected async doAppend(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const t = await this.writable(path);
    return t.fs.append(t.path, data, encoding);
  }

  protected doExists(path: string): Promise<boolean> {
    const t = this.target(path);
    return t.fs.exists(t.path);
  }

  protected doDirExists(path: string): Promise<boolean> {
    const t = this.target(path);
    return t.fs.dirExists(t.path);
  }

  protected doStat(path: string): Promise<IStat> {
    const t = this.target(path);
    return t.fs.stat(t.path);
  }

  protected doIsDir(path: string): Promise<boolean> {
    const t = this.target(path);
    return t.fs.isDir(t.path);
  }

  protected async doList(path: string): Promise<string[]> {
    const t = this.target(path);
    // A tenant that never wrote has no prefix directory yet: it has no entries.
    if (t.prefix !== undefined && !(await t.fs.dirExists(t.prefix))) return [];
    return t.fs.list(t.path);
  }

  protected override doHasEntries(path: string): Promise<boolean> {
    const t = this.target(path);
    return t.fs.hasEntries(t.path);
  }

  protected async doMkdir(path: string): Promise<void> {
    const t = await this.writable(path);
    return t.fs.mkdir(t.path);
  }

  protected doRm(path: string): Promise<void> {
    const t = this.target(path);
    return t.fs.rm(t.path);
  }

  protected async doCopy(path: string, dest: string, dstFs?: fs): Promise<void> {
    const source = this.target(path);
    if (dstFs !== undefined && dstFs !== this) return source.fs.copy(source.path, dest, dstFs);
    const target = await this.writable(dest);
    return target.fs === source.fs ? source.fs.copy(source.path, target.path) : source.fs.copy(source.path, target.path, target.fs);
  }

  protected async doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    const source = this.target(oldPath);
    if (dstFs !== undefined && dstFs !== this) return source.fs.move(source.path, newPath, dstFs);
    const target = await this.writable(newPath);
    return target.fs === source.fs ? source.fs.move(source.path, target.path) : source.fs.move(source.path, target.path, target.fs);
  }

  protected async doRename(oldPath: string, newPath: string): Promise<void> {
    const source = this.target(oldPath);
    const target = await this.writable(newPath);
    return source.fs.rename(source.path, target.path);
  }

  protected doZip(path: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult> {
    const owner = this.target('').fs;
    if (!Array.isArray(path)) return owner.zip(this.target(path).path, dstFs, dstFile);
    const mapped = path.map((entry) => (Array.isArray(entry) ? [this.target(entry[0]).path, ...entry.slice(1)] : this.target(entry).path));
    return owner.zip(mapped, dstFs, dstFile);
  }

  protected doUnzip(srcPath: string, destPath: string, dstFs: fs): Promise<string> {
    const source = this.target(srcPath);
    return source.fs.unzip(source.path, destPath, dstFs);
  }

  protected override doHash(path: string, algo?: string): Promise<string> {
    const t = this.target(path);
    return t.fs.hash(t.path, algo);
  }

  protected override doMetadata(path: string): Promise<IFileInfo> {
    const t = this.target(path);
    return t.fs.metadata(t.path);
  }

  protected doSignedUrl(path: string, opts: SignedUrlOptions): Promise<string> {
    const t = this.target(path);
    return t.fs.signedUrl(t.path, opts);
  }

  // Made before every write: a local provider creates no parent directory, and an operator may remove the prefix.
  private async writable(path: string): Promise<TenantFsTarget> {
    const target = this.target(path);
    if (target.prefix !== undefined) await target.fs.mkdir(target.prefix);
    return target;
  }

  // upload() takes a local path unchecked (copy and move between providers pass one too): inside a tenant provider's
  // directory it must be the current tenant's own file.
  private assertOwnSource(srcPath: string): void {
    const real = realpathOrUndefined(resolve(srcPath));
    if (real === undefined) return;
    const tenant = tenantOf(this.Name);
    const { prefixed, prefix, dedicated } = this.settings();
    const areas: Array<[string, string | undefined]> = [];
    for (const name of prefixed) {
      const tenants = dedicated.get(name) ?? new Map<string, string>();
      areas.push([name, tenants.has(tenant) ? undefined : prefix.replace(PLACEHOLDER, tenant)]);
      for (const [owner, own] of tenants) areas.push([own, owner === tenant ? '' : undefined]);
    }
    for (const [name, own] of areas) {
      const provider = publishedFs(name);
      const base = provider instanceof fsNative && provider.BasePath !== undefined ? realpathOrUndefined(provider.BasePath) : undefined;
      if (base !== undefined && inside(base, real) && (own === undefined || !inside(join(base, own), real))) {
        throw new InvalidArgument(`upload source ${JSON.stringify(srcPath)} lies in the files of fs "${name}" outside this tenant's own`, 'srcPath');
      }
    }
  }
}

// The file ACL of authz-fs is keyed by provider name and path, with no tenant: one grant would act in every tenant.
function refuseGuardedProviders(prefixed: ReadonlySet<string>, authzFs: unknown): void {
  if (!isRecord(authzFs)) return;
  for (const name of prefixed) {
    const entry = new Map(Object.entries(authzFs)).get(name);
    const mode: unknown = isRecord(entry) ? entry.mode : undefined;
    if (mode === 'audit' || mode === 'enforce') {
      throw new InvalidOption(
        `tenancy.fs.prefixed lists "${name}", which @spinajs/authz-fs guards (authz.fs.${name}.mode is "${mode}"). The file ACL of authz-fs has no tenant, so a grant, an owner or a removal in one tenant would act on the same path in every tenant, and authz-fs refuses the file ACL of a listed provider in every mode. Keep files that need file ACLs on a provider that is not listed in tenancy.fs.prefixed.`,
      );
    }
  }
}

interface FrameworkUse {
  readonly upload: unknown;
  readonly emailTemplates: unknown;
  readonly logTargets: unknown;
  readonly providers: unknown;
}

function logTargetUses(targets: unknown, uses: Map<string, string>): void {
  for (const [i, target] of (Array.isArray(targets) ? targets : []).entries()) {
    const options: unknown = isRecord(target) ? target.options : undefined;
    for (const [key, name] of Object.entries(isRecord(options) ? { fs: options.fs, archiveFs: options.archiveFs } : {})) {
      if (typeof name === 'string') uses.set(name, `logger.targets[${i}].options.${key} names it`);
    }
  }
}

// Each of these reads and writes its provider outside any tenant scope, and @spinajs/upload through publishedFs(), past every layer.
function frameworkUses(use: FrameworkUse): Map<string, string> {
  const uses = new Map<string, string>();
  for (const [key, name] of Object.entries(isRecord(use.upload) ? use.upload : {})) if (typeof name === 'string') uses.set(name, `upload.fs.${key} names it`);
  if (typeof use.emailTemplates === 'string') uses.set(use.emailTemplates, 'email.templateFs names it');
  logTargetUses(use.logTargets, uses);
  for (const entry of Array.isArray(use.providers) ? use.providers : []) {
    if (!isRecord(entry) || entry.service !== 'fsTemp') continue;
    if (typeof entry.name === 'string') uses.set(entry.name, 'it is a temporary file system (fsTemp)');
    if (typeof entry.provider === 'string') uses.set(entry.provider, `it is the backend of the temporary file system "${String(entry.name)}"`);
  }
  return uses;
}

function refuseFrameworkProviders(prefixed: ReadonlySet<string>, use: FrameworkUse): void {
  const uses = frameworkUses(use);
  for (const name of prefixed) {
    const reason = name.startsWith('__fs_') ? 'the framework keeps its own files there (a name that starts with __fs_)' : uses.get(name);
    if (reason !== undefined) {
      throw new InvalidOption(`tenancy.fs.prefixed lists "${name}", which the framework uses outside any tenant scope: ${reason}. Its files would be refused with TenantRequired or land unscoped; keep it off tenancy.fs.prefixed.`);
    }
  }
}

const isTenantLayerClass = (type: unknown): boolean => isConstructor(type) && (type === TenantFsLayer || type.prototype instanceof TenantFsLayer);

/**
 * Layers apply in registration order: one after TenantFsLayer could hand out the shared provider in place of the view.
 * DI registers one class per name, so a class of the same name registered first silently takes TenantFsLayer's place.
 */
function assertTenantFsLayerLast(): void {
  const layers = DI.RootContainer.getRegisteredTypes(Array.ofType(FsProviderLayer)) ?? [];
  const at = layers.findIndex((type) => type === TenantFsLayer);
  if (at === -1) throw new InvalidOption('tenancy.fs.prefixed lists providers, but the root container registers no TenantFsLayer of @spinajs/tenancy/fs as an FsProviderLayer (a class of the same name registered before it takes its place)');
  const later = layers.slice(at + 1).filter((type) => !isTenantLayerClass(type));
  if (later.length > 0) {
    throw new InvalidOption(`tenancy.fs.prefixed lists providers, and the FsProviderLayer ${later.map((type) => (isConstructor(type) ? type.name : 'a factory')).join(', ')} is registered after TenantFsLayer: it could hand out a provider in place of the tenant's view. Register it before @spinajs/tenancy/fs is imported.`);
  }
}

/** Hands out a `TenantFs` for every provider listed in `tenancy.fs.prefixed`. */
@Injectable(FsProviderLayer)
export class TenantFsLayer extends FsProviderLayer {
  @Config('tenancy.fs', { defaultValue: {} })
  protected Section!: unknown;

  @Config('authz.fs', { defaultValue: {} })
  protected AuthzFs!: unknown;

  @Config('upload.fs', { defaultValue: {} })
  protected UploadFs!: unknown;
  @Config('email.templateFs')
  protected EmailTemplateFs!: unknown;
  @Config('logger.targets', { defaultValue: [] })
  protected LogTargets!: unknown;
  @Config('fs.providers', { defaultValue: [] })
  protected Providers!: unknown;

  private readonly views = new Map<string, TenantFs>();

  constructor() {
    super();
    // fsService resolves the layers at the end of its boot: a configuration this layer refuses fails the boot there.
    if (DI.get(Configuration) !== undefined) this.settings();
  }

  public wrap(provider: fs): fs {
    if (!(provider instanceof fs)) throw new InvalidOperation('TenantFsLayer.wrap() takes an fs provider');
    if (provider instanceof TenantFs || !this.settings().prefixed.has(provider.Name)) return provider;
    const known = this.views.get(provider.Name);
    if (known?.inner === provider) return known;
    const view = new TenantFs(provider, () => this.settings());
    this.views.set(provider.Name, view);
    return view;
  }

  /**
   * `tenancy.fs`, checked against the rest of the configuration, on every call: a nested config.set() changes a section
   * in place, so no object identity tells that it changed.
   */
  public settings(): TenantFsSettings {
    const settings = tenantFsSettings(this.Section);
    if (settings.prefixed.size === 0) return settings;
    refuseGuardedProviders(settings.prefixed, this.AuthzFs);
    refuseFrameworkProviders(settings.prefixed, { upload: this.UploadFs, emailTemplates: this.EmailTemplateFs, logTargets: this.LogTargets, providers: this.Providers });
    assertTenantFsLayerLast();
    return settings;
  }
}

/**
 * Refuses an action on a prefixed provider outside a tenant scope, before any other middleware runs; inside a tenant, an
 * action that reaches tenants' files without the view (a listed provider's shared files through publishedFs() or a kept
 * instance, a dedicated provider by its own name), and an unzip into a tenant's whole root (defence in depth: the
 * extractor skips '../' entries; lifted once `@spinajs/fs` checks entry names itself).
 */
@Injectable(FsMiddleware)
export class TenantFsGuard extends FsMiddleware {
  public override order = -1000;

  @Config('tenancy.fs', { defaultValue: {} })
  protected Section!: unknown;

  public override isEnabled(provider: fs): boolean {
    return provider instanceof TenantFs || this.tenantFiles(provider.Name);
  }

  public before(ctx: FsActionContext): Promise<void> {
    const providers = [ctx.fs, ...ctx.targets.map((target) => target.fs)];
    const scope = tenantScope();
    const tenant = scope?.kind === 'tenant' ? scope.tenant.id : undefined;
    const shared = providers.filter((provider) => !(provider instanceof TenantFs) && this.tenantFiles(provider.Name));
    if (shared.length > 0) assertTenantFsLayerLast();
    for (const provider of providers) {
      if (provider instanceof TenantFs) tenantOf(provider.Name);
    }
    if (shared.length > 0 && tenant !== undefined) {
      throw new InvalidOperation(`fs "${shared[0].Name}" holds tenants' files, and this ${ctx.action} in tenant "${tenant}" reached them without the tenant's view (publishedFs(), a kept instance or a dedicated provider's own name); use getFs() of the listed provider`);
    }
    const destination = ctx.action === 'unzip' ? ctx.targets[1] : undefined;
    const mapped = destination?.fs instanceof TenantFs ? destination.fs.target(destination.path) : undefined;
    if (mapped !== undefined && mapped.path === (mapped.prefix ?? '')) {
      throw new InvalidOperation(`fs "${mapped.fs.Name}": unzip into a directory below the tenant's root, not into the root itself`);
    }
    return Promise.resolve();
  }

  // A listed provider's shared files, and every dedicated provider: inside a tenant both are reached through the view only.
  private tenantFiles(name: string): boolean {
    const { prefixed, dedicated } = tenantFsSettings(this.Section);
    return prefixed.has(name) || [...dedicated.values()].some((own) => [...own.values()].includes(name));
  }
}
