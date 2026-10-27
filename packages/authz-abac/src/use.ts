import { AuthzContributor } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AbacContributor } from './model/contributor.js';
import { AbacModel } from './model/model.js';

/** `authz.use: ['abac']`: a model over `authz.abac.*` and its contributor, in the container of the domain that lists it. */
export const useAbac = (container: IContainer): AbacModel => {
  const model = new AbacModel();
  const contributor = new AbacContributor(model);
  container.register(() => contributor).as(AuthzContributor);
  return model;
};

DI.register(useAbac).as('abac');
