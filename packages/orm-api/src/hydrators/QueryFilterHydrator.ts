import { ArgHydrator } from "@spinajs/http";
import { QueryFilter } from "../dto/QueryFilter.js";

export class GetFilterHydrator extends ArgHydrator {
    public async hydrate(input: string): Promise<any> {
      if (input) {
        return new QueryFilter(JSON.parse(input));
      }
      return new QueryFilter({});
    }
  }