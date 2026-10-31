import { checkSocketContract, type Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

export const socketContract: DoctorRule = {
  code: 'SOCK001',
  describe: 'a socket controller bound to a contract lacks a handler the contract declares (SOCK001), or its payload (SOCK002) or result (SOCK003) is incompatible with it; two contracts share an id (SOCK005)',
  run(manifest): Diagnostic[] {
    const out: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const contract of manifest.socketContracts) {
      if (seen.has(contract.id)) {
        out.push(diagnostic('SOCK005', 'error', `socket contract id ${contract.id} is declared more than once; give each defineContract a unique id`, contract.source));
      }
      seen.add(contract.id);
    }
    for (const controller of manifest.socketControllers) {
      if (controller.contract === undefined) continue;
      const contract = manifest.socketContracts.find((c) => c.id === controller.contract);
      if (!contract) {
        out.push(diagnostic('SOCK001', 'error', `${controller.className}: bound contract ${controller.contract} is not in the manifest`, controller.source));
        continue;
      }
      for (const issue of checkSocketContract(manifest, controller, contract)) {
        out.push(diagnostic(issue.code, issue.code === 'SOCK001' ? 'error' : 'warning', `${controller.className}: ${issue.message}`, controller.source));
      }
    }
    return out;
  },
};
