import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { AuthzDomains } from '@spinajs/authz';
import type { PolicyIR } from '@spinajs/authz-ir';
import { Command, Option } from '@spinajs/cli';

import { recordPolicyVersion } from '../../changelog/policy-version.js';
import { ormDomain } from '../../host.js';
import { compileDomainPolicy } from '../../policy/compile.js';
import { AuthzOrmCliCommand } from '../base.js';

interface CompileOptions {
  readonly out?: string;
  readonly domain?: string;
  readonly live?: boolean;
  readonly check?: boolean;
  readonly record?: boolean;
}

type AuthzIr = typeof import('@spinajs/authz-ir');

@Command('authz:compile', 'Compiles the authorization models of the app into the canonical policy IR (authz.ir.json) and prints its policy hash')
@Option('-o, --out <path>', false, 'file the policy IR is written to', 'authz.ir.json')
@Option('--domain <name>', false, 'authz domain whose models are compiled; default authz.orm.domain')
@Option('--live', false, 'compile the policy held in database stores too (the effective policy); its hash is not a policy version')
@Option('--check', false, 'write nothing; exit code 1 when the file holds a different policy')
@Option('--record', false, 'store the policy in authz_policy_version, as a booting app with a decision log does')
export class CompileCommand extends AuthzOrmCliCommand {
  public async execute(options: CompileOptions): Promise<void> {
    await this.command(
      () => {
        if (options.live === true && options.record === true) throw new Error('authz:compile: --record stores policy versions, which never include stored policy; drop --live');
        return { out: resolve(options.out ?? 'authz.ir.json'), domain: options.domain ?? ormDomain(), stored: options.live === true ? ('include' as const) : ('opaque' as const) };
      },
      async ({ out, domain, stored }) => {
        const ir = await import('@spinajs/authz-ir');
        const service = await (await this.Container.resolve(AuthzDomains)).service(domain);
        const policy = await compileDomainPolicy(domain, service, { stored });
        for (const c of policy.conflicts) this.out(`conflict ${c.path}: ${c.message}`);
        const invalid = ir.validateIR(policy.ir);
        for (const d of invalid) this.out(`invalid ${d.code} ${d.path}: ${d.message}`);
        if (invalid.length > 0) throw new Error(`authz:compile: the policy IR of domain ${domain} is invalid; nothing written`);
        if (options.check === true) {
          const reason = await this.staleReason(out, policy.hash, ir);
          if (reason !== undefined) throw new Error(`authz:compile: ${out} is stale (${reason}); run spinajs authz:compile`);
          this.out(`up to date ${policy.hash}`);
          return;
        }
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, `${JSON.stringify(JSON.parse(policy.canonical), null, 2)}\n`);
        this.out(`wrote ${out}`);
        this.out(`policyHash ${policy.hash}${stored === 'include' ? ' (effective policy, not a policy version)' : ''}`);
        const opaque = policy.ir.opaque.map((o) => o.name);
        this.out(`opaque ${opaque.length}${opaque.length > 0 ? `: ${opaque.join(', ')}` : ''}`);
        if (options.record === true) this.out((await recordPolicyVersion(policy.hash, policy.canonical)) ? `recorded ${policy.hash}` : `already recorded ${policy.hash}`);
      },
    );
  }

  /** Why `file` does not hold the compiled policy, or undefined when it does. */
  private async staleReason(file: string, hash: string, ir: AuthzIr): Promise<string | undefined> {
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) return 'missing';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 'not valid JSON';
    }
    try {
      // validateIR and canonicalize expect schema-valid input: on JSON that is not a policy IR they throw instead of reporting.
      const invalid = ir.validateIR(parsed as PolicyIR);
      if (invalid.length > 0) return `invalid IR: ${invalid.map((d) => d.code).join(', ')}`;
      const existing = ir.policyHash(parsed as PolicyIR);
      return existing === hash ? undefined : `hash ${existing} differs from the compiled ${hash}`;
    } catch (e) {
      return `invalid IR: not a policy IR (${e instanceof Error ? e.message : String(e)})`;
    }
  }
}
