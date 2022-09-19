export interface ISerializationDescriptor {
  Properties: string[];
}

export function Channel(name: string) {
  return (target: any) => {
    if (!Reflect.hasMetadata('event:channel', target)) {
      Reflect.defineMetadata(
        'event:serialization',
        {
          channel: name,
        },
        target,
      );
    }
  };
}

export function Serialize() {
  return (target: any, property: string) => {
    if (!Reflect.hasMetadata('event:serialization', target)) {
      Reflect.defineMetadata(
        'event:serialization',
        {
          Properties: [],
        },
        target,
      );
    }

    const sdesc: ISerializationDescriptor = Reflect.getMetadata('event:serialization', target);
    sdesc.Properties.push(property);
  };
}

export interface ISerializable {
  [key: string]: any;
}
