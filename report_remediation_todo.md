# Codebase Review Remediation TODO

This file tracks the remaining items from `codebase_review_report.md` that are not yet fully closed on `report-remediation`.

- [ ] Expand IPC validation beyond the current high-risk subset in `electron/ipcHandlers.ts`
- [ ] Split `electron/ipcHandlers.ts` into grouped handler modules
- [ ] Finish typed IPC coverage across remaining preload/renderer APIs
- [ ] Replace the current loopback OAuth callback with a stronger production-grade redirect flow in `electron/services/CalendarManager.ts`
- [ ] Remove the remaining `new Function(...)` ESM loader workaround for transformers-based model loading
- [ ] Further decompose `src/components/SettingsOverlay.tsx` into smaller tab/components
- [ ] Address remaining React architecture concerns around shared state / per-window cache strategy
- [ ] Improve packaged local model resolution so the intent classifier never falls back unexpectedly
