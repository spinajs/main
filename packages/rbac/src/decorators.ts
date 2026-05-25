import { extractDecoratorDescriptor, extractDecoratorPropertyDescriptor } from '@spinajs/orm';
import { IRbacModelDescriptor } from './interfaces.js';

/**
 * Assign resource name for given model ( RBAC ).
 * NOTE: this decorator is optional, if model does not have resource assigned
 *       model name will be used as default
 *
 * @param name - table name in database that is referred by this model
 */
export function OrmResource(resourceName?: string) {
  return extractDecoratorDescriptor((model: IRbacModelDescriptor) => {
    model.RbacResource = resourceName ?? model.Name;
  });
}


/**
 * 
 * Mark field as resource owner eg. field that holds user relation to resource like Invoice.Owner->User for RBAC module
 * 
 * If set, it will automatically try to fetch/update/delete only data that user have permission for
 * 
 */
export function ResourceOwner() { 
  return extractDecoratorPropertyDescriptor((model: IRbacModelDescriptor, _target: any, propertyKey: string) => {
    model.OwnerField = propertyKey;

    // Also register the field as a column so ORM WhereStatement recognizes it
    if (model.Columns && !model.Columns.find((c) => c.Name === propertyKey)) {
      model.Columns.push({
        Name: propertyKey,
        Type: '',
        MaxLength: 0,
        Comment: '',
        DefaultValue: null,
        NativeType: '',
        Unsigned: false,
        Nullable: false,
        PrimaryKey: false,
        AutoIncrement: false,
        Converter: null as any,
        Schema: null,
        Unique: false,
        Uuid: false,
        Ignore: false,
        Aggregate: false,
        IsForeignKey: false,
        ForeignKeyDescription: null as any,
        Virtual: false,
      });
    }
  });
}