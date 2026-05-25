import { AsyncService, Autoinject, ClassInfo, Singleton } from '@spinajs/di';
import { DefaultControllerCache, IMethodDoc, IPolicyDoc } from '@spinajs/http';
import { BaseController } from '@spinajs/http';
import { Logger, Log } from '@spinajs/log';
import { ISwaggerCacheEntry } from './interfaces.js';

/**
 * Provides JSDoc / TypeScript-annotation documentation for controllers.
 * Delegates all TypeScript parsing to DefaultControllerCache (http package),
 * which already runs during HTTP module resolution — no extra parse pass needed.
 */
@Singleton()
export class SwaggerDocCache extends AsyncService {
  @Logger('http-swagger')
  protected Log!: Log;

  @Autoinject(DefaultControllerCache)
  protected ControllerCache!: DefaultControllerCache;

  public async resolve() {
    await super.resolve();
  }

  public async getCache(controller: ClassInfo<BaseController>): Promise<ISwaggerCacheEntry> {
    this.Log.trace(`Getting swagger doc cache for ${controller.name}`);
    const doc = await this.ControllerCache.getDocumentation(controller);

    // Walk runtime descriptors to learn which policy classes are applied where
    // (.d.ts strips decorators, so we can only get this from the live class).
    const descriptor = controller.instance?.Descriptor;
    const controllerPolicies: string[] = [];
    const routePolicies: Record<string, string[]> = {};
    const allPolicyNames = new Set<string>();

    if (descriptor) {
      for (const p of descriptor.Policies ?? []) {
        const name = this.policyName(p?.Type);
        if (name) {
          controllerPolicies.push(name);
          allPolicyNames.add(name);
        }
      }
      for (const [methodName, route] of descriptor.Routes ?? []) {
        const names: string[] = [];
        for (const p of route?.Policies ?? []) {
          const n = this.policyName(p?.Type);
          if (n) {
            names.push(n);
            allPolicyNames.add(n);
          }
        }
        if (names.length > 0) routePolicies[String(methodName)] = names;
      }
    }

    let policies: Record<string, IPolicyDoc> | undefined;
    if (allPolicyNames.size > 0) {
      policies = await this.ControllerCache.getPolicyDocumentation(controller, [...allPolicyNames]);
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
