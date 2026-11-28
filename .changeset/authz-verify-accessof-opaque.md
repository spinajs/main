---
"@spinajs/authz-verify": patch
---

`accessOf(permissionMatrix(ir), holder, permission)` no longer answers `never` for a permission that reaches an opaque term or an undefined name: it answers `conditional`, because `never()` on the same policy is not decided there. The matrix's `everyone` gains a `conditional` entry for such a permission. No gate and no `spinajs authz:verify` command reads the matrix. The README now names the reads that are still not safe-side: a second role of a type, and a relation of a type on which one role holds two or more relations.
