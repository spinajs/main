@OrmResource('Campaign')
export class Campaign extends ModelBase {
  @ResourceOwner()
  public AuthorId: number;
}
