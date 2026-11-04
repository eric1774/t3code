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
    readonly remove: (
      threadId: ThreadId,
      entryId: string,
    ) => Effect.Effect<{ removedSbId: string | null }, SessionBriefError>;
  }
>()("t3/sessionBrief/SessionBriefService") {}

const StoreFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    rootThreadId: ThreadId,
    entries: Schema.Array(SessionBriefEntry),
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

// Cleared entries stay stored only while their log write is still in flight.
const isUnsettled = (log: SessionBriefLogState) =>
  log._tag === "Pending" || log._tag === "Retrying";

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
    const storePath = (rootThreadId: ThreadId) => path.join(storeDir, `${rootThreadId}.json`);
    const briefs = new Map<ThreadId, ReadonlyArray<SessionBriefEntry>>();
    const changes = new Map<ThreadId, PubSub.PubSub<void>>();
    const retries = new Map<string, Fiber.Fiber<void>>();
    // One lock for every brief keeps read-modify-write of a store file from losing entries.
    const lock = yield* Semaphore.make(1);

    const decodeStore = (text: string) =>
      decodeStoreFile(text).pipe(
        Effect.mapError(briefError("Session brief store is not readable")),
      );

    const load = Effect.fn("SessionBriefService.load")(function* (rootThreadId: ThreadId) {
      const cached = briefs.get(rootThreadId);
      if (cached !== undefined) return cached;
      const text = yield* fs.readFileString(storePath(rootThreadId)).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
        Effect.mapError(briefError("Could not read session brief")),
      );
      const entries = text === null ? [] : (yield* decodeStore(text)).entries;
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

    const update = <A>(
      rootThreadId: ThreadId,
      f: (entries: ReadonlyArray<SessionBriefEntry>) => {
        readonly entries: ReadonlyArray<SessionBriefEntry>;
        readonly result: A;
      },
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = f(yield* load(rootThreadId));
          const entries = next.entries.filter((entry) => !entry.cleared || isUnsettled(entry.log));
          const contents = yield* encodeStoreFile({
            version: 1,
            rootThreadId,
            entries,
          }).pipe(Effect.mapError(briefError("Could not encode session brief")));
          yield* writeFileStringAtomically({ filePath: storePath(rootThreadId), contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(briefError("Could not save session brief")),
          );
          briefs.set(rootThreadId, entries);
          yield* PubSub.publish(yield* changesFor(rootThreadId), undefined);
          return next.result;
        }),
      );

    const viewOf = (rootThreadId: ThreadId) =>
      lock
        .withPermits(1)(load(rootThreadId))
        .pipe(
          Effect.map((entries): SessionBriefView => ({
            rootThreadId,
            entries: entries.filter((entry) => !entry.cleared),
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

    const setLog = (rootThreadId: ThreadId, entryId: string, state: SessionBriefLogState) =>
      update(rootThreadId, (entries) => ({
        entries: entries.map((entry) => (entry.id === entryId ? { ...entry, log: state } : entry)),
        result: undefined,
      }));

    // Runs until the entry settles; it keeps going after a clear prunes the entry from the store.
    const driveLog = Effect.fn("SessionBriefService.driveLog")(function* (input: {
      readonly rootThreadId: ThreadId;
      readonly entryId: string;
      readonly fields: SessionBriefFields;
      readonly meta: Effect.Effect<{ readonly sessionId: string; readonly sessionTitle: string }>;
      readonly state: SessionBriefLogState;
    }) {
      const meta = yield* input.meta;
      const record = (state: SessionBriefLogState) =>
        setLog(input.rootThreadId, input.entryId, state).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save session brief log state.", { error }),
          ),
        );
      let state = input.state;
      let attempts = state._tag === "Retrying" ? state.attempts : 0;
      let delay = FIRST_RETRY_DELAY;
      // The SB id the entry held before a failed check: the log returning it means it is still ours.
      let ownSbId: string | null = null;
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
          yield* record(next);
          return next;
        }),
      );

      while (true) {
        if (state._tag === "Pending") {
          state = yield* attempt;
        } else if (state._tag === "Logged") {
          delay = FIRST_RETRY_DELAY;
          yield* Effect.sleep(VERIFY_DELAY);
          if (yield* log.verify(state.sbId, input.fields, meta.sessionId)) return;
          ownSbId = state.sbId;
          attempts += 1;
          yield* record({ _tag: "Retrying", reason: OVERWRITTEN, attempts });
          state = yield* attempt;
        } else if (state._tag === "Retrying") {
          yield* Effect.sleep(delay);
          delay = Duration.min(Duration.times(delay, 2), MAX_RETRY_DELAY);
          state = yield* attempt;
        } else {
          return;
        }
      }
    });

    const startDriving = (input: Parameters<typeof driveLog>[0]) =>
      driveLog(input).pipe(
        Effect.ensuring(Effect.sync(() => retries.delete(input.entryId))),
        Effect.forkIn(scope),
        Effect.tap((fiber) => Effect.sync(() => retries.set(input.entryId, fiber))),
      );

    const add = Effect.fn("SessionBriefService.add")(function* (
      callerThreadId: ThreadId,
      fields: SessionBriefFields,
    ) {
      const rootThreadId = yield* resolveRoot(callerThreadId);
      const rootShell = yield* shellOf(rootThreadId);
      const meta = { sessionId: rootThreadId, sessionTitle: rootShell?.title ?? rootThreadId };
      const entry: SessionBriefEntry = {
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
      const count = yield* update(rootThreadId, (entries) => {
        const next = entries.map((item) => (item.id === entry.id ? { ...item, log: state } : item));
        return { entries: next, result: next.filter((item) => !item.cleared).length };
      });
      if (state._tag === "Logged" || state._tag === "Retrying") {
        yield* startDriving({
          rootThreadId,
          entryId: entry.id,
          fields,
          meta: Effect.succeed(meta),
          state,
        });
      }
      return { count, log: state };
    });

    const subscribe = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const rootThreadId = yield* resolveRoot(threadId);
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
      const rootThreadId = yield* resolveRoot(threadId);
      const cleared = yield* update(rootThreadId, (entries) => ({
        entries: entries.map((entry) => (entry.cleared ? entry : { ...entry, cleared: true })),
        result: entries.filter((entry) => !entry.cleared).length,
      }));
      return { cleared };
    });

    const remove = Effect.fn("SessionBriefService.remove")(function* (
      threadId: ThreadId,
      entryId: string,
    ) {
      const rootThreadId = yield* resolveRoot(threadId);
      const fiber = retries.get(entryId);
      if (fiber !== undefined) yield* Fiber.interrupt(fiber);
      const entry = (yield* lock.withPermits(1)(load(rootThreadId))).find(
        (item) => item.id === entryId,
      );
      if (entry === undefined) return { removedSbId: null };
      const removedSbId =
        entry.log._tag === "Logged" && (yield* log.remove(entry.log.sbId, entry))
          ? entry.log.sbId
          : null;
      yield* update(rootThreadId, (entries) => ({
        entries: entries.filter((item) => item.id !== entryId),
        result: undefined,
      }));
      return { removedSbId };
    });

    const resumeAll = Effect.gen(function* () {
      yield* fs.makeDirectory(storeDir, { recursive: true });
      for (const name of yield* fs.readDirectory(storeDir)) {
        if (!name.endsWith(".json")) continue;
        const store = yield* fs
          .readFileString(path.join(storeDir, name))
          .pipe(Effect.flatMap(decodeStore), Effect.option);
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
            meta: shellOf(rootThreadId).pipe(
              Effect.map((shell) => ({
                sessionId: rootThreadId,
                sessionTitle: shell?.title ?? rootThreadId,
              })),
              Effect.orElseSucceed(() => ({ sessionId: rootThreadId, sessionTitle: rootThreadId })),
            ),
            state: entry.log,
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
