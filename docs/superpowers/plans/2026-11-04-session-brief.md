# Session Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each T3 thread a "session brief" of verified work. Any agent adds entries through an MCP tool, Eric sees them live in a right-panel **Brief** tab with Copy, Clear, and Remove, and every entry is appended to the shared vault JSON log with the next SB number.

**Architecture:**

- A new server module `apps/server/src/sessionBrief/` holds three things: a per-root-thread JSON store in T3's state directory, a single-writer log service that appends to the external vault file and keeps retrying, and the change feed.
- A new MCP toolkit exposes `t3_brief_add`. New WS RPCs stream a thread's brief and run clear and remove.
- The web app gets a new `"brief"` right-panel kind rendered by a new `SessionBriefPanel`.
- Edits to upstream files are kept to hook-in lines.

**Tech Stack:** Effect v4 (Schema, Layer, Stream, PubSub, TestClock), `@effect/vitest`, React and Zustand in `apps/web`, the atoms in `packages/client-runtime`, and Vite+ (`vp`).

**Spec:** `docs/superpowers/specs/2026-11-04-session-brief-design.md`. Read it first. The reference implementation is `C:\Users\eolson\.claude\mods\session-brief\hooks\register.tsx`.

## Global Constraints

- **Branch:** work on `feature/session-brief`, cut from the fork's `main`. Run `.\fork\sync-upstream.ps1 -CheckOnly` first; if it exits 1, run the sync before branching.
- **Minimal upstream edits.** New code goes in new files. Edits to upstream files are only the hook-in lines named in each task.
- **No new SQL migration.** Upstream owns migration ids, and a fork migration `080` breaks the startup check the day upstream ships its own `080`. Briefs are JSON files under `ServerConfig.stateDir`.
- **Never touch the real vault log or `~/.t3/userdata` during development or tests.** Tests use temp directories. Manual checks use a copy of the log in a scratch folder and a dev server with its own T3 home.
- **The log file's format must not change:**
  - It is written as `JSON.stringify(log, null, 2) + "\n"`.
  - Every top-level key is preserved.
  - `entry_count` and `generated_at` are updated on every write.
  - `generated_at` and `logged_at` are local time with offset, e.g. `2026-11-04T10:12:03-06:00`.
- **T3 log entry shape**, in this key order: `id, date, logged_at, topic, changed, verified, rollback?, note?, session_id, session_title, source`.
  - `id` is `SB-` plus a 4-digit zero-padded number, one higher than the largest existing `SB-n`.
  - `date` is `YYYY-MM-DD` built from `MM/DD` in the current year. A date later than today becomes today.
  - `session_id` is the root thread id, and `session_title` is the root thread's title.
  - `source` is `"t3"`.
- **Duplicate rule:** an existing log entry with the same `topic` **and** `changed`, from any source, means already logged. Nothing is written.
- **Copy text matches the mod's `asText` exactly:**
  - Line 1 of a step is `N. Topic (MM/DD)`.
  - Sub-lines are 4 spaces, then `N.k Label: text`, where Label is one of `What changed`, `Verified`, `Rollback`, `Note`, and k counts only the fields that are present.
  - Steps are separated by a blank line, line endings are CRLF, and every backtick is removed.
- **Commands:**
  - Run one test file with `vp test run <file>`.
  - Typecheck with `vp run typecheck`, run in the package you changed.
  - Before the final commit, run `vp run check:changed`.
  - Never run repo-wide `vp check`, `vp run -r test`, or `vp run -r typecheck`. Use `it.effect` with TestClock; no real sleeps.
- **Commit identity:** the repo has no `user.name`/`user.email` yet. Get them from Eric before the first commit. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The log file is locked for minutes** (OneDrive syncing, Obsidian holding it open). The entry shows `Retrying` with the reason, keeps retrying, lands exactly once, and later entries still get unique SB ids. _Test in Task 3._
2. **The log file is mid-sync or briefly invalid JSON.** T3 never overwrites it. The entry goes to `Retrying` with the reason "log file is not valid JSON". _Test in Task 3._
3. **The log path is set but the file doesn't exist** (typo, or OneDrive not mounted). T3 does **not** create a new file, which would silently split the history. It retries with the reason "log file not found". _Test in Task 3._
4. **The server restarts while entries are still `Pending` or `Retrying`, including entries hidden by Clear.** They resume on startup and land. _Test in Task 4._
5. **Two threads, or a parent and its subagent, add entries at the same moment.** Writes are serialized, SB ids never repeat, and both entries land. _Test in Task 3._

---

### Task 1: Contracts and server setting

**Files:**

- Create: `packages/contracts/src/sessionBrief.ts`
- Modify:
  - `packages/contracts/src/index.ts`: one export line next to `threadMetadataMcp.ts` (line 46).
  - `packages/contracts/src/settings.ts`: `ServerSettings` (around line 1317) and `ServerSettingsPatch` (around line 1677).
  - `packages/contracts/src/rpc.ts`: `WS_METHODS` (408-615), three `Rpc.make` definitions, and `WsRpcGroup` (1990).
  - `packages/contracts/src/clientRpcPermissions.ts`: line 17 map.
- Test: `packages/contracts/src/sessionBrief.test.ts`

**Interfaces:**

- Produces, all exported from `@t3tools/contracts`:
  - `SessionBriefFields = Schema.Struct({ topic, date, changed, verified, rollback: optional, note: optional })`:
    - `topic` is `TrimmedNonEmptyString`, max 200.
    - `date` matches `/^\d{1,2}\/\d{1,2}$/`.
    - `changed` and `verified` are `TrimmedNonEmptyString`, max 4000.
    - `rollback` and `note` are `TrimmedNonEmptyString`, max 4000.
  - `SessionBriefLogState`, a tagged union:
    - `{ _tag: "Pending" }`
    - `{ _tag: "Logged", sbId: string }`
    - `{ _tag: "AlreadyLogged", sbId: string }`
    - `{ _tag: "Retrying", reason: string, attempts: number }`
    - `{ _tag: "NotLogged", reason: string }`
  - `SessionBriefEntry = SessionBriefFields` plus `{ id: string /* uuid */, createdAt: IsoDateTime, sourceThreadId: ThreadId, cleared: boolean, log: SessionBriefLogState }`.
  - `SessionBriefView = { rootThreadId: ThreadId, entries: ReadonlyArray<SessionBriefEntry> }`. Only entries with `cleared: false` are included, in insertion order.
  - The MCP input is `SessionBriefAddInput = SessionBriefFields` with `date` optional. The result is `SessionBriefAddResult = { count: number, log: string }`.
  - RPCs:
    - `WS_METHODS.sessionBriefSubscribe = "sessionBrief.subscribe"`: payload `{ threadId: ThreadId }`, success `SessionBriefView`, `stream: true`.
    - `WS_METHODS.sessionBriefClear = "sessionBrief.clear"`: payload `{ threadId }`, success `{ cleared: number }`.
    - `WS_METHODS.sessionBriefRemove = "sessionBrief.remove"`: payload `{ threadId, entryId: string }`, success `{ removedSbId: string | null }`.
    - Errors for all three: `Schema.Union([SessionBriefError, EnvironmentAuthorizationError])`, where `SessionBriefError` is a tagged error with `message`.
  - `CLIENT_GUARDED_RPC_SCOPES`: clear and remove map to `AuthOrchestrationOperateScope`.
  - The setting `sessionBriefLogPath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("")))`, plus `Schema.optionalKey(TrimmedString)` in the patch.

- [ ] **Step 1: Write `sessionBrief.test.ts`.**
  - `decodes a minimal add input`: `{ topic: "A", changed: "B", verified: "C" }` decodes, and `date` is undefined.
  - `rejects a bad date`: `date: "2026-10-23"` fails.
  - `rejects an empty topic`: `"   "` fails.
  - `round-trips every log state`: encode then decode each of the five tags.
  - `defaults sessionBriefLogPath to empty`: `DEFAULT_SERVER_SETTINGS.sessionBriefLogPath === ""`.
- [ ] **Step 2:** `vp test run packages/contracts/src/sessionBrief.test.ts`. Expected: FAIL, the module is not found.
- [ ] **Step 3:** Implement the schemas, the setting, the RPCs, and the guard entries above. Follow the Effect v4 Schema style of `threadMetadataMcp.ts`.
- [ ] **Step 4:** Run the test (PASS), then `vp run typecheck` in `packages/contracts` (clean).
- [ ] **Step 5:** Commit: `feat(contracts): session brief schemas, RPCs and log path setting`.

### Task 2: Copy-text formatter

**Files:**

- Create: `packages/shared/src/sessionBriefText.ts`, exported as `@t3tools/shared/sessionBriefText`. Add it to the package `exports` the same way `atomicWrite` is.
- Test: `packages/shared/src/sessionBriefText.test.ts`

**Interfaces:**

- Consumes: `SessionBriefFields` (Task 1).
- Produces: `formatSessionBriefText(entries: ReadonlyArray<SessionBriefFields>, eol?: string): string`. The default `eol` is `"\r\n"`, and numbering starts at 1 in array order.

- [ ] **Step 1: Write the test `matches the Claude Code mod byte for byte`** with exactly these inputs and output:

```ts
const entries = [
  {
    topic: "Synology PW-FILES DC list",
    date: "10/23",
    changed: "Added `CH-BLT-DC01`.",
    verified: "DSM test passed.",
  },
  {
    topic: "CA backup",
    date: "10/23",
    changed: "Ran `Backup-CARoleService`.",
    verified: "Hashes match.",
    note: "FS2 copy kept.",
  },
];
expect(formatSessionBriefText(entries)).toBe(
  "1. Synology PW-FILES DC list (10/23)\r\n    1.1 What changed: Added CH-BLT-DC01.\r\n    1.2 Verified: DSM test passed.\r\n\r\n" +
    "2. CA backup (10/23)\r\n    2.1 What changed: Ran Backup-CARoleService.\r\n    2.2 Verified: Hashes match.\r\n    2.3 Note: FS2 copy kept.",
);
```

Also add `returns empty string for no entries` and `uses the given eol` (`"\n"`).

- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement it. Port `toSteps` and `asText` from the mod, using the field order and labels from Global Constraints.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(shared): session brief ticket-text formatter`.

### Task 3: Vault log writer (pure log edits plus the writer service)

**Files:**

- Create:
  - `apps/server/src/sessionBrief/briefLog.ts`: pure functions, no I/O.
  - `apps/server/src/sessionBrief/SessionBriefLog.ts`: the service.
- Test:
  - `apps/server/src/sessionBrief/briefLog.test.ts`
  - `apps/server/src/sessionBrief/SessionBriefLog.test.ts`

**Interfaces:**

- Consumes: `SessionBriefFields` and `SessionBriefLogState` (Task 1), `ServerSettingsService` (`apps/server/src/serverSettings.ts:252`), and `writeFileStringAtomically` (`@t3tools/shared/atomicWrite`).
- Produces, in `briefLog.ts`:
  - `type VaultLog = Record<string, unknown> & { entries: Array<Record<string, unknown>> }`.
  - `parseVaultLog(text: string): VaultLog`. It throws `"log file is not valid JSON"` or `"log has no entries list"`.
  - `serializeVaultLog(log: VaultLog, now: Date): string`. It sets `entry_count` and `generated_at`, then returns `JSON.stringify(log, null, 2) + "\n"`.
  - `appendToVaultLog(log, fields, meta: { sessionId: string; sessionTitle: string; now: Date }): { log: VaultLog; outcome: { _tag: "Logged" | "AlreadyLogged"; sbId: string } }`.
  - `removeFromVaultLog(log, sbId: string, fields): { log: VaultLog; removed: boolean }`. It removes only the entry whose `id === sbId` **and** whose `topic` and `changed` match.
  - `vaultLogHas(log, sbId, fields, sessionId): boolean`.
  - `isoDate(md: string, now: Date): string` and `localStamp(now: Date): string`, ported from the mod.
- Produces, in `SessionBriefLog.ts`:
  - `class SessionBriefLog extends Context.Service<...>()("t3/sessionBrief/SessionBriefLog")` with:
    - `append(fields, meta: { sessionId; sessionTitle }): Effect<SessionBriefLogState>`. It never fails, and the result is one of `Logged | AlreadyLogged | Retrying | NotLogged`.
    - `verify(sbId, fields, sessionId): Effect<boolean>`.
    - `remove(sbId, fields): Effect<boolean>`.
  - One `Semaphore(1)` serializes every read-modify-write.
  - Each attempt re-reads the file immediately before writing.
  - An empty `sessionBriefLogPath` gives `NotLogged` with "no log path set in Settings".
  - A missing file gives `Retrying` with "log file not found" (Review Focus 3). Do not create the file.
  - A parse error gives `Retrying` with "log file is not valid JSON" (Review Focus 2).
  - A write error gives `Retrying` with the error's short message (Review Focus 1).

- [ ] **Step 1: Write `briefLog.test.ts`.**
  - `appends with next SB id`: a log with `SB-0175` gives `SB-0176`, the key order from Global Constraints, `source: "t3"`, and `entry_count` equal to the length.
  - `already logged on same topic+changed from any source`: returns `AlreadyLogged` with the existing id, and the log is unchanged.
  - `keeps unknown top-level keys`: `session_history` and `superseded` survive byte for byte.
  - `future date becomes today`: `"12/31"` with `now = 2026-11-04` gives `"2026-11-04"`.
  - `remove only by matching sbId`: `SB-0010` whose topic doesn't match is not removed.
  - `serialize matches mod format`: `serializeVaultLog(parseVaultLog(sample), now)` equals the sample with only `generated_at` and `entry_count` changed.
- [ ] **Step 2: Write `SessionBriefLog.test.ts`.** Use a temp directory through `FileSystem` and `ServerSettingsService.layerTest({ sessionBriefLogPath })`.
  - `NotLogged when path empty`.
  - `Retrying when file missing, and file is not created`.
  - `Retrying when file is invalid JSON, and file is untouched`.
  - `concurrent appends get unique ids`: `Effect.all([append(a), append(b)], { concurrency: 2 })` gives two distinct SB ids, and both are present in the file (Review Focus 5).
  - `verify false after another writer overwrites`: append, rewrite the file without the entry, then `verify` returns false.
- [ ] **Step 3:** Run both. Expected: FAIL.
- [ ] **Step 4:** Implement `briefLog.ts`, then `SessionBriefLog.ts` with its `layer`, using `FileSystem`, `Path`, `HostProcess.Platform`, and `ServerSettingsService`.
- [ ] **Step 5:** Run both. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(server): session brief vault log writer`.

### Task 4: Brief store, retry loop and change feed

**Files:**

- Create: `apps/server/src/sessionBrief/SessionBriefService.ts`
- Test: `apps/server/src/sessionBrief/SessionBriefService.test.ts`

**Interfaces:**

- Consumes:
  - `SessionBriefLog` (Task 3) and `ServerConfig.stateDir` (`apps/server/src/config.ts:38`).
  - `ThreadManagementService.getThreadShell` (`orchestration-v2/ThreadManagementService.ts:422`), for `lineage` and title.
- Produces `class SessionBriefService extends Context.Service<...>()("t3/sessionBrief/SessionBriefService")` with:
  - `resolveRoot(threadId: ThreadId): Effect<ThreadId>`. It walks `lineage.parentThreadId` while `lineage.relationshipToParent === "subagent"`, so forks and side chats keep their own brief. Model the loop on `depthOf` in `McpHttpServer.ts:897-912`.
  - `add(callerThreadId, fields): Effect<{ count: number; log: SessionBriefLogState }>`:
    1. Resolve the root and store the entry with `log: Pending`.
    2. Call `log.append` with `sessionId` set to the root id and `sessionTitle` set to the root title, then store the result.
    3. If the result is `Logged`, schedule verification after **2 seconds**. If verification fails, set `Retrying` with "overwritten by another writer" and append again.
    4. If the result is `Retrying`, schedule retries with exponential backoff starting at **5 seconds** and capped at **5 minutes**, with no attempt limit. Each attempt updates `attempts` and `reason`.
  - `subscribe(threadId): Stream<SessionBriefView>`. It emits the current view, then a new view after every change to that root. The pattern is `PubSub.sliding` keyed by root, then `Stream.concat(current, changes)`, as in `ScheduledTaskService.ts:474-481,1186-1196`.
  - `clear(threadId): Effect<{ cleared: number }>`. It sets `cleared: true` on visible entries and does not touch the log. Cleared entries still `Pending` or `Retrying` keep retrying and are pruned once they reach a final state.
  - `remove(threadId, entryId): Effect<{ removedSbId: string | null }>`:
    1. Interrupt the entry's retry fiber.
    2. If the entry is `Logged`, call `log.remove(sbId, fields)`.
    3. Delete the entry.
  - Storage is one file per root at `<stateDir>/session-briefs/<rootThreadId>.json`, holding `{ version: 1, rootThreadId, entries }`, written with `writeFileStringAtomically`.
  - On layer start, scan that directory and restart the retry loop for every `Pending` or `Retrying` entry (Review Focus 4).
  - Retry fibers live in a `Map<entryId, Fiber>` owned by the layer's scope.

- [ ] **Step 1: Write `SessionBriefService.test.ts`** with `it.effect`, TestClock, a temp state dir, and a stubbed `ThreadManagementService`:
  - `subagent entry lands in root brief`: child `relationshipToParent: "subagent"`, parent root gives `subscribe(child)` and `subscribe(root)` the same view.
  - `fork keeps its own brief`.
  - `retry lands after lock clears`: make the file missing, `add` gives `Retrying`, create the file, `TestClock.adjust("5 seconds")` gives `Logged`.
  - `re-appends after overwrite`: `add` gives `Logged` SB-0176. Rewrite the file without it but with a new `SB-0176` from source `live`, adjust 2 seconds, and the entry becomes `Logged` SB-0177.
  - `clear hides entries, numbering restarts, log untouched`.
  - `clear keeps retrying hidden entry until it lands, then prunes it`.
  - `remove deletes only its own SB id`: an `AlreadyLogged` entry removed leaves the log unchanged.
  - `resumes pending entries on restart`: write a store file with a `Retrying` entry, build the layer, adjust the clock, and it becomes `Logged`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement `SessionBriefService.ts` and its `layer`.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): per-thread session brief store with log retries`.

### Task 5: MCP tool `t3_brief_add` and agent instructions

**Files:**

- Create:
  - `apps/server/src/mcp/toolkits/sessionBrief/tools.ts`
  - `apps/server/src/mcp/toolkits/sessionBrief/handlers.ts`
- Modify:
  - `apps/server/src/mcp/McpHttpServer.ts`: one `layerSessionBriefToolkit = toolkitRegistration(...)`, provided `SessionBriefService.layer` (pattern at line 1120), plus one entry in `layerTools` (1196-1208).
  - `packages/shared/src/t3McpToolPresentation.ts`: a `t3_brief_add` entry in `T3_MCP_TOOLS` (line 98), titled "Add to session brief".
  - `packages/provider-core/src/server/orchestrationInstructions.ts`: add the brief rule as a line in an existing section. Keep each section under 4,000 bytes.
  - `apps/server/src/provider/AgentContextBudget.test.ts`: add `Layer.mock(SessionBriefService)({})` to `toolHandlerServices` (lines 49-81).
  - `apps/server/src/provider/agentContextBudget.json`: set it to the new measured bytes.
  - `apps/server/src/server.ts`: provide `SessionBriefService.layer` and `SessionBriefLog.layer` where `McpHttpServer.layer` is consumed (line 779). The WS handlers need them too (Task 6).
- Test: `apps/server/src/mcp/toolkits/sessionBrief/sessionBrief.test.ts`, following `toolkits/core.test.ts:507-580`.

**Interfaces:**

- Consumes: `SessionBriefService.add` (Task 4), `SessionBriefAddInput`/`Result` (Task 1), and `McpToolAccess.actsAsCaller`.
- Produces the tool `t3_brief_add`:
  - Parameters are `SessionBriefAddInput`. There is **no** `threadId` or `environmentId`.
  - Annotations: `Tool.Title "Add to session brief"`, `Tool.Strict true`, `Tool.Destructive false`.
  - Visible to subagents.
  - It resolves the caller thread from `McpInvocationContext` (`scope.thread.threadId`).
  - `date` defaults to today as `MM/DD`.
  - The result's `log` string is one of:
    - `logged as SB-0177`
    - `already in the annual log as SB-0123`
    - `NOT written to the annual log yet (<reason>); retrying`
    - `NOT written to the annual log (no log path set in Settings)`
- The instruction line, verbatim:

  > - Session brief: when a step is finished AND verified by evidence in this conversation (command output, a screenshot, the user confirming it worked), call \`t3_brief_add\` once for it. Never plans, in-progress work, guesses or unverified changes; never the same step twice. Short, plain, past-tense fields; commands, paths and settings in backticks. Don't mention the brief unless asked.

- [ ] **Step 1: Write the tests.**
  - `adds from a thread caller`: the result has `count: 1` and the log string.
  - `delegated child adds to root`.
  - `refuses outside clients`: no thread scope gives `thread_credential_required`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the toolkit, the registration, the presentation entry, and the instruction line.
- [ ] **Step 4:** Run the toolkit test, then `vp test run apps/server/src/provider/AgentContextBudget.test.ts`. Update `agentContextBudget.json` to the measured numbers it prints and re-run until both PASS. Then run `vp test run packages/shared/src/t3McpToolPresentation.test.ts` (PASS).
- [ ] **Step 5:** Commit: `feat(server): t3_brief_add MCP tool and brief instruction`.

### Task 6: WS handlers and client-runtime atoms

**Files:**

- Modify:
  - `apps/server/src/ws.ts`: yield `SessionBriefService` near line 1398, and add three handlers in `ServerWsRpcGroup.of` (from line 1998), following the scheduled-task handlers at 2276-2286.
  - `packages/client-runtime/src/rpc/client.ts`: add `sessionBriefSubscribe` to `EnvironmentSubscriptionRpcTag` (line 61).
  - `packages/client-runtime/src/state/server.ts`: add `sessionBriefLive`, `clearSessionBrief`, and `removeSessionBriefEntry`, next to `scheduledTasksLive` (1326) and `deleteScheduledTask` (1556).
- Test: extend `SessionBriefService.test.ts` only if a handler adds logic. Otherwise typecheck is the gate.

**Interfaces:**

- Produces, for the web app:
  - `serverEnvironment.sessionBriefLive({ environmentId, input: { threadId } })` gives an atom of `SessionBriefView`.
  - `serverEnvironment.clearSessionBrief` and `serverEnvironment.removeSessionBriefEntry` are commands taking `{ environmentId, input }`.

- [ ] **Step 1:** Implement the handlers and atoms. The handlers delegate directly: `subscribe(input.threadId)`, `clear(input.threadId)`, `remove(input.threadId, input.entryId)`.
- [ ] **Step 2:** Run `vp run typecheck` in `apps/server` and in `packages/client-runtime` (clean).
- [ ] **Step 3:** Commit: `feat: session brief RPC handlers and client atoms`.

### Task 7: Brief tab in the right panel

**Files:**

- Create:
  - `apps/web/src/components/chat/SessionBriefPanel.tsx`: the panel.
  - `apps/web/src/components/chat/SessionBriefTabTitle.tsx`: the live count label.
- Modify, adding the `"brief"` kind everywhere a singleton kind is listed:
  - `apps/web/src/rightPanelStore.ts`: `RIGHT_PANEL_KINDS` (15-25), the `RightPanelSurface` union `{ id: "brief"; kind: "brief" }` (37-79), and `singletonSurface` (210-223).
  - `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`: `case "brief"` at 169.
  - `apps/web/src/components/RightPanelTabs.tsx`:
    - `surfaceTitle`: `"Brief"` (570-608).
    - `SurfaceIcon`: a lucide `NotebookPen` at `size-3 shrink-0` (657-696).
    - Render `<SessionBriefTabTitle>` for the tab label.
    - Add-surface actions (1093-1162) and the empty-state list (339-410), with shortcut letter **N**.
    - `onAddBrief` / `briefAvailable` props (135-155).
  - `apps/web/src/closedViewStore.ts`: `case "brief": return surface.id === surface.kind;` (near 65).
  - `apps/web/src/components/chat/useRightPanelActions.ts`: `addBriefSurface` (next to 150-154).
  - `apps/web/src/components/ChatView.tsx` (3984-4001) and `components/pullRequest/PullRequestsPage.tsx` (1495-1497, as a no-op): pass the new props.
- Test: `apps/web/src/components/chat/SessionBriefPanel.browser.test.tsx`

**Interfaces:**

- Consumes: `serverEnvironment.sessionBriefLive`, `clearSessionBrief`, and `removeSessionBriefEntry` (Task 6), `formatSessionBriefText` (Task 2), `useCopyToClipboard` (`hooks/useCopyToClipboard.ts:195`), and `requestConfirmDialog` (`confirmDialog.ts:62`).
- Produces: `SessionBriefPanel({ threadRef }: { threadRef: ScopedThreadRef })` and `SessionBriefTabTitle({ threadRef })`. The tab title renders `Brief · N`, or just `Brief` when N is 0.

**Panel behavior:**

- **Toolbar:** `N entries`, then a **Copy** button (primary), then a **Clear** button.
  - Copy writes `formatSessionBriefText(view.entries)` and shows "Copied" for 2 seconds.
  - Clear calls `requestConfirmDialog("Clear the session brief? The annual log keeps every entry.", { variant: "destructive" })`.
- **Each entry:**
  - The headline is `N. Topic (MM/DD)`, numbered 1..N in view order.
  - Sub-lines use the same labels as the copy text.
  - A log badge on the right:
    - `Logged` shows `SB-0177` in green.
    - `AlreadyLogged` shows `SB-0123 · already logged` in green.
    - `Pending` shows `logging…` in amber.
    - `Retrying` shows `retrying: <reason>` in amber, with the attempt count in a tooltip.
    - `NotLogged` shows `not logged: <reason>` in muted text.
  - A remove (×) button asks `requestConfirmDialog("Remove this entry from the brief and the annual log?", { variant: "destructive" })`.
- **Empty state:** "No verified steps yet. Entries appear here as the agent finishes and verifies work."

- [ ] **Step 1: Write the browser tests,** with a mocked atom value:
  - `renders numbered entries and badges`, covering all five states.
  - `copy writes mod-format text`: the clipboard receives exactly the Task 2 sample output.
  - `clear asks first and does nothing on cancel`.
  - `remove asks first then calls removeSessionBriefEntry with entryId`.
  - `tab title shows count`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the panel, the title, and the kind hook-ins above. TypeScript's exhaustive switch in `RightPanelSurfaceContent` flags any missed case.
- [ ] **Step 4:** Run the test (PASS), then `vp run typecheck` in `apps/web` (clean).
- [ ] **Step 5:** Commit: `feat(web): Brief tab in the right panel`.

### Task 8: Log path setting UI, end-to-end check, finish

**Files:**

- Create: `apps/web/src/components/settings/SessionBriefSettings.tsx`. It is one `SettingsRow` using the `addProjectBaseDirectory` pattern at `SettingsPanels.tsx:1556-1587`, with `settingKeys={["sessionBriefLogPath"]}`.
  - Label: "Session brief log file".
  - Description: "Verified brief entries are appended here (Session-Briefs-Log.json). Leave empty to keep briefs without logging."
  - Placeholder: `C:\…\13-Session Briefs\Session-Briefs-Log.json`.
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`, one line rendering `<SessionBriefSettings />` after the "New projects" section.

- [ ] **Step 1:** Implement the settings row. Run `vp run typecheck` in `apps/web` (clean).
- [ ] **Step 2: Manual end-to-end check.** Use a dev server with its own temporary T3 home, never `~/.t3/userdata`, and set the log path to a **copy** of the vault log in a scratch folder.
  1. In a thread, ask Claude to do and verify a trivial step.
  2. Confirm the entry appears live in the Brief tab with an SB number one higher than the copy's last.
  3. Confirm the copy file gained the entry and is otherwise byte-identical except `entry_count` and `generated_at`.
  4. Copy, then paste into a text editor: it matches the mod format.
  5. Remove the entry: it's gone from both the tab and the copy.
  6. Clear.
  7. Lock the copy file. In PowerShell, `$f=[IO.File]::Open('<copy>','Open','Read','None')` holds it locked. Add an entry and confirm `retrying: …` shows. Then `$f.Close()` and confirm it turns into an SB number.
- [ ] **Step 3:** Run `vp run check:changed` (clean). Then run `.\fork\sync-upstream.ps1 -CheckOnly`. If upstream moved, merge `main` into the branch and re-run the checks.
- [ ] **Step 4:** Commit: `feat(web): session brief log path setting`. Then use superpowers:finishing-a-development-branch to merge into `main` and push to the fork.
