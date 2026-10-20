import { GLOBAL, resourceKey } from '@spinajs/authz';
import type { Decision, Principal } from '@spinajs/authz';
import { Argument, Command, Option } from '@spinajs/cli';

import { parsePrincipalRef, parseResourceRef } from '../args.js';
import { AuthzCliCommand } from '../base.js';

interface ExplainOptions {
  json?: boolean;
}

const compact = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

@Command('authz:explain', 'Explains why a principal is allowed or denied a permission')
@Argument('principal', true, 'principal as <type>:<id>')
@Argument('permission', true, 'permission name')
@Argument('resource', false, 'resource as <type>:<id>; default is global')
@Option('--json', false, 'print the raw Decision as JSON')
export class ExplainCommand extends AuthzCliCommand {
  public async execute(principal: string, permission: string, resource?: string, options: ExplainOptions = {}): Promise<void> {
    await this.command(
      () => ({
        principal: { ...parsePrincipalRef(principal), authenticated: true, source: 'cli', attributes: {} } as Principal,
        permission,
        resource: resource === undefined ? GLOBAL : parseResourceRef(resource),
      }),
      async (req) => {
        const decision = await (await this.authz()).explain(req);
        if (options.json) this.out(JSON.stringify(decision, null, 2));
        else this.print(decision);
      },
    );
  }

  private print(d: Decision): void {
    this.out(`${d.allowed ? 'ALLOWED' : 'DENIED'}: ${d.principal.type}:${d.principal.id} ${d.permission} on ${resourceKey(d.resource)}`);
    if (d.reason) {
      const { code, model, ...rest } = d.reason;
      this.out(`reason: ${code}${model ? ` (${model})` : ''}${Object.keys(rest).length > 0 ? ` ${compact(rest)}` : ''}`);
    }
    const roles = Object.entries(d.roles);
    if (roles.length > 0) this.out(`roles: ${roles.map(([ladder, role]) => `${ladder}=${role}`).join(', ')}`);
    if (d.fields.read.length > 0 || d.fields.write.length > 0) this.out(`fields: read [${d.fields.read.join(', ')}], write [${d.fields.write.join(', ')}]`);

    const t = d.trace;
    if (!t) return;
    this.out(`trace (domain ${t.domain}, ${t.algorithm}, ${t.durationMs} ms), models: ${t.models.join(', ') || 'none'}`);
    for (const s of t.steps) this.out(`  [${s.by}] ${s.step}: ${s.note}`);
    for (const v of t.votes) {
      const verdict = v.error ? `error: ${v.error}` : v.reason ? `no permit: ${v.reason.code}` : 'permit';
      this.out(`  vote ${v.model}: ${verdict}${v.roles ? ` roles ${compact(v.roles)}` : ''}`);
      for (const s of v.trace ?? []) this.out(`    [${s.by}] ${s.step}: ${s.note}`);
    }
  }
}
