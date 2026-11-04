import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ThreadId,
  type OrchestrationV2ThreadShell,
  type SessionBriefEntry,
  type SessionBriefView,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseVaultLog } from "./briefLog.ts";
import * as SessionBriefLog from "./SessionBriefLog.ts";
import { SessionBriefService, layer as sessionBriefLayer } from "./SessionBriefService.ts";

const root = ThreadId.make("thread-root");
const child = ThreadId.make("thread-child");
const fork = ThreadId.make("thread-fork");

const shell = (
  id: ThreadId,
  title: string,
  lineage: {
    parentThreadId: ThreadId | null;
    relationshipToParent: "fork" | "subagent" | null;
  },
) =>
  ({
    id,
    title,
    lineage: { ...lineage, rootThreadId: root },
  }) as unknown as OrchestrationV2ThreadShell;

const shells = new Map<string, OrchestrationV2ThreadShell>([
  [root, shell(root, "Proxmox migration", { parentThreadId: null, relationshipToParent: null })],
  [child, shell(child, "Child", { parentThreadId: root, relationshipToParent: "subagent" })],
  [fork, shell(fork, "Fork", { parentThreadId: root, relationshipToParent: "fork" })],
]);

const fieldsA = { topic: "DHCP move", date: "11/03", changed: "Moved A", verified: "Checked A" };
const fieldsB = { topic: "GPO", date: "11/03", changed: "Moved B", verified: "Checked B" };
const fieldsC = { topic: "DNS", date: "11/03", changed: "Moved C", verified: "Checked C" };

const logEntry = (id: string, topic: string, changed: string, source = "live") => ({
  id,
  topic,
  changed,
  verified: "v",
  session_id: "other",
  source,
});
const seed = (entries: ReadonlyArray<Record<string, unknown>> = []) =>
  JSON.stringify({ title: "Log", entries }, null, 2) + "\n";

const watchViews = (service: SessionBriefService["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(service.subscribe(threadId));
    const buffered: Array<SessionBriefView> = [];
    const next = Effect.gen(function* () {
      if (buffered.length === 0) buffered.push(...(yield* pull));
      return buffered.shift()!;
    });
    /** Pulls views until one matches; each pull waits for the next change. */
    const until = (predicate: (view: SessionBriefView) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const view = yield* next;
          if (predicate(view)) return view;
        }
      });
    /** Like `until`, but checks the store file after each change. */
    const untilStored = (
      fs: FileSystem.FileSystem,
      file: string,
      predicate: (stored: StoredBrief) => boolean,
    ) =>
      Effect.gen(function* () {
        while (true) {
          yield* next;
          const stored: StoredBrief = JSON.parse(yield* fs.readFileString(file));
          if (predicate(stored)) return stored;
        }
      });
    return { next, until, untilStored };
  });

interface StoredBrief {
  readonly entries: ReadonlyArray<SessionBriefEntry & { readonly ownSbId?: string }>;
}

const restartedEntryId = "0b6f8a47-3c1e-4a8e-9c55-0f6e2f4d8c11";
const writeStore =
  (entries: ReadonlyArray<Record<string, unknown>>) =>
  (input: {
    readonly fs: FileSystem.FileSystem;
    readonly storeFile: (rootThreadId: string) => string;
  }) =>
    input.fs
      .makeDirectory(input.storeFile(root).replace(/[\\/][^\\/]+$/, ""), { recursive: true })
      .pipe(
        Effect.andThen(
          input.fs.writeFileString(
            input.storeFile(root),
            JSON.stringify({ version: 1, rootThreadId: root, entries }),
          ),
        ),
      );
const restartedEntry = (fields: Record<string, unknown>) => ({
  ...fieldsA,
  id: restartedEntryId,
  createdAt: "2026-11-04T10:00:00.000Z",
  sourceThreadId: root,
  cleared: false,
  ...fields,
});
const ownLogEntry = (id: string) => ({
  ...logEntry(id, fieldsA.topic, fieldsA.changed, "t3"),
  session_id: root,
});

const readLogIds = (fs: FileSystem.FileSystem, logFile: string) =>
  fs
    .readFileString(logFile)
    .pipe(Effect.map((text) => parseVaultLog(text).entries.map((entry) => entry.id)));

const harness = <A, E>(
  options: {
    readonly log: string | null;
    readonly before?: (input: {
      readonly fs: FileSystem.FileSystem;
      readonly storeFile: (rootThreadId: string) => string;
    }) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly wrapLog?: (
      log: SessionBriefLog.SessionBriefLog["Service"],
    ) => SessionBriefLog.SessionBriefLog["Service"];
  },
  body: (harness: {
    readonly service: SessionBriefService["Service"];
    readonly fs: FileSystem.FileSystem;
    readonly logFile: string;
    readonly storeFile: (rootThreadId: string) => string;
    readonly logIds: ReturnType<typeof readLogIds>;
    readonly watch: (threadId: ThreadId) => ReturnType<typeof watchViews>;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "session-brief-service-" });
    const logFile = path.join(dir, "log.json");
    if (options.log !== null) yield* fs.writeFileString(logFile, options.log);
    const config = yield* ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), path.join(dir, "t3"))),
    );
    const storeFile = (rootThreadId: string) =>
      path.join(config.stateDir, "session-briefs", `${rootThreadId}.json`);
    if (options.before) yield* options.before({ fs, storeFile });

    const layer = sessionBriefLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(
            SessionBriefLog.SessionBriefLog,
            Effect.gen(function* () {
              const log = yield* SessionBriefLog.SessionBriefLog;
              return options.wrapLog ? options.wrapLog(log) : log;
            }),
          ).pipe(
            Layer.provide(SessionBriefLog.layer),
            Layer.provide(ServerSettingsService.layerTest({ sessionBriefLogPath: logFile })),
          ),
          Layer.succeed(ServerConfig, config),
          Layer.mock(ThreadManagementService)({
            getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          }),
          NodeCrypto.layer,
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const service = yield* SessionBriefService;
      return yield* body({
        service,
        fs,
        logFile,
        storeFile,
        logIds: readLogIds(fs, logFile),
        watch: (threadId) => watchViews(service, threadId),
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const logOf = (view: SessionBriefView, index = 0) => view.entries[index]?.log;
const isLog =
  (tag: SessionBriefEntry["log"]["_tag"], sbId?: string) => (view: SessionBriefView) => {
    const log = logOf(view);
    return log?._tag === tag && (sbId === undefined || ("sbId" in log && log.sbId === sbId));
  };

it.effect("subagent entry lands in root brief", () =>
  harness({ log: seed() }, ({ service }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* service.resolveRoot(child), root);
      const result = yield* service.add(child, fieldsA);
      assert.deepStrictEqual(result, { count: 1, log: { _tag: "Logged", sbId: "SB-0001" } });
      const fromChild = yield* Stream.runHead(service.subscribe(child));
      const fromRoot = yield* Stream.runHead(service.subscribe(root));
      assert.deepStrictEqual(fromChild, fromRoot);
      const view = Option.getOrThrow(fromRoot);
      assert.strictEqual(view.rootThreadId, root);
      assert.strictEqual(view.entries.length, 1);
      assert.strictEqual(view.entries[0]?.sourceThreadId, child);
    }),
  ),
);

it.effect("fork keeps its own brief", () =>
  harness({ log: seed() }, ({ service }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* service.resolveRoot(fork), fork);
      yield* service.add(fork, fieldsA);
      const forkView = Option.getOrThrow(yield* Stream.runHead(service.subscribe(fork)));
      const rootView = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root)));
      assert.strictEqual(forkView.entries.length, 1);
      assert.strictEqual(rootView.entries.length, 0);
    }),
  ),
);

it.effect("retry lands after lock clears", () =>
  harness({ log: null }, ({ service, fs, logFile, logIds, watch }) =>
    Effect.gen(function* () {
      const result = yield* service.add(root, fieldsA);
      assert.deepStrictEqual(result.log, {
        _tag: "Retrying",
        reason: "log file not found",
        attempts: 1,
      });
      const views = yield* watch(root);
      yield* TestClock.adjust("5 seconds");
      yield* views.until((view) => {
        const log = logOf(view);
        return log?._tag === "Retrying" && log.attempts === 2;
      });
      yield* fs.writeFileString(logFile, seed());
      yield* TestClock.adjust("10 seconds");
      yield* views.until(isLog("Logged", "SB-0001"));
      assert.deepStrictEqual(yield* logIds, ["SB-0001"]);
    }),
  ),
);

it.effect("re-appends after overwrite", () =>
  harness(
    { log: seed([logEntry("SB-0175", "old", "old")]) },
    ({ service, fs, logFile, logIds, watch }) =>
      Effect.gen(function* () {
        const result = yield* service.add(root, fieldsA);
        assert.deepStrictEqual(result.log, { _tag: "Logged", sbId: "SB-0176" });
        yield* fs.writeFileString(
          logFile,
          seed([logEntry("SB-0175", "old", "old"), logEntry("SB-0176", "theirs", "theirs")]),
        );
        const views = yield* watch(root);
        yield* TestClock.adjust("2 seconds");
        yield* views.until(isLog("Logged", "SB-0177"));
        assert.deepStrictEqual(yield* logIds, ["SB-0175", "SB-0176", "SB-0177"]);
      }),
  ),
);

it.effect("keeps its SB id when the log was briefly unreadable at the check", () =>
  harness({ log: seed() }, ({ service, fs, logFile, logIds, watch }) =>
    Effect.gen(function* () {
      const result = yield* service.add(root, fieldsA);
      assert.deepStrictEqual(result.log, { _tag: "Logged", sbId: "SB-0001" });
      const landed = yield* fs.readFileString(logFile);
      yield* fs.writeFileString(logFile, "{ half written");
      const views = yield* watch(root);
      yield* TestClock.adjust("2 seconds");
      yield* views.until((view) => {
        const log = logOf(view);
        return log?._tag === "Retrying" && log.reason === "log file is not valid JSON";
      });
      yield* fs.writeFileString(logFile, landed);
      yield* TestClock.adjust("5 seconds");
      yield* views.until(isLog("Logged", "SB-0001"));
      assert.deepStrictEqual(yield* logIds, ["SB-0001"]);
    }),
  ),
);

it.effect("clear hides entries, numbering restarts, log untouched", () =>
  harness({ log: seed() }, ({ service, logIds }) =>
    Effect.gen(function* () {
      yield* service.add(root, fieldsA);
      assert.strictEqual((yield* service.add(child, fieldsB)).count, 2);
      assert.deepStrictEqual(yield* service.clear(child), { cleared: 2 });
      const cleared = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root)));
      assert.strictEqual(cleared.entries.length, 0);
      assert.strictEqual((yield* service.add(root, fieldsC)).count, 1);
      assert.deepStrictEqual(yield* logIds, ["SB-0001", "SB-0002", "SB-0003"]);
    }),
  ),
);

it.effect("clear keeps retrying hidden entry until it lands, then prunes it", () =>
  harness({ log: null }, ({ service, fs, logFile, logIds, storeFile, watch }) =>
    Effect.gen(function* () {
      yield* service.add(root, fieldsA);
      assert.deepStrictEqual(yield* service.clear(root), { cleared: 1 });
      const stored = JSON.parse(yield* fs.readFileString(storeFile(root)));
      assert.strictEqual(stored.entries.length, 1);
      assert.strictEqual(stored.entries[0].cleared, true);

      const views = yield* watch(root);
      assert.strictEqual((yield* views.next).entries.length, 0);
      yield* fs.writeFileString(logFile, seed());
      yield* TestClock.adjust("5 seconds");
      yield* views.untilStored(
        fs,
        storeFile(root),
        (brief) => brief.entries[0]?.log._tag === "Logged",
      );
      yield* TestClock.adjust("2 seconds");
      yield* views.untilStored(fs, storeFile(root), (brief) => brief.entries.length === 0);
      assert.deepStrictEqual(yield* logIds, ["SB-0001"]);
      const pruned = JSON.parse(yield* fs.readFileString(storeFile(root)));
      assert.deepStrictEqual(pruned, { version: 1, rootThreadId: root, entries: [] });
    }),
  ),
);

it.effect("remove deletes only its own SB id", () =>
  harness({ log: seed([logEntry("SB-0005", fieldsA.topic, fieldsA.changed)]) }, (input) =>
    Effect.gen(function* () {
      const { service, fs, logFile, logIds } = input;
      const already = yield* service.add(root, fieldsA);
      assert.deepStrictEqual(already.log, { _tag: "AlreadyLogged", sbId: "SB-0005" });
      const before = yield* fs.readFileString(logFile);
      const [alreadyEntry] = Option.getOrThrow(
        yield* Stream.runHead(service.subscribe(root)),
      ).entries;
      assert.deepStrictEqual(yield* service.remove(root, alreadyEntry!.id), { removedSbId: null });
      assert.strictEqual(yield* fs.readFileString(logFile), before);

      const own = yield* service.add(root, fieldsB);
      assert.deepStrictEqual(own.log, { _tag: "Logged", sbId: "SB-0006" });
      const [ownEntry] = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root))).entries;
      assert.deepStrictEqual(yield* service.remove(child, ownEntry!.id), {
        removedSbId: "SB-0006",
      });
      assert.deepStrictEqual(yield* logIds, ["SB-0005"]);
      const view = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root)));
      assert.strictEqual(view.entries.length, 0);
    }),
  ),
);

it.effect("resumes pending entries on restart", () =>
  harness(
    {
      log: seed(),
      before: writeStore([
        restartedEntry({ log: { _tag: "Retrying", reason: "log file not found", attempts: 3 } }),
      ]),
    },
    ({ logIds, watch }) =>
      Effect.gen(function* () {
        const views = yield* watch(root);
        yield* TestClock.adjust("5 seconds");
        yield* views.until(isLog("Logged", "SB-0001"));
        assert.deepStrictEqual(yield* logIds, ["SB-0001"]);
      }),
  ),
);

const overwrittenBeforeRestart = writeStore([
  restartedEntry({
    log: { _tag: "Retrying", reason: "overwritten by another writer", attempts: 1 },
    ownSbId: "SB-0001",
  }),
]);

it.effect("keeps its own SB id across a restart", () =>
  harness(
    { log: seed([ownLogEntry("SB-0001")]), before: overwrittenBeforeRestart },
    ({ logIds, watch }) =>
      Effect.gen(function* () {
        const views = yield* watch(root);
        yield* TestClock.adjust("5 seconds");
        yield* views.until(isLog("Logged", "SB-0001"));
        assert.deepStrictEqual(yield* logIds, ["SB-0001"]);
      }),
  ),
);

it.effect("remove after a restart uses the stored SB id", () =>
  harness(
    { log: seed([ownLogEntry("SB-0001")]), before: overwrittenBeforeRestart },
    ({ service, logIds }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* service.remove(root, restartedEntryId), {
          removedSbId: "SB-0001",
        });
        assert.deepStrictEqual(yield* logIds, []);
      }),
  ),
);

it.effect("remove during the first log write leaves no log record", () => {
  const appendStarted = Deferred.makeUnsafe<void>();
  const releaseAppend = Deferred.makeUnsafe<void>();
  return harness(
    {
      log: seed(),
      wrapLog: (log) => ({
        ...log,
        append: (fields, meta) =>
          Deferred.succeed(appendStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseAppend)),
            Effect.andThen(log.append(fields, meta)),
          ),
      }),
    },
    ({ service, logIds }) =>
      Effect.gen(function* () {
        const adding = yield* Effect.forkChild(service.add(root, fieldsA));
        yield* Deferred.await(appendStarted);
        const [pending] = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root))).entries;
        assert.deepStrictEqual(pending?.log, { _tag: "Pending" });
        assert.deepStrictEqual(yield* service.remove(root, pending!.id), { removedSbId: null });
        yield* Deferred.succeed(releaseAppend, undefined);
        yield* Fiber.join(adding);
        assert.deepStrictEqual(yield* logIds, []);
        yield* TestClock.adjust("10 seconds");
        assert.deepStrictEqual(yield* logIds, []);
        const view = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root)));
        assert.strictEqual(view.entries.length, 0);
      }),
  );
});

it.effect("remove keeps the entry when the log cannot be read", () =>
  harness({ log: seed() }, ({ service, fs, logFile }) =>
    Effect.gen(function* () {
      yield* service.add(root, fieldsA);
      yield* fs.writeFileString(logFile, "{ half written");
      const [entry] = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root))).entries;
      const failure = yield* Effect.flip(service.remove(root, entry!.id));
      assert.strictEqual(
        failure.message,
        "Couldn't remove it from the annual log: log file is not valid JSON. Try again.",
      );
      const view = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root)));
      assert.deepStrictEqual(JSON.stringify(view.entries), JSON.stringify([entry]));
    }),
  ),
);

it.effect("remove drops the entry when its SB id is no longer in the log", () =>
  harness({ log: seed() }, ({ service, fs, logFile }) =>
    Effect.gen(function* () {
      yield* service.add(root, fieldsA);
      yield* fs.writeFileString(logFile, seed());
      const [entry] = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root))).entries;
      assert.deepStrictEqual(yield* service.remove(root, entry!.id), { removedSbId: null });
      const view = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root)));
      assert.strictEqual(view.entries.length, 0);
    }),
  ),
);

it.effect("remove from another brief changes nothing", () =>
  harness({ log: null }, ({ service, fs, logFile, watch }) =>
    Effect.gen(function* () {
      yield* service.add(root, fieldsA);
      const [entry] = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root))).entries;
      assert.deepStrictEqual(yield* service.remove(fork, entry!.id), { removedSbId: null });
      const views = yield* watch(root);
      yield* fs.writeFileString(logFile, seed());
      yield* TestClock.adjust("5 seconds");
      yield* views.until(isLog("Logged", "SB-0001"));
    }),
  ),
);

it.effect("cleared entry re-appends after an overwrite and stays stored until it lands", () =>
  harness({ log: seed() }, ({ service, fs, logFile, logIds, storeFile, watch }) =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* service.add(root, fieldsA)).log, {
        _tag: "Logged",
        sbId: "SB-0001",
      });
      assert.deepStrictEqual(yield* service.clear(root), { cleared: 1 });
      const stored: StoredBrief = JSON.parse(yield* fs.readFileString(storeFile(root)));
      assert.strictEqual(stored.entries.length, 1);
      yield* fs.writeFileString(logFile, seed([logEntry("SB-0001", "theirs", "theirs")]));
      const views = yield* watch(root);
      yield* TestClock.adjust("2 seconds");
      const relogged = yield* views.untilStored(fs, storeFile(root), (brief) => {
        const log = brief.entries[0]?.log;
        return log?._tag === "Logged" && log.sbId === "SB-0002";
      });
      assert.strictEqual(relogged.entries[0]?.cleared, true);
      yield* TestClock.adjust("2 seconds");
      yield* views.untilStored(fs, storeFile(root), (brief) => brief.entries.length === 0);
      assert.deepStrictEqual(yield* logIds, ["SB-0001", "SB-0002"]);
    }),
  ),
);

const stateDirOf = (storeFile: (rootThreadId: string) => string) =>
  storeFile(root).replace(/[\\/]session-briefs[\\/][^\\/]+$/, "");

it.effect("an unsafe thread id names no file outside the store", () =>
  harness({ log: seed() }, ({ service, fs, storeFile }) =>
    Effect.gen(function* () {
      const outside = `${stateDirOf(storeFile)}/x.json`;
      yield* fs.writeFileString(outside, "keep me");
      for (const bad of ["../x", "..\\x", "a/b", "a\\b", "x\u0000y", "x".repeat(300)]) {
        const cleared = yield* Effect.flip(service.clear(ThreadId.make(bad)));
        assert.strictEqual(cleared.message, "invalid thread id");
        const read = yield* Effect.flip(Stream.runHead(service.subscribe(ThreadId.make(bad))));
        assert.strictEqual(read.message, "invalid thread id");
        const removed = yield* Effect.flip(service.remove(ThreadId.make(bad), "x"));
        assert.strictEqual(removed.message, "invalid thread id");
      }
      assert.strictEqual(yield* fs.readFileString(outside), "keep me");
      assert.deepStrictEqual(
        (yield* fs.readDirectory(`${stateDirOf(storeFile)}/session-briefs`)).filter((name) =>
          name.endsWith(".json"),
        ),
        [],
      );
    }),
  ),
);

it.effect("a thread id with a colon keeps its brief in an encoded file", () =>
  harness({ log: seed() }, ({ service, fs, storeFile }) =>
    Effect.gen(function* () {
      const mcpThread = ThreadId.make("mcp:0b6f8a47-3c1e-4a8e-9c55-0f6e2f4d8c11");
      yield* service.add(mcpThread, fieldsA);
      const view = Option.getOrThrow(yield* Stream.runHead(service.subscribe(mcpThread)));
      assert.strictEqual(view.entries.length, 1);
      const stored = JSON.parse(
        yield* fs.readFileString(storeFile("mcp~3A0b6f8a47-3c1e-4a8e-9c55-0f6e2f4d8c11")),
      );
      assert.strictEqual(stored.rootThreadId, mcpThread);
    }),
  ),
);

it.effect("clear and remove with nothing to change write no store file", () =>
  harness({ log: seed() }, ({ service, fs, storeFile }) =>
    Effect.gen(function* () {
      const unknown = ThreadId.make("thread-unknown");
      assert.deepStrictEqual(yield* service.clear(unknown), { cleared: 0 });
      assert.deepStrictEqual(yield* service.remove(unknown, "missing"), { removedSbId: null });
      assert.isFalse(yield* fs.exists(storeFile(unknown)));
    }),
  ),
);

it.effect("an unreadable store gives clients a fixed message", () =>
  harness(
    {
      log: seed(),
      before: ({ fs, storeFile }) =>
        fs
          .makeDirectory(storeFile(root).replace(/[\\/][^\\/]+$/, ""), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(storeFile(root), "{ not a store"))),
    },
    ({ service }) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(Stream.runHead(service.subscribe(root)));
        assert.strictEqual(failure.message, "Could not read session brief");
      }),
  ),
);

it.effect("concurrent removes with the log unavailable restart one fiber", () => {
  let appends = 0;
  const retryStarted = Deferred.makeUnsafe<void>();
  const releaseRetry = Deferred.makeUnsafe<void>();
  const settle = TestClock.withLive(Effect.sleep("100 millis"));
  return harness(
    {
      log: seed(),
      wrapLog: (log) => ({
        ...log,
        // The first retry stays in its uninterruptible write until released, so both removes
        // take hold of the same fiber before either interrupt can finish.
        append: (fields, meta) =>
          Effect.suspend(() => {
            appends += 1;
            return appends === 2
              ? Deferred.succeed(retryStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRetry)),
                  Effect.andThen(log.append(fields, meta)),
                )
              : log.append(fields, meta);
          }),
      }),
    },
    ({ service, fs, logFile, logIds }) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* service.add(root, fieldsA)).log._tag, "Logged");
        const [entry] = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root))).entries;
        // Another writer drops SB-0001, so the check re-appends; the log is then unreadable.
        yield* fs.writeFileString(logFile, seed());
        yield* TestClock.adjust("2 seconds");
        yield* Deferred.await(retryStarted);
        yield* fs.writeFileString(logFile, "{ half written");
        const removing = yield* Effect.forkChild(
          Effect.all(
            [
              Effect.flip(service.remove(root, entry!.id)),
              Effect.flip(service.remove(root, entry!.id)),
            ],
            { concurrency: 2 },
          ),
        );
        yield* settle;
        yield* Deferred.succeed(releaseRetry, undefined);
        const failures = yield* Fiber.join(removing);
        assert.deepStrictEqual(
          failures.map((failure) => failure.message),
          Array(2).fill(
            "Couldn't remove it from the annual log: log file is not valid JSON. Try again.",
          ),
        );
        yield* fs.writeFileString(logFile, seed());
        appends = 0;
        yield* TestClock.adjust("5 seconds");
        for (let i = 0; i < 50 && appends === 0; i++) yield* settle;
        yield* settle;
        yield* TestClock.adjust("2 seconds");
        yield* settle;
        assert.strictEqual(appends, 1);
        assert.deepStrictEqual(yield* logIds, ["SB-0001"]);
        const view = Option.getOrThrow(yield* Stream.runHead(service.subscribe(root)));
        assert.deepStrictEqual(view.entries[0]?.log, { _tag: "Logged", sbId: "SB-0001" });
      }),
  );
});
