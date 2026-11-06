import { NewInstance } from '@spinajs/di';
import { ReferentialAction } from '../../interfaces.js';

@NewInstance()
export class ForeignKeyBuilder {
  public ForeignKeyField: string;

  public Table: string;

  public PrimaryKey: string;

  public OnDeleteAction: ReferentialAction;

  public OnUpdateAction: ReferentialAction;

  constructor() {
    this.OnDeleteAction = ReferentialAction.NoAction;
    this.OnUpdateAction = ReferentialAction.NoAction;
  }

  /**
   *
   * Referenced field in child table
   *
   * @param fkName - name of foreign field in child table
   */
  public foreignKey(fkName: string) {
    this.ForeignKeyField = fkName;

    return this;
  }

  /**
   *
   * Referenced parent table & key
   *
   * @param table - parent table
   * @param pKey - parant table key field
   */
  public references(table: string, pKey: string) {
    this.Table = table;
    this.PrimaryKey = pKey;

    return this;
  }

  /**
   *
   * On delete action
   *
   * @param action - action to take on delete
   */
  public onDelete(action: ReferentialAction) {
    this.OnDeleteAction = action;

    return this;
  }

  /**
   *
   * On update action
   *
   * @param action - action to take on update
   */
  public onUpdate(action: ReferentialAction) {
    this.OnUpdateAction = action;

    return this;
  }

  /**
   * Shorhand for on update and on delete cascade settings
   */
  public cascade() {
    this.OnUpdateAction = ReferentialAction.Cascade;
    this.OnDeleteAction = ReferentialAction.Cascade;

    return this;
  }
}
