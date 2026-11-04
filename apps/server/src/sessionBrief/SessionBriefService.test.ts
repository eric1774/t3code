import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
    return { next, until };
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
          SessionBriefLog.layer.pipe(
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
      assert.strictEqual((yield* views.next).entries.length, 0);
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
      before: ({ fs, storeFile }) =>
        fs.makeDirectory(storeFile(root).replace(/[\\/][^\\/]+$/, ""), { recursive: true }).pipe(
          Effect.andThen(
            fs.writeFileString(
              storeFile(root),
              JSON.stringify({
                version: 1,
                rootThreadId: root,
                entries: [
                  {
                    ...fieldsA,
                    id: "0b6f8a47-3c1e-4a8e-9c55-0f6e2f4d8c11",
                    createdAt: "2026-11-04T10:00:00.000Z",
                    sourceThreadId: root,
                    cleared: false,
                    log: { _tag: "Retrying", reason: "log file not found", attempts: 3 },
                  },
                ],
              }),
            ),
          ),
        ),
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
