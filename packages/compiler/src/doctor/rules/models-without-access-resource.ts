import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';

const modelName = (text: string) => text.replace(/\[\]$/, '').replace(/^Array<(.*)>$/, '$1');

export const modelsWithoutAccessResource: DoctorRule = {
  code: 'ORM001',
  describe: 'Models bound by FromDbModel are access resources',
  run(manifest) {
    const models = new Map(manifest.models.map((m) => [m.className, m]));
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      for (const r of c.routes) {
        for (const p of r.params) {
          if (p.kind !== 'FromDbModel') continue;
          const model = models.get(modelName(p.runtimeType.text));
          if (!model || model.accessResource) continue;
          out.push(diagnostic('ORM001', 'warning', `${model.className} is loaded by ${c.className}.${r.handler} (FromDbModel) but is not an @AccessResource`, r.source));
        }
      }
    }
    return out;
  },
};
