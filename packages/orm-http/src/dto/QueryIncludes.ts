import { Hydrator } from "@spinajs/http";
import { QueryIncludesHydrator } from "../hydrators/QueryIncludesHydrator.js";

@Hydrator(QueryIncludesHydrator)
export class QueryIncludes {
    [key: string]: QueryIncludes;

    constructor(data: any) {
        Object.assign(this, data);
    }
}