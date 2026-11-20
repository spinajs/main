---
"@spinajs/threading": major
"@spinajs/orm-threading": major
---

Breaking: the owner of a mutex lock is its holder, not its tenant. `MutexLockOptions.Tenant` and `MutexLock.Tenant` are renamed to `Holder`, the configuration key `threading.mutex.tenant` to `threading.mutex.holder`, the column `__mutex__.Tenant` to `__mutex__.Holder` (migration `MutexHolder_2026_11_16_00_00_00`, rows kept), and `OrmMutex.tenantOf()` and `ConfiguredTenant` to `holderOf()` and `ConfiguredHolder`. There is no alias for the old names. See "Mutex lock holder" in `docs/upgrading/4.0.md`.
