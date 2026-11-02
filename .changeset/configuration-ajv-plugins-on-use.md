---
"@spinajs/configuration": minor
---

The configuration validator installs `ajv-merge-patch` and `ajv-keywords` when the first configuration schema that names one of their keywords is checked, not at every boot: their meta-schemas no longer compile for an app whose schemas use none of them. Schemas that use them validate as before. `addKeywordPluginsOnUse(ajv)` is exported to do the same for another Ajv instance.
