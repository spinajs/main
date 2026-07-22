import { isConstructor, collapseInheritedDescriptor } from '@spinajs/di';
import { IModelDescriptor } from "./interfaces.js";
import { MODEL_DESCTRIPTION_SYMBOL } from "./symbols.js";

export function createDefaultModelDescriptor(): IModelDescriptor {
  return {
    Driver: null,
    Converters: new Map(),
    Columns: [],
    Connection: null,
    PrimaryKey: '',
    SoftDelete: {
      DeletedAt: '',
    },
    Archived: {
      ArchivedAt: '',
    },
    TableName: '',
    Timestamps: {
      CreatedAt: '',
      UpdatedAt: '',
    },
    Name: "",
    Relations: new Map(),
    JunctionModelProperties: [],
    DiscriminationMap: {
      Field: '',
      Models: null,
    },
    Schema: {},
  };
}

export function extractModelDescriptorInherited(targetOrForward: any): IModelDescriptor | null {
  const target = !isConstructor(targetOrForward) && targetOrForward ? targetOrForward() : targetOrForward;

  if (!target) {
    return null;
  }

  return {
    ...collapseInheritedDescriptor(target, MODEL_DESCTRIPTION_SYMBOL, createDefaultModelDescriptor),
    // Name is always this class's own, never inherited - the merger would
    // otherwise keep the parent's non-empty name over the child's default ''
    Name: target.name,
  };
}

export function extractModelDescriptor(targetOrForward: any): IModelDescriptor | null {
  const target = !isConstructor(targetOrForward) && targetOrForward ? targetOrForward() : targetOrForward;

  if (!target) {
    return null;
  }

  return (Reflect.getOwnMetadata(MODEL_DESCTRIPTION_SYMBOL, target) as IModelDescriptor) ?? null;
}
