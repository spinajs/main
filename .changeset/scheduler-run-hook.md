---
"@spinajs/scheduler": minor
"@spinajs/tenancy": minor
---

`@spinajs/scheduler`: `ScheduleRunHook` wraps the body of every run the loop executes and the emit of an emit-mode run (`order`, the lowest outermost; none is registered by default); a hook that throws fails the attempt. A run of a tenant's schedule instance is refused (the attempt fails) while no `ScheduleRunHook` is registered. `RunContext.tenant` names the tenant of the run's instance, and its run span carries `spina.tenant.id`. A task's abort listeners run in the async context of its body, not in that of whoever aborted the run. Inline runs keep the scope of their caller.

`@spinajs/tenancy/scheduler`: a run hook (order -100) that admits the run's tenant and runs the body inside it, from an empty request store; a global schedule's run executes with no tenant scope.
