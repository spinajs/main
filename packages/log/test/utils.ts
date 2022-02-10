/* eslint-disable @typescript-eslint/no-unsafe-return */
import * as _ from "lodash";

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}
