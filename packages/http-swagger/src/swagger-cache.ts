import { AsyncService, Autoinject, ClassInfo, Container, IContainer, Singleton } from '@spinajs/di';
import { BaseController, CacheControllerMetadata, ControllerMetadataProvider, IMethodDoc, IPolicyDoc, NoControllerMetadata, metadataProviderFor } from '@spinajs/http';
import { Logger, Log } from '@spinajs/log';
import { ISwaggerCacheEntry } from './interfaces.js';

/**
 * Documentation for controllers from the first `ControllerMetadataProvider` that supports them: the manifest when it
 * lists the controller, else the TypeScript cache the loader already filled while registering routes.
 */
@Singleton()
export class SwaggerDocCache extends AsyncService {
  @Logger('http-swagger')
  protected Log!: Log;

  @Autoinject(Container)
  protected Container!: IContainer;

  public async resolve() {
    await super.resolve();
  }

  protected async providerFor(controller: ClassInfo<BaseController>): Promise<ControllerMetadataProvider> {
    const provider = metadataProviderFor(await this.Container.resolve(Array.ofType(ControllerMetadataProvider)), controller);
    if (!provider) {
      throw new NoControllerMetadata(`No controller metadata provider supports ${controller.name} ( ${controller.file} )`);
    }
    return provider;
  }

  public async getCache(controller: ClassInfo<BaseController>): Promise<ISwaggerCacheEntry> {
    this.Log.trace({ controller: controller.name }, 'Getting swagger doc cache for ${controller}');
    const provider = await this.providerFor(controller);
    const doc = await provider.documentation(controller);

    // Walk runtime descriptors to learn which policy classes are applied where
    // (.d.ts strips decorators, so we can only get this from the live class).
    const descriptor = controller.instance?.Descriptor;
    const controllerPolicies: string[] = [];
    const routePolicies: Record<string, string[]> = {};
    const allPolicyNames = new Set<string>();

    // Policies arrive grouped, one group per @Policy() call (AND inside a
    // group, OR between groups). The document lists which policies apply
    // without claiming how they combine, so the groups are flattened here.
    if (descriptor) {
      for (const p of (descriptor.Policies ?? []).flat()) {
        const name = this.policyName(p?.Type);
        if (name) {
          controllerPolicies.push(name);
          allPolicyNames.add(name);
        }
      }
      for (const [methodName, route] of descriptor.Routes ?? []) {
        const names: string[] = [];
        for (const p of (route?.Policies ?? []).flat()) {
          const n = this.policyName(p?.Type);
          if (n) {
            names.push(n);
            allPolicyNames.add(n);
          }
        }
        if (names.length > 0) routePolicies[String(methodName)] = names;
      }
    }

    // policy docs are read from the policy classes' sources, which only the cache provider parses
    let policies: Record<string, IPolicyDoc> | undefined;
    if (allPolicyNames.size > 0 && provider instanceof CacheControllerMetadata) {
      policies = await provider.policyDocumentation(controller, [...allPolicyNames]);
    }

    return {
      className: doc.className,
      classDescription: doc.classDescription,
      classTags: doc.classTags,
      methods: Object.fromEntries(
        Object.entries(doc.methods).map(([name, m]: [string, IMethodDoc]) => [
          name,
          {
            summary: m.summary,
            description: m.description,
            params: m.params,
            returns: m.returns
              ? {
                  description: m.returns.description,
                  type: m.returns.type,
                  schema: m.returns.schema as any,
                }
              : undefined,
            body: m.body,
            responses: m.responses,
            examples: m.examples,
            tags: m.tags,
            deprecated: m.deprecated,
            security: m.security,
          },
        ]),
      ),
      controllerPolicies: controllerPolicies.length > 0 ? controllerPolicies : undefined,
      routePolicies: Object.keys(routePolicies).length > 0 ? routePolicies : undefined,
      policies,
    };
  }

  private policyName(type: unknown): string | undefined {
    if (!type) return undefined;
    if (typeof type === 'string') return type;
    if (typeof type === 'function') return (type as { name?: string }).name || undefined;
    return undefined;
  }
}
