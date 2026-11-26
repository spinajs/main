---
"@spinajs/orm-history": minor
---

`HistoryCoverage` says from when on a trail holds every change of the columns an entity's registration records, so a reader can tell "no change" from "not recorded": `since(trail, connection, entity)` is the later of the first boot that tracked the entity and its last `lost` event, and restarts when a registration records a column it left out before; `record(models?)` records it for models registered after the ORM has booted. An application's boot records every table it tracks. The package ships one more migration on the default connection, `OrmHistoryCoverage_2026_11_25_00_00_00` (table `history_coverage`): run `npx spinajs migrate-up` before the new version starts, and add a subclass for every other connection that holds a tracked model.
