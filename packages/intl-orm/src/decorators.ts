import { extractDecoratorDescriptor, IModelDescriptor } from '@spinajs/orm';

export function Translate() {
  return extractDecoratorDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push({ Name: propertyKey, Translate: true } as any);
    } else {
      columnDesc.Translate = true;
    }
  }, true);
}
