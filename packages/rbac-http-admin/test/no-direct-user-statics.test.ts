import { expect } from 'chai';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CONTROLLERS = join(process.cwd(), 'src', 'controllers', 'Users');
// Direct static query calls on the imported User bypass the RbacUserModel
// token and with it any application row scoping. The two whitelisted names are
// deliberately global (see comments at their call sites).
const ALLOWED = ['assertUnique'];

describe('no direct User static queries in admin controllers', () => {
  for (const file of readdirSync(CONTROLLERS).filter((f) => f.endsWith('.ts'))) {
    it(file, () => {
      const src = readFileSync(join(CONTROLLERS, file), 'utf-8');
      const offenders = [...src.matchAll(/\bUser\.(select|query|where|all|get|getOrFail|destroy|update|insert)\(/g)]
        .filter((m) => {
          const lineStart = src.lastIndexOf('\n', m.index!) + 1;
          const context = src.slice(Math.max(0, lineStart - 600), m.index!);
          return !ALLOWED.some((fn) => context.includes(`async ${fn}(`));
        });
      expect(offenders, `${file}: use userModel() instead of the imported User`).to.be.empty;
    });
  }
});
