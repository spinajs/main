import { Autoinject, ClassInfo, Container, IContainer, Injectable, Singleton } from '@spinajs/di';
import { effectiveManifestOf } from '@spinajs/configuration';
import { controllerMountPath, ownEntries, type ControllerEntry, type RouteEntry } from '@spinajs/manifest';
import type { BaseController } from './base-controller.js';
import { ControllerMetadataProvider } from './controller-metadata.js';
import { parseFnParamNames } from './cache-helpers.js';
import type { IControllerDocumentation, IMethodDoc, IResponseDoc } from './controller-documentation.js';

/** The compiler records the whole comment as the description; the cache splits off its first line as the summary. */
function summaryOf(summary: string | undefined, description: string | undefined): Pick<IMethodDoc, 'summary' | 'description'> {
  if (summary !== undefined || description === undefined) {
    return { summary, description };
  }
  const [first, ...rest] = description.split(/\r?\n/);
  return { summary: first.trim(), description: rest.join('\n').trim() || undefined };
}

function declaredParameters(controller: ClassInfo<BaseController>, method: string): string[] {
  const owner = (controller.instance ?? (controller.type as { prototype?: object } | undefined)?.prototype) as Record<string, unknown> | undefined;
  const handler = owner?.[method];
  return typeof handler === 'function' ? parseFnParamNames(handler as (...args: never[]) => unknown) : [];
}

/** Parameter names and documentation recorded by the compiler, for the controllers the effective manifest lists. */
@Singleton()
@Injectable(ControllerMetadataProvider)
export class ManifestControllerMetadata extends ControllerMetadataProvider {
  public readonly Priority = 10;

  @Autoinject(Container)
  protected Container!: IContainer;

  /** Matched like request validation matches routes: by class name, and by file or mount path when the name is taken twice. */
  protected entry(controller: ClassInfo<BaseController>): ControllerEntry | undefined {
    const effective = effectiveManifestOf(this.Container);
    if (!effective?.manifest || effective.settings.mode === 'off') {
      return undefined;
    }

    const candidates = effective.manifest.controllers.filter((c) => c.className === controller.name);
    const mountPath = controller.instance?.BasePath;
    const own = ownEntries(candidates, { file: controller.file, matches: (c) => (c.mountPath ?? controllerMountPath(c.basePath, c.className)) === mountPath }, effective.manifest);
    return own.length === 1 ? own[0] : undefined;
  }

  public supports(controller: ClassInfo<BaseController>): boolean {
    return this.entry(controller) !== undefined;
  }

  /**
   * The compiler records only the argument decorators it knows; an argument under another one ( orm-http's `@Filter`,
   * `@CurrentUser`, an app's own `Parameter()` decorator ) has no entry and keeps the name the handler declares.
   */
  public parameters(controller: ClassInfo<BaseController>, method: string): Promise<string[]> {
    const route = this.entry(controller)?.routes.find((r) => r.handler === method);
    if (!route) {
      return Promise.resolve([]);
    }

    const recorded: string[] = [];
    for (const param of route.params) {
      recorded[param.index] = param.name;
    }
    const declared = declaredParameters(controller, method);
    return Promise.resolve(Array.from({ length: Math.max(recorded.length, declared.length) }, (_, i) => recorded[i] || declared[i] || ''));
  }

  public documentation(controller: ClassInfo<BaseController>): Promise<IControllerDocumentation> {
    const entry = this.entry(controller);
    if (!entry) {
      return Promise.resolve({ className: controller.name, methods: {} });
    }

    const methods: Record<string, IMethodDoc> = {};
    for (const route of entry.routes) {
      methods[route.handler] = this.methodDoc(route);
    }
    return Promise.resolve({ className: entry.className, methods });
  }

  /**
   * Shaped like the cache's documentation, which the JSDoc builder reads: the first comment line is the summary unless
   * `@summary` gives one. Parameters carry no `type`: the cache sets it only from a JSDoc `{Type}`, and the builder
   * takes it over the runtime type. No `returns`: the manifest has a display name or a derived schema id, neither of
   * which the builder reads.
   */
  protected methodDoc(route: RouteEntry): IMethodDoc {
    const params: IMethodDoc['params'] = {};
    for (const p of route.params) {
      params[p.name] = { name: p.name };
    }

    const responses: Record<string, IResponseDoc> = {};
    for (const r of route.doc?.responses ?? []) {
      responses[String(r.status)] = r.type ? { description: r.description ?? '', type: r.type.text } : { description: r.description ?? '' };
    }

    return {
      ...summaryOf(route.doc?.summary, route.doc?.description),
      params,
      responses: Object.keys(responses).length > 0 ? responses : undefined,
      tags: route.doc?.tags,
      deprecated: route.doc?.deprecated,
    };
  }
}
