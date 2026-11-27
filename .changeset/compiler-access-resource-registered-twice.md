---
"@spinajs/compiler": patch
---

A model registered twice as an access resource (`@AccessResource`, `registerAccessResource`) with different options is the build error `AUTHZ012`, as `@spinajs/authz-orm` throws for it when the application starts. The same options in another order are one registration. Options the build cannot read in full (a variable it cannot follow to an object literal, a `let` or `var`, a spread or a member it cannot read) are not compared, so they never give a false error.
