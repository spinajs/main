---
"@spinajs/http-socket": patch
"@spinajs/manifest": patch
---

Socket contracts work in a real manifest boot. A schema elsewhere in the manifest no longer stops contract enforcement: in `require` a controller bound to a contract failed the boot with "the schema is not valid", and in `prefer` the contract went unenforced, as soon as the manifest held a schema Ajv refuses, which `http-socket`'s own configuration schema is. A `$data` rule in a contract schema is now enforced, and its error does not carry the value of the other field. `mergeFragments` keeps the id of `defineContract('<id>')` as written instead of prefixing it with the package name, so an explicitly named contract matches its controller at runtime and in `spinajs doctor`. Rebuild the manifest to pick this up; an id shared by two packages is now reported as SOCK005.
