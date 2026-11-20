---
"@spinajs/compiler": patch
---

The authz section reads `// spinajs-authz-ignore` comments through the comment-range reader again. After the merge of that reader the section still called the text reader with a pattern it cannot take, so the compiler package did not build.
