---
"@spinajs/authz-ir": patch
"@spinajs/authz-rbac": patch
"@spinajs/authz-rebac": patch
---

Decision replay reads an assignment or tuple it cannot decode as a gap instead of an absent one. A history contributor's `edges` and `subjectAt` may now throw `StoreUnreadable`: a logged change that cannot be decoded makes every read of its kind a gap (it may have touched any key), and an image that cannot be decoded makes its key a gap. `AssignmentHistoryContributor` and `TupleHistoryContributor` throw it where they used to drop the change, read the image as not live, or drop the current row.
