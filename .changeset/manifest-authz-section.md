---
"@spinajs/manifest": major
"@spinajs/compiler": minor
---

The manifest has an `authz` section (`AuthzSection`: resource types with their relation columns, the permission catalogue, the access of every entry point, flow findings and `spinajs-authz-ignore` comments). A fragment omits it when the package declares none; `mergeFragments` concatenates the sections of every fragment, and a resource a package registers on another package's model (`registerAccessResource(DbConfig, 'configuration')`) marks that model in the merged manifest.

`ModelEntry.accessResource` is now the resource type string (`'post'`) instead of a boolean, and is omitted when the model is no access resource. A fragment written by an older compiler (`accessResource: true`) no longer validates: rebuild it. Socket controller entries and socket event entries may record their class-level and event-level `access` and `policies`.
