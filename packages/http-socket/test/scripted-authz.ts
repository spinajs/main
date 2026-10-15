import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthzDomains, AuthzService, FALSE, ResourceAdapter, TRUE } from '@spinajs/authz';
import type { AccessPlan, AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';

function unused(member: string): never {
  throw new Error(`${member} is not used by socket tests`);
}

/** What one check answers; the rest of the Decision is filled in. */
export type ScriptedDecision = Partial<Omit<Decision, 'allowed'>> & { readonly allowed: boolean };

/** A scripted AuthzService for socket tests: `script` answers every check, `checks` records them. */
export class ScriptedSocketAuthz extends AuthzService {
  public static script: (input: CheckInput, domain: string) => ScriptedDecision = () => ({ allowed: false });

  public static checks: Array<{ domain: string; input: CheckInput }> = [];

  public domain = 'root';

  public async check(input: CheckInput): Promise<Decision> {
    ScriptedSocketAuthz.checks.push({ domain: this.domain, input });
    const answer = ScriptedSocketAuthz.script(input, this.domain);

    return {
      permission: input.permission,
      resource: (input.resource ?? { type: 'none' }) as ResourceRef,
      principal: { type: input.principal.type, id: input.principal.id },
      residual: answer.allowed ? TRUE : FALSE,
      fields: { read: ['*'], write: ['*'] },
      roles: {},
      domain: this.domain,
      ...(answer.allowed ? {} : { reason: { code: 'no_access', model: 'm1' } }),
      ...answer,
    };
  }

  public current(): Principal {
    return unused('ScriptedSocketAuthz.current');
  }

  public runAs<T>(): Promise<T> {
    return unused('ScriptedSocketAuthz.runAs');
  }

  public can(): Promise<boolean> {
    return unused('ScriptedSocketAuthz.can');
  }

  public assert(): Promise<Decision> {
    return unused('ScriptedSocketAuthz.assert');
  }

  public checkMany(): Promise<ReadonlyMap<Permission, Decision>> {
    return unused('ScriptedSocketAuthz.checkMany');
  }

  public checkAll(): Promise<readonly Decision[]> {
    return unused('ScriptedSocketAuthz.checkAll');
  }

  public accessPlan(): Promise<AccessPlan> {
    return unused('ScriptedSocketAuthz.accessPlan');
  }

  public filter(): Promise<ResourceFilter> {
    return unused('ScriptedSocketAuthz.filter');
  }

  public filterNow(): ResourceFilter | undefined {
    return unused('ScriptedSocketAuthz.filterNow');
  }

  public explain(): Promise<Decision> {
    return unused('ScriptedSocketAuthz.explain');
  }

  public summary(): Promise<AccessSummary> {
    return unused('ScriptedSocketAuthz.summary');
  }

  public covers(): Promise<boolean> {
    return unused('ScriptedSocketAuthz.covers');
  }

  public preload(): Promise<void> {
    return unused('ScriptedSocketAuthz.preload');
  }

  public invalidate(): void {
    unused('ScriptedSocketAuthz.invalidate');
  }

  public models(): readonly AuthorizationModel[] {
    return unused('ScriptedSocketAuthz.models');
  }

  public admin(): AuthzAdmin {
    return unused('ScriptedSocketAuthz.admin');
  }
}

/** Named domains answer through ScriptedSocketAuthz; `container()` holds `adapters`, which `subject: 'load'` asks for rows. */
export class ScriptedSocketDomains extends AuthzDomains {
  public static adapters: Array<new () => ResourceAdapter> = [];

  public async service(name: string): Promise<AuthzService> {
    const service = new ScriptedSocketAuthz();
    service.domain = name;
    return service;
  }

  public create(): IContainer {
    return unused('ScriptedSocketDomains.create');
  }

  public container(): IContainer {
    const container = DI.RootContainer.child();
    for (const adapter of ScriptedSocketDomains.adapters) {
      container.register(adapter).as(ResourceAdapter);
    }
    return container;
  }

  public names(): readonly string[] {
    return ['root', 'tenant'];
  }
}
