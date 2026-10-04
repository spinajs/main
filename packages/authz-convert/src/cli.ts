import * as fs from 'node:fs';
import * as path from 'node:path';

import { convert } from './convert.js';
import { readDbFacts, scanSources } from './facts.js';
import { DEFAULT_SELF_RESOURCES } from './grants.js';
import { ConversionError } from './findings.js';

const USAGE = `Usage: spinajs-authz-convert <config-dir>... [options]

Converts a SpinaJS 2.x app's rbac.* configuration to 3.0 authz.*, users.* and authn.* files.
<config-dir> is the app's COMPILED config dir (for example lib/mjs/config); several dirs merge in order.

Options:
  --out <dir>               where to write the files (default: ./authz-convert-output)
  --db <file.json>          2.x rows exported before the migrations: { "users": [{ "Id", "Login", "Role" }],
                            "tokens": [{ "Id", "Roles", "ExpiresAt" }] }
  --src <dir>               app sources to scan for @OrmResource, @ResourceOwner and @OrmPermission
  --self-resources <a,b>    resources whose :own means the caller's own account
                            (default: ${DEFAULT_SELF_RESOURCES.join(',')})
  --force                   overwrite files that already exist in --out
  --help

Exit codes: 0 converted; 2 converted, with keys left to convert by hand (see authz-warnings.md);
1 refused or failed (nothing written).`;

interface Args {
  dirs: string[];
  out: string;
  db?: string;
  src?: string;
  selfResources?: string[];
  force: boolean;
}

function parse(argv: readonly string[]): Args | 'help' {
  const args: Args = { dirs: [], out: 'authz-convert-output', force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new ConversionError([`${a} needs a value`]);
      return v;
    };
    if (a === '--help' || a === '-h') return 'help';
    else if (a === '--out') args.out = value();
    else if (a === '--db') args.db = value();
    else if (a === '--src') args.src = value();
    else if (a === '--self-resources') args.selfResources = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--force') args.force = true;
    else if (a.startsWith('--')) throw new ConversionError([`unknown option ${a}`]);
    else args.dirs.push(a);
  }
  if (args.dirs.length === 0) throw new ConversionError(['no config dir given']);
  return args;
}

export async function main(argv: readonly string[], log: (line: string) => void = console.log, error: (line: string) => void = console.error): Promise<number> {
  try {
    const args = parse(argv);
    if (args === 'help') {
      log(USAGE);
      return 0;
    }
    const result = await convert({
      dirs: args.dirs,
      ...(args.db ? { db: readDbFacts(args.db) } : {}),
      ...(args.src ? { src: scanSources(args.src) } : {}),
      ...(args.selfResources ? { selfResources: args.selfResources } : {}),
    });
    const out = path.resolve(args.out);
    const existing = result.files.map((f) => path.join(out, f.name)).filter((f) => fs.existsSync(f));
    if (existing.length > 0 && !args.force) throw new ConversionError([`files exist and --force was not given: ${existing.join(', ')}`]);
    fs.mkdirSync(out, { recursive: true });
    for (const f of result.files) {
      fs.writeFileSync(path.join(out, f.name), f.content, 'utf-8');
      log(`wrote ${path.join(out, f.name)}`);
    }
    const count = (s: string) => result.findings.filter((x) => x.severity === s).length;
    log(`${count('manual')} key(s) to convert by hand, ${count('warning')} warning(s), ${count('info')} note(s); see authz-warnings.md`);
    return result.exitCode;
  } catch (err) {
    error(err instanceof ConversionError ? err.message : `spinajs-authz-convert failed: ${(err as Error).stack ?? String(err)}`);
    return 1;
  }
}
