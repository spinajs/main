@OrmPermission(Campaign, 'partner')
export class CampaignPartnerPolicy extends OrmPermissionPolicy {}

@OrmPermission(UserModel)
export class UserModelPolicy extends OrmPermissionPolicy {}
