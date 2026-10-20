@OrmResource('LocationSubscription')
export class LocationSubscription extends ModelBase {
  @ResourceOwner()
  public user_id: number;
}
