---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

`authz.resources[].relations[]` records `typeColumn` (the column that names the principal type of an `@Owner` or a `@Relation`, also from `registerAccessResource` options) and `nullable` (a `@Parent(type, { nullable: true })` column). Where the build cannot read one of them (a call, a `let` or `var`, a spread or a computed key it cannot read, a class), the relation lists it under `unread` and a `CMP001` note says so, so an unread type column never reads as a `user` principal and an unread `nullable` never as "always has a parent". A registration whose options the build cannot read in full lists the type columns of its owner and relations as unread. A class passed as an option value is no longer read as its name, so `AUTHZ012` no longer compares such a registration (`@spinajs/authz-orm` refuses it when the application starts anyway).
