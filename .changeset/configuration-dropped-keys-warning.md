---
"@spinajs/configuration": minor
---

A key that validation removes, because its schema sets `additionalProperties: false` and does not declare it, is now logged as a warning on the `Configuration` logger, once per schema and key, with its full path, the schema `$id` and the nearest declared key when one is close: `Configuration key users.emailDomains.apply.registraton is not declared by schema spinajs/users-email-domains.configuration.schema.json and was removed; did you mean registration?`. A key under a section no schema closes is kept and not reported. Values are unchanged: the key is still removed and the boot does not fail. The `__file__` tag of the file sources is not reported.
