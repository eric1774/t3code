# Session Brief for T3 Code (fork feature)

Status: draft for review · 2026-11-04 · fork `eric1774/t3code`

## Why

Eric is an IT admin. During long jobs (the Proxmox migration, the PW-MP-CAMERAS fix) he works with a coding agent, and each step that is **done and verified** becomes an entry in a running "session brief". He copies the brief, pastes it into the help-desk ticket as a comment, then clears it so the next copy only has new work. Every entry also goes permanently into one JSON file in his Obsidian vault, used for the end-of-year accomplishment report.

He has this today in Claude Code as a custom mod (`~/.claude/mods/session-brief`). T3 Code cannot load that mod, so T3 needs its own version that does the same job. Claude Code and T3 must keep writing to the **same** JSON file with **one** SB numbering sequence.

## What exists today (the thing to match)

The Claude Code mod, `C:\Users\eolson\.claude\mods\session-brief\hooks\register.tsx`, is the reference implementation. Read it. In short:

- **Entry fields:** `topic`, `date` (`MM/DD`), `changed`, `verified`, optional `rollback`, optional `note`.
- **Agent rule:** while the brief is on, a system-prompt rule tells the agent to call an add tool once per step that is _completed AND verified by evidence in this conversation_. That means command output, a screenshot, or the user confirming it worked. Never plans, guesses, or unverified changes; one entry per step; no duplicates. See "Agent instructions" below for the wording.
- **Pane:** per session. Entries are numbered in insertion order: `1. Topic (MM/DD)`, then `1.1 What changed: …`, `1.2 Verified: …`, `1.3 Rollback: …`, `1.4 Note: …`. Only the fields that are present get a line.
- **Copy:** plain text, never Markdown. The numbers are literal digits, so ticket systems keep them. Sub-lines are indented 4 spaces, lines end in CRLF, a blank line separates steps, and every backtick is removed. `asText()` in the mod is the exact format.
- **Clear:** asks first, then empties this session's brief. It never touches the log.
- **Undo:** removes the entry from the brief and from the log.
- **Annual log:** `C:/Users/eolson/OneDrive - BeltonMO/IT Knowledge Hub - Eric's note taking vault/Work/13-Session Briefs/Session-Briefs-Log.json`. It currently holds 176 entries; the latest is SB-0176. See `appendToLog`, `removeFromLog`, `readLog`, and `writeLog` in the mod. The behavior:
  - The next id is `SB-` plus the highest existing number plus 1, zero-padded to 4.
  - `date` becomes `YYYY-MM-DD` in the current year. A date later than today becomes today.
  - `logged_at` is local time with its UTC offset.
  - An entry with the same `topic` and `changed` as an existing one is skipped as already logged.
  - Every write updates `entry_count` and `generated_at`.
  - Every other top-level key in the file is preserved: `session_history`, `superseded`, `session_history_skipped`, `fields`, and so on.
  - A failed log write never blocks adding the entry to the brief. The result says it was not logged.

## Goals

1. **Recording.** Any agent running in a T3 thread can add a brief entry through a T3 tool. Eric mostly runs Claude. Codex is available, and OpenCode is planned, so the tool must not depend on the provider.
2. **One brief per T3 thread.** It is saved on the server, survives restarts and reconnects, and stays until Eric clears it.
3. **Brief tab.** The right panel gets a **Brief** tab next to Diff, Files, Terminal, and the others. It fills in live as entries are added. The tab label shows the count, for example `Brief · 2`. Eric picked this layout (option A) over a chat-timeline marker and over a header drop-down.
4. **Log status on each entry.** This badge is how Eric knows the entry landed. Each entry shows one of these states:
   - **Logged:** `SB-0177`.
   - **Already logged:** `already logged as SB-0123`. The log already had an entry with the same `topic` and `changed`, so nothing new was written.
   - **Retrying:** the reason is visible, for example `retrying: file locked by OneDrive`.
   - **Not logged:** only when no log path is configured on this server. No retries happen in this state.

   **Failed writes retry automatically until they succeed** (Eric's answer). This includes after a server restart, so the log state is stored with each entry. The badge always shows whether the entry is still failing or has landed.

5. **Copy and Clear** behave exactly like the mod, with the same text format and confirm-before-clear. After a clear, numbering in the brief restarts at 1. SB numbers never restart.
6. **Remove one entry.** Each entry has a remove control that takes it out of the brief **and** out of the JSON log. Eric asked for this.
   - Each brief entry stores the SB id it wrote, and Remove deletes the log record **by that SB id only**. It does not match on topic or changed text the way the mod's `removeFromLog` does.
   - An entry marked "already logged", or one that never landed, deletes nothing from the log. That way Remove can never take out an older record from Eric's year-end history.
   - Removing an entry that is still retrying cancels its retry.
7. **Shared log.** Entries are appended to the same JSON log file with the same SB sequence, interleaving safely with the Claude Code mod.
8. **Always on.** There is no on/off toggle. Eric confirmed always-on is fine.

## Non-goals

- **Mobile app.** It is not in this version. Eric always copies briefs at a computer. Web and desktop share the same UI code, so both get this.
- **Editing entry text** in the UI. Eric hasn't needed it.
- Showing Claude Code briefs inside T3, or T3 briefs inside the Claude Code mod. Each tool shows its own sessions. They share only the log file.
- Recreating the mod's `/brief legacy` view or its status-line text.
- Reworking the log's `session_history` summaries. Those are built offline, so don't touch them.

## Anti-goals (would make this a failure even if it works)

- Corrupting or truncating `Session-Briefs-Log.json`, or dropping its non-`entries` keys. It is Eric's year-end record.
- Two entries sharing an SB number, or one being silently lost when T3 and Claude Code write close together.
- Copied text that pastes differently from the mod: Markdown bullets, lost numbering, or leftover backticks.
- Large edits across upstream T3 files. This is a fork that syncs with `pingdotgg/t3code` through `fork/sync-upstream.ps1`, and every changed line in an upstream file can conflict later. Put the work in **new files** and keep edits to shared files as small hook-in points.
- Performance regressions: sending whole briefs over the websocket on every change, or re-rendering the chat timeline when the brief changes.

## Constraints

- **One writer machine.** The vault JSON lives on Eric's desktop, synced through OneDrive. His laptop and phone connect to the desktop's T3 server, and he's fine always doing it that way. Only the T3 server that has a log path configured writes to the log (see "Log path").
- **Concurrent writer.** The Claude Code mod on the same desktop also writes this file. It does read, modify, write with no lock. T3's writer must read the file immediately before each write, compute the next id from that fresh read, and write atomically (temp file in the same folder, then rename). That keeps the race window as small as possible. The mod itself is out of scope and can't be changed here. Atomic writes alone can't close the race: the mod can read before T3's rename, write after it, and wipe out T3's entry. So T3 also checks again after it writes:
  - About two seconds after each write, T3 re-reads the log.
  - If its SB id is missing, or now belongs to a different entry, T3 goes back to retrying and appends the entry again under the next free SB number.
  - The badge's SB number can change during this. That's safe because copied ticket text never includes SB numbers.
- **Hit every surface (AGENTS.md).** For each item there, state which ones apply. The expected answers:
  - Web and desktop: yes. Mobile: no, a non-goal.
  - Providers: provider-neutral through T3's MCP tool server.
  - Contracts: the wire types go in `packages/contracts`.
  - Reverse states: remove and clear.
  - Connection modes: entries come from the server, so remote clients see the same brief.
- **Agent context budget.** The instruction text agents get is size-checked (`apps/server/src/provider/agentContextBudget.json` and the `agent-context-budget` workflow). Keep the added instructions short.

## How it fits (decided parts)

- **The add tool lives in T3's MCP tool server.** It goes alongside the existing thread-scoped tools in `apps/server/src/mcp/toolkits/` (for example `thread/tools.ts`: `t3_thread_organize`, `t3_queue`), so every provider reaches it. The thread comes from the MCP invocation context, not a tool argument. Inputs: `topic`, `date` (MM/DD, defaults to today), `changed`, `verified`, optional `rollback`, optional `note`. The result tells the agent the brief count and the log outcome (`logged as SB-0177`, or `NOT written to the annual log (reason)`), matching the mod.
- **Delegated work rolls up (Eric's answer).** When a delegated child thread (`delegate_task`, which gets its own MCP session with `subagent: true`) calls the add tool, the entry goes into the **root** thread's brief: follow the lineage `rootThreadId`. In the log, `session_id` and `session_title` hold the root thread's id and title. That way everything for one job is tracked in the one brief Eric copies from.
- **Agent instructions.** Add a short brief rule to the instructions every agent gets (`packages/provider-core/src/server/orchestrationInstructions.ts`). The meaning to keep, compressed from the current Claude Code rule:
  - When a step is finished AND verified by evidence in this conversation (command output, a screenshot, the user confirming it worked), call the brief tool once for it.
  - Never add in-progress work, plans, next steps, guesses, or unverified changes.
  - Keep each field short, in plain past-tense words, with commands, paths, and settings in backticks.
  - Don't add the same item twice, and don't mention the brief in replies unless asked.
- **Brief tab** = a new right-panel kind (`RIGHT_PANEL_KINDS` / `RightPanelSurface` in `apps/web/src/rightPanelStore.ts`, rendered from `components/chat/RightPanelSurfaceContent.tsx`). The tab component goes in a new file.
- **Log entries from T3:** `session_id` holds the T3 thread id, `session_title` holds the thread title at the time of the add, and `source` is `"t3"`. The existing values are `"live"` (the mod) and `"transcript"` (the backfill). Every other field matches the mod's format.

## Left to the builder

- How brief entries are stored on the server: a new table or migration, or something already in place for thread-scoped data. Pick whatever fits the existing persistence patterns with the least upstream surface.
- How the client gets live updates. A small dedicated stream is fine. Updates go only to clients subscribed to that thread's brief, and only when it changes. A brief is a few dozen short entries, so sending the full brief per change is acceptable (my call, changed during planning). Never add brief data to the general thread or timeline streams.
- The exact tool name. Follow the `t3_` naming of the other thread tools.
- How to open the Brief tab: from the right-panel tab strip at minimum. A command-palette entry is welcome if it's cheap.
- Tests: the copy-text formatter against the mod's output (byte-for-byte on a sample), SB numbering with a file that changes between read and write, and keeping unknown top-level keys.

## Calls made without Eric (check these)

- **Log path is a server setting.** It is set once on the desktop to the path above. If it's unset (for example on a laptop running its own server), entries still go in the brief and show "not logged" with the reason.
- **Remove matches by the entry's stored SB id**, not by topic, changed, and thread id. That way it can never delete an older log record. Eric agreed that Remove takes entries out of the log; matching by SB id was my call.
- **Overwrite check after each write.** T3 re-reads the log about two seconds after it writes. If its entry is gone, it appends it again under the next free SB number, so the badge's number can change.
- **"Already logged" is its own badge state.** It's used when the log already has the same `topic` and `changed`, which matches the mod's duplicate rule.
- **Mobile is out** for this version, based on "always copy from computer".
- **`source: "t3"`** is a new value in the log so the year-end report can tell where an entry came from.
- **Deleting a thread does not delete its log entries.** The log is permanent, like Clear.
