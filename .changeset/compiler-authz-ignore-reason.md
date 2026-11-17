---
"@spinajs/compiler": patch
---

A `// spinajs-authz-ignore <code>: <reason>` comment counts only as a `//` comment that starts with the marker and carries its code and a non-blank reason on the same line. An empty or blank reason no longer takes the next line of code as its reason, a bare marker no longer takes its code from the next line, and the marker inside a string, a template literal or JSX text is no ignore.
