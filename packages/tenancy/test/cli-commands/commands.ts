import { CliCommand, Command, Option } from '@spinajs/cli';
import { requireTenant, tenantScope } from '../../src/index.js';
import { observed } from '../support/cli-observed.js';

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Command('scope', 'records the tenant scope it runs in')
export class ScopeCommand extends CliCommand {
  public override onPreAction(): void {
    observed.preAction.push(tenantScope());
  }

  public async execute(): Promise<void> {
    const atStart = tenantScope();
    // work the command starts and does not wait for
    observed.detached = tick(20).then(() => tenantScope());
    await tick(1);
    observed.runs.push({ command: 'scope', atStart, afterAwait: tenantScope() });
  }
}

@Command('needs-tenant', 'touches tenant data')
export class NeedsTenantCommand extends CliCommand {
  public execute(): Promise<void> {
    observed.runs.push({ command: 'needs-tenant', atStart: { kind: 'tenant', tenant: requireTenant() }, afterAwait: undefined });
    return Promise.resolve();
  }
}

@Command('throws', 'fails before its body does anything')
export class ThrowingCommand extends CliCommand {
  public execute(): Promise<void> {
    throw new Error(`thrown in ${JSON.stringify(tenantScope() ?? null)}`);
  }
}

// Declares the program's option name itself, with a default: the default must never become the tenant.
@Command('own-tenant', 'declares --tenant of its own')
@Option('--tenant <id>', false, 'its own tenant option', 'acme')
export class OwnTenantOptionCommand extends CliCommand {
  public execute(options: { tenant?: string }): Promise<void> {
    observed.runs.push({ command: `own-tenant:${options.tenant ?? ''}`, atStart: tenantScope(), afterAwait: undefined });
    return Promise.resolve();
  }
}
