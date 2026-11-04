---
"@spinajs/configuration": minor
---

The configuration validator installs `ajv-merge-patch` and `ajv-keywords` when the first configuration schema that names one of their keywords is checked, not at every boot: their meta-schemas no longer compile for an app whose schemas use none of them. Schemas that use them validate as before. `addKeywordPluginsOnUse(ajv)` is exported to do the same for another Ajv instance; call it after adding your own formats and keywords. A macro or code keyword, a vocabulary, or a plugin keyword name defined or removed later, and a schema or keyword given to the Ajv constructor, install the plugins first. A plugin keyword the instance already defines is kept, and a failed install is retried.
