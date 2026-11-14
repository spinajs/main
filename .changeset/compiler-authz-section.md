---
"@spinajs/compiler": minor
---

`spinajs build` writes the manifest `authz` section: every access resource with its relation columns (`@Parent`, `@Owner`, `@Self`, `@Relation`, and the options of a literal `registerAccessResource(Model, type, options)` call), the `<type>:read|create|update|delete` permissions the ORM adapter registers, and the `// spinajs-authz-ignore AUTHZxxx: <reason>` comments. A model inherits the access resource type of its nearest registered base class, also from a dependency's fragment.

Socket controller entries now record a class-level `@SocketAccess` / `@SocketPolicy`, and socket event entries their own, so a manifest with a guarded socket class or event gets a new hash on rebuild.
