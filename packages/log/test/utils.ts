/* eslint-disable @typescript-eslint/no-unsafe-return */
import _ from "lodash";

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}
