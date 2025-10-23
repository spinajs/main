import { isConstructor } from "@spinajs/di";
import { IModelDescriptor } from "./interfaces.js";
import { MODEL_DESCTRIPTION_SYMBOL } from "./symbols.js";
import _ from "lodash";


function getConstructorChain(obj: any) {
  var cs = [obj.name],
    pt = obj;
  do {
    if ((pt = Object.getPrototypeOf(pt))) cs.push(pt.name || null);
  } while (pt != null);
  return cs.filter((x) => x !== 'Function' && x !== 'Object' && x !== null);
}

export function extractModelDescriptor(targetOrForward: any): IModelDescriptor {
  const target = !isConstructor(targetOrForward) && targetOrForward ? targetOrForward() : targetOrForward;

  if (!target) {
    return null;
  }

  const metadata = Reflect.getMetadata(MODEL_DESCTRIPTION_SYMBOL, target);

  // we want collapse metadata vals in reverse order ( base class first )
  const inheritanceChain = getConstructorChain(target).reverse();
  const merger = (a: any, b: any) => {
    if (_.isArray(a)) {
      return a.concat(b);
    }

    if (!(_.isNil(a) || _.isEmpty(a)) && (_.isNil(b) || _.isEmpty(b))) {
      return a;
    }

    if (_.isMap(a)) {
      return new Map([...a, ...b]);
    }

    return b;
  };

  return inheritanceChain.reduce((prev, c) => {
    return {
      ..._.assignWith(prev, metadata[c], merger),
      Converters: new Map([...(prev.Converters ?? []), ...(metadata[c] ? metadata[c].Converters : [])]),
    };
  }, {});
}