import { ArgHydrator } from '@spinajs/http';
import _ from 'lodash';

export class QueryIncludesHydrator extends ArgHydrator {
  public async hydrate(input: string): Promise<any> {
    if (input) {
      const paths = input.split(',');
      const object = {};

      paths.forEach((x) => _.set(object, x, {}));
      return object;
    }

    return {};
  }
}
