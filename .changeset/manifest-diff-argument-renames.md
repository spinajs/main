---
"@spinajs/manifest": minor
---

`manifest:diff` reports a renamed route argument under an unchanged route as a non-breaking `routes` change: `argument body renamed to payload on users.create: generated hook variables and query keys change`. Parameters are still matched by their wire key, so a rename that keeps the wire (a whole-body, query-object or header argument, or a value argument with an explicit name) is only this finding, while one that moves the wire (a value argument sent under its own name) stays a breaking removal plus addition. `Change['section']` is unchanged.
