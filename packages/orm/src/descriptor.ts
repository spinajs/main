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

  // master's own-metadata-per-class read. MUST stay paired with the write side in
  // decorators.ts `_getMetadataFrom`, which replaced the old name-keyed container —
  // that container collapsed two classes sharing a name into one slot (A9 in the
  // ORM analysis). Reading name-keyed here against an own-metadata write returns null
  // for every model.
  return (Reflect.getOwnMetadata(MODEL_DESCTRIPTION_SYMBOL, target) as IModelDescriptor) ?? null;
}
