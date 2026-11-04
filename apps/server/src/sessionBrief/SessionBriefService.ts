import {
  SessionBriefEntry,
  SessionBriefError,
  ThreadId,
  type SessionBriefFields,
  type SessionBriefLogState,
  type SessionBriefView,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SessionBriefLog } from "./SessionBriefLog.ts";

export class SessionBriefService extends Context.Service<
  SessionBriefService,
  {
    /** Walks up through subagent parents only, so forks and side chats keep their own brief. */
    readonly resolveRoot: (threadId: ThreadId) => Effect.Effect<ThreadId, SessionBriefError>;
    readonly add: (
      callerThreadId: ThreadId,
      fields: SessionBriefFields,
    ) => Effect.Effect<{ count: number; log: SessionBriefLogState }, SessionBriefError>;
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<SessionBriefView, SessionBriefError>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<{ cleared: number }, SessionBriefError>;
    /** An entry that is not in this thread's brief changes nothing and gives `removedSbId: null`. */
    readonly remove: (
      threadId: ThreadId,
      entryId: string,
    ) => Effect.Effect<{ removedSbId: string | null }, SessionBriefError>;
  }
>()("t3/sessionBrief/SessionBriefService") {}

// `ownSbId` is the last SB id this entry wrote; it outlives a failed check so the id can be
// recognised (and removed) again, also after a restart. It never leaves the server.
const StoredEntry = Schema.Struct({
  ...SessionBriefEntry.fields,
  ownSbId: Schema.optional(Schema.String),
});
type StoredEntry = typeof StoredEntry.Type;

const StoreFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    rootThreadId: ThreadId,
    entries: Schema.Array(StoredEntry),
  }),
);

const decodeStoreFile = Schema.decodeEffect(StoreFile);
const encodeStoreFile = Schema.encodeEffect(StoreFile);

const VERIFY_DELAY = Duration.seconds(2);
const FIRST_RETRY_DELAY = Duration.seconds(5);
const MAX_RETRY_DELAY = Duration.minutes(5);
const OVERWRITTEN = "overwritten by another writer";

const briefError = (message: string) => (cause: unknown) =>
  new SessionBriefError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

// Store failures reach clients, so they carry a fixed message; the detail goes to the server log.
const storeError = (message: string, detail: Record<string, unknown>) => (cause: unknown) =>
  Effect.logWarning(`${message}.`, { ...detail, cause }).pipe(
    Effect.andThen(Effect.fail(new SessionBriefError({ message }))),
  );

// Real thread ids hold ":" and "%" (`mcp:<uuid>`, `<command>:fork`, encodeURIComponent parts),
// which are not file names everywhere, so a plain allowlist would refuse real threads. Ids with
// a path separator or control character are refused outright; in the rest, safe characters stay
// as they are and every other UTF-8 byte becomes `~XX`, so no name can hold "." or ":".
const isUnsafeChar = (char: string) =>
  char === "/" || char === "\\" || char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;
const SAFE_FILE_NAME = /^[A-Za-z0-9_~-]{1,200}$/;
const storeFileName = (rootThreadId: string): string | null => {
  if ([...rootThreadId].some(isUnsafeChar)) return null;
  let name = "";
  for (const byte of new TextEncoder().encode(rootThreadId)) {
    const char = String.fromCharCode(byte);
    name += /[A-Za-z0-9_-]/.test(char)
      ? char
      : `~${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return SAFE_FILE_NAME.test(name) ? name : null;
};

const isUnsettled = (log: SessionBriefLogState) =>
  log._tag === "Pending" || log._tag === "Retrying";

const withLog = (entry: StoredEntry, state: SessionBriefLogState): StoredEntry => ({
  ...entry,
  log: state,
  ...(state._tag === "Logged" ? { ownSbId: state.sbId } : {}),
});

const toEntry = ({ ownSbId: _ownSbId, ...entry }: StoredEntry): SessionBriefEntry => entry;

const visibleCount = (entries: ReadonlyArray<StoredEntry>) =>
  entries.filter((entry) => !entry.cleared).length;

export const layer = Layer.effect(
  SessionBriefService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const threads = yield* ThreadManagementService;
    const log = yield* SessionBriefLog;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const scope = yield* Effect.scope;

    const storeDir = path.join(config.stateDir, "session-briefs");
    const storePath = (rootThreadId: ThreadId) => {
      const name = storeFileName(rootThreadId);
      return name === null
        ? Effect.fail(new SessionBriefError({ message: "invalid thread id" }))
        : Effect.succeed(path.join(storeDir, `${name}.json`));
    };
    const briefs = new Map<ThreadId, ReadonlyArray<StoredEntry>>();
    const changes = new Map<ThreadId, PubSub.PubSub<void>>();
    const retries = new Map<string, Fiber.Fiber<void>>();
    // One lock for every brief keeps read-modify-write of a store file from losing entries.
    const lock = yield* Semaphore.make(1);

    const load = Effect.fn("SessionBriefService.load")(function* (rootThreadId: ThreadId) {
      const file = yield* storePath(rootThreadId);
      const cached = briefs.get(rootThreadId);
      if (cached !== undefined) return cached;
      const text = yield* fs.readFileString(file).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
        Effect.catch(storeError("Could not read session brief", { file })),
      );
      const entries =
        text === null
          ? []
          : (yield* decodeStoreFile(text).pipe(
              Effect.catch(storeError("Could not read session brief", { file })),
            )).entries;
      briefs.set(rootThreadId, entries);
      return entries;
    });

    const changesFor = Effect.fn("SessionBriefService.changesFor")(function* (
      rootThreadId: ThreadId,
    ) {
      const existing = changes.get(rootThreadId);
      if (existing !== undefined) return existing;
      // Every notification re-reads the whole brief, so only the newest signal matters.
      const created = yield* PubSub.sliding<void>(1);
      changes.set(rootThreadId, created);
      return created;
    });

    // Callers hold `lock`. A cleared entry stays stored until its log state is final and its
    // retry fiber is gone, so a re-append found after the clear still survives a restart.
    const save = Effect.fn("SessionBriefService.save")(function* (
      rootThreadId: ThreadId,
      next: ReadonlyArray<StoredEntry>,
    ) {
      const entries = next.filter(
        (entry) => !entry.cleared || isUnsettled(entry.log) || retries.has(entry.id),
      );
      const filePath = yield* storePath(rootThreadId);
      const contents = yield* encodeStoreFile({ version: 1, rootThreadId, entries }).pipe(
        Effect.catch(storeError("Could not save session brief", { file: filePath })),
      );
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catch(storeError("Could not save session brief", { file: filePath })),
      );
      briefs.set(rootThreadId, entries);
      yield* PubSub.publish(yield* changesFor(rootThreadId), undefined);
      return entries;
    });

    const update = <A>(
      rootThreadId: ThreadId,
      f: (entries: ReadonlyArray<StoredEntry>) => {
        readonly entries: ReadonlyArray<StoredEntry>;
        readonly result: A;
        /** Nothing changed, so the store file is left alone. */
        readonly unchanged?: boolean;
      },
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = f(yield* load(rootThreadId));
          if (next.unchanged !== true) yield* save(rootThreadId, next.entries);
          return next.result;
        }),
      );

    const findEntry = (rootThreadId: ThreadId, entryId: string) =>
      lock
        .withPermits(1)(load(rootThreadId))
        .pipe(Effect.map((entries) => entries.find((entry) => entry.id === entryId)));

    const viewOf = (rootThreadId: ThreadId) =>
      lock
        .withPermits(1)(load(rootThreadId))
        .pipe(
          Effect.map((entries): SessionBriefView => ({
            rootThreadId,
            entries: entries.filter((entry) => !entry.cleared).map(toEntry),
          })),
        );

    const shellOf = (threadId: ThreadId) =>
      threads.getThreadShell(threadId).pipe(Effect.mapError(briefError("Could not read thread")));

    const resolveRoot = Effect.fn("SessionBriefService.resolveRoot")(function* (
      threadId: ThreadId,
    ) {
      let current = threadId;
      let shell = yield* shellOf(current);
      const seen = new Set<ThreadId>([current]);
      while (
        shell !== null &&
        shell.lineage.relationshipToParent === "subagent" &&
        shell.lineage.parentThreadId !== null &&
        !seen.has(shell.lineage.parentThreadId)
      ) {
        current = shell.lineage.parentThreadId;
        seen.add(current);
        shell = yield* shellOf(current);
      }
      return current;
    });

    // Every public entry point checks the root first, so a bad id never names a file.
    const rootOf = (threadId: ThreadId) =>
      resolveRoot(threadId).pipe(Effect.tap((rootThreadId) => storePath(rootThreadId)));

    interface Drive {
      readonly rootThreadId: ThreadId;
      readonly entryId: string;
      readonly fields: SessionBriefFields;
      readonly meta: Effect.Effect<{ readonly sessionId: string; readonly sessionTitle: string }>;
      readonly state: SessionBriefLogState;
      readonly ownSbId: string | undefined;
    }

    // Runs until the entry settles or leaves the store.
    const driveLog = Effect.fn("SessionBriefService.driveLog")(function* (input: Drive) {
      const meta = yield* input.meta;
      // Returns false once the entry is gone, which ends the loop.
      const record = (state: SessionBriefLogState) =>
        update(input.rootThreadId, (entries) => ({
          entries: entries.map((entry) =>
            entry.id === input.entryId ? withLog(entry, state) : entry,
          ),
          result: entries.some((entry) => entry.id === input.entryId),
        })).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save session brief log state.", { error }).pipe(
              Effect.as(true),
            ),
          ),
        );
      let state = input.state;
      let attempts = state._tag === "Retrying" ? state.attempts : 0;
      let delay = FIRST_RETRY_DELAY;
      // The log returning this entry's own last SB id as "already logged" means it is still ours.
      let ownSbId = input.ownSbId ?? null;
      // Uninterruptible so remove never cancels between a log write and recording its SB id.
      const attempt = Effect.uninterruptible(
        Effect.gen(function* () {
          let next = yield* log.append(input.fields, meta);
          if (next._tag === "AlreadyLogged" && next.sbId === ownSbId) {
            next = { _tag: "Logged", sbId: next.sbId };
          }
          if (next._tag === "Retrying") {
            attempts += 1;
            next = { ...next, attempts };
          }
          return { next, present: yield* record(next) };
        }),
      );

      while (true) {
        let present = true;
        if (state._tag === "Pending") {
          ({ next: state, present } = yield* attempt);
        } else if (state._tag === "Logged") {
          ownSbId = state.sbId;
          delay = FIRST_RETRY_DELAY;
          yield* Effect.sleep(VERIFY_DELAY);
          if (yield* log.verify(state.sbId, input.fields, meta.sessionId)) return;
          attempts += 1;
          if (!(yield* record({ _tag: "Retrying", reason: OVERWRITTEN, attempts }))) return;
          ({ next: state, present } = yield* attempt);
        } else if (state._tag === "Retrying") {
          yield* Effect.sleep(delay);
          delay = Duration.min(Duration.times(delay, 2), MAX_RETRY_DELAY);
          ({ next: state, present } = yield* attempt);
        } else {
          return;
        }
        if (!present) return;
      }
    });

    // A cleared entry waits for its fiber to end before it may be pruned.
    const pruneSettled = (rootThreadId: ThreadId, entryId: string) =>
      briefs.get(rootThreadId)?.some((entry) => entry.id === entryId && entry.cleared)
        ? update(rootThreadId, (entries) => ({ entries, result: undefined })).pipe(
            Effect.catch((error) => Effect.logWarning("Could not prune session brief.", { error })),
          )
        : Effect.void;

    const startDriving = Effect.fn("SessionBriefService.startDriving")(function* (input: Drive) {
      // The fiber waits until it is registered, so its own cleanup always finds it.
      const registered = yield* Deferred.make<void>();
      const fiber = yield* Deferred.await(registered).pipe(
        Effect.andThen(driveLog(input)),
        Effect.ensuring(
          Effect.suspend(() => {
            retries.delete(input.entryId);
            return pruneSettled(input.rootThreadId, input.entryId);
          }),
        ),
        Effect.forkIn(scope),
      );
      retries.set(input.entryId, fiber);
      yield* Deferred.succeed(registered, undefined);
    });

    const add = Effect.fn("SessionBriefService.add")(function* (
      callerThreadId: ThreadId,
      fields: SessionBriefFields,
    ) {
      const rootThreadId = yield* rootOf(callerThreadId);
      const rootShell = yield* shellOf(rootThreadId);
      const meta = { sessionId: rootThreadId, sessionTitle: rootShell?.title ?? rootThreadId };
      const entry: StoredEntry = {
        ...fields,
        id: yield* random.uuidV4(),
        createdAt: DateTime.formatIso(yield* DateTime.now),
        sourceThreadId: callerThreadId,
        cleared: false,
        log: { _tag: "Pending" },
      };
      yield* update(rootThreadId, (entries) => ({ entries: [...entries, entry], result: 0 }));

      const appended = yield* log.append(fields, meta);
      const state: SessionBriefLogState =
        appended._tag === "Retrying" ? { ...appended, attempts: 1 } : appended;
      // Decided under the lock: a remove that ran during the append must not get a fiber.
      const outcome = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* load(rootThreadId);
          if (!entries.some((item) => item.id === entry.id)) {
            return { count: visibleCount(entries), present: false };
          }
          if (state._tag === "Logged" || state._tag === "Retrying") {
            yield* startDriving({
              rootThreadId,
              entryId: entry.id,
              fields,
              meta: Effect.succeed(meta),
              state,
              ownSbId: undefined,
            });
          }
          const next = yield* save(
            rootThreadId,
            entries.map((item) => (item.id === entry.id ? withLog(item, state) : item)),
          );
          return { count: visibleCount(next), present: true };
        }),
      );
      if (!outcome.present && state._tag === "Logged") {
        const removal = yield* log.remove(state.sbId, fields);
        if (removal._tag === "Unavailable") {
          yield* Effect.logWarning("Could not take a removed brief entry back out of the log.", {
            sbId: state.sbId,
            reason: removal.reason,
          });
        }
      }
      return { count: outcome.count, log: state };
    });

    const subscribe = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const rootThreadId = yield* rootOf(threadId);
          // Subscribe before reading so a change during the first read is not missed.
          const subscription = yield* PubSub.subscribe(yield* changesFor(rootThreadId));
          return Stream.concat(
            Stream.fromEffect(viewOf(rootThreadId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.mapEffect(() => viewOf(rootThreadId)),
            ),
          );
        }),
      );

    const clear = Effect.fn("SessionBriefService.clear")(function* (threadId: ThreadId) {
      const rootThreadId = yield* rootOf(threadId);
      const cleared = yield* update(rootThreadId, (entries) => ({
        entries: entries.map((entry) => (entry.cleared ? entry : { ...entry, cleared: true })),
        result: visibleCount(entries),
        unchanged: visibleCount(entries) === 0,
      }));
      return { cleared };
    });

    const titleMeta = (rootThreadId: ThreadId) =>
      shellOf(rootThreadId).pipe(
        Effect.map((shell) => ({
          sessionId: rootThreadId,
          sessionTitle: shell?.title ?? rootThreadId,
        })),
        Effect.orElseSucceed(() => ({ sessionId: rootThreadId, sessionTitle: rootThreadId })),
      );

    const remove = Effect.fn("SessionBriefService.remove")(function* (
      threadId: ThreadId,
      entryId: string,
    ) {
      const rootThreadId = yield* rootOf(threadId);
      if ((yield* findEntry(rootThreadId, entryId)) === undefined) return { removedSbId: null };
      const fiber = retries.get(entryId);
      if (fiber !== undefined) yield* Fiber.interrupt(fiber);
      // Re-read: the interrupted fiber may have recorded a final state.
      const entry = yield* findEntry(rootThreadId, entryId);
      if (entry === undefined) return { removedSbId: null };
      const sbId =
        entry.log._tag === "Logged"
          ? entry.log.sbId
          : isUnsettled(entry.log)
            ? (entry.ownSbId ?? null)
            : null;
      let removedSbId: string | null = null;
      if (sbId !== null) {
        const removal = yield* log.remove(sbId, entry);
        if (removal._tag === "Unavailable") {
          // Decided under the lock: a concurrent remove of the same entry may already have
          // restarted its fiber, or dropped the entry.
          if (fiber !== undefined) {
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                const current = (yield* load(rootThreadId)).find((item) => item.id === entryId);
                if (current === undefined || retries.has(entryId)) return;
                yield* startDriving({
                  rootThreadId,
                  entryId,
                  fields: current,
                  meta: titleMeta(rootThreadId),
                  state: current.log,
                  ownSbId: current.ownSbId,
                });
              }),
            );
          }
          return yield* new SessionBriefError({
            message: `Couldn't remove it from the annual log: ${removal.reason}. Try again.`,
          });
        }
        if (removal._tag === "Removed") removedSbId = sbId;
      }
      yield* update(rootThreadId, (entries) => ({
        entries: entries.filter((item) => item.id !== entryId),
        result: undefined,
        unchanged: !entries.some((item) => item.id === entryId),
      }));
      return { removedSbId };
    });

    const resumeAll = Effect.gen(function* () {
      yield* fs.makeDirectory(storeDir, { recursive: true });
      for (const name of yield* fs.readDirectory(storeDir)) {
        if (!name.endsWith(".json")) continue;
        const store = yield* fs
          .readFileString(path.join(storeDir, name))
          .pipe(Effect.flatMap(decodeStoreFile), Effect.option);
        if (store._tag === "None") {
          yield* Effect.logWarning("Skipping unreadable session brief store.", { file: name });
          continue;
        }
        const { rootThreadId, entries } = store.value;
        briefs.set(rootThreadId, entries);
        for (const entry of entries) {
          if (!isUnsettled(entry.log)) continue;
          yield* startDriving({
            rootThreadId,
            entryId: entry.id,
            fields: entry,
            meta: titleMeta(rootThreadId),
            state: entry.log,
            ownSbId: entry.ownSbId,
          });
        }
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not resume session brief log retries.", { error }),
      ),
    );
    yield* resumeAll;

    return SessionBriefService.of({ resolveRoot, add, subscribe, clear, remove });
  }),
);
