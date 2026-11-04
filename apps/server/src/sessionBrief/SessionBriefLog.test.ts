import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { ServerSettingsError } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseVaultLog } from "./briefLog.ts";
import * as SessionBriefLog from "./SessionBriefLog.ts";

const fieldsA = { topic: "A", date: "11/03", changed: "Changed A", verified: "Verified A" };
const fieldsB = { topic: "B", date: "11/03", changed: "Changed B", verified: "Verified B" };
const meta = { sessionId: "thread-1", sessionTitle: "Title" };
const seed = (entries: ReadonlyArray<Record<string, unknown>> = []) =>
  JSON.stringify({ title: "Log", extra: { keep: true }, entries }, null, 2) + "\n";

const withLog = <A, E, R>(
  initial: string | null,
  use: (input: {
    readonly service: SessionBriefLog.SessionBriefLog["Service"];
    readonly file: string;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, R>,
  pathSetting?: (file: string) => string,
  options: {
    readonly wrapFs?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
    readonly settings?: Layer.Layer<ServerSettingsService, ServerSettingsError>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "session-brief-log-" });
    const file = path.join(dir, "log.json");
    if (initial !== null) yield* fs.writeFileString(file, initial);
    const service = yield* SessionBriefLog.SessionBriefLog.pipe(
      Effect.provide(
        SessionBriefLog.layer.pipe(
          Layer.provide(
            options.settings ??
              ServerSettingsService.layerTest({
                sessionBriefLogPath: pathSetting ? pathSetting(file) : file,
              }),
          ),
          Layer.provide(
            Layer.succeed(FileSystem.FileSystem, options.wrapFs ? options.wrapFs(fs) : fs),
          ),
        ),
      ),
    );
    return yield* use({ service, file, fs });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("NotLogged when path empty", () =>
  withLog(
    null,
    ({ service }) =>
      Effect.gen(function* () {
        const state = yield* service.append(fieldsA, meta);
        assert.deepStrictEqual(state, { _tag: "NotLogged", reason: "no log path set in Settings" });
      }),
    () => "",
  ),
);

it.effect("Retrying when file missing, and file is not created", () =>
  withLog(null, ({ service, file, fs }) =>
    Effect.gen(function* () {
      const state = yield* service.append(fieldsA, meta);
      assert.deepStrictEqual(state, {
        _tag: "Retrying",
        reason: "log file not found",
        attempts: 1,
      });
      assert.isFalse(yield* fs.exists(file));
    }),
  ),
);

it.effect("Retrying when file is invalid JSON, and file is untouched", () =>
  withLog("{ not json", ({ service, file, fs }) =>
    Effect.gen(function* () {
      const state = yield* service.append(fieldsA, meta);
      assert.deepStrictEqual(state, {
        _tag: "Retrying",
        reason: "log file is not valid JSON",
        attempts: 1,
      });
      assert.strictEqual(yield* fs.readFileString(file), "{ not json");
    }),
  ),
);

it.effect("Retrying when the write fails", () =>
  withLog(
    seed(),
    ({ service, file, fs }) =>
      Effect.gen(function* () {
        const before = yield* fs.readFileString(file);
        const state = yield* service.append(fieldsA, meta);
        assert.strictEqual(state._tag, "Retrying");
        assert.isTrue(state._tag === "Retrying" && state.reason.length > 0);
        assert.strictEqual(yield* fs.readFileString(file), before);
      }),
    undefined,
    {
      wrapFs: (fs) => ({
        ...fs,
        writeFileString: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "writeFileString",
              description: "disk is read-only",
            }),
          ),
      }),
    },
  ),
);

it.effect("Retrying when settings cannot be read", () =>
  withLog(
    seed(),
    ({ service, file, fs }) =>
      Effect.gen(function* () {
        const before = yield* fs.readFileString(file);
        const state = yield* service.append(fieldsA, meta);
        assert.strictEqual(state._tag, "Retrying");
        assert.isTrue(state._tag === "Retrying" && state.reason.length > 0);
        assert.strictEqual(yield* fs.readFileString(file), before);
      }),
    undefined,
    {
      settings: Layer.effect(
        ServerSettingsService,
        Effect.gen(function* () {
          const real = yield* ServerSettingsService;
          return ServerSettingsService.of({
            ...real,
            getSettings: Effect.fail(
              new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
            ),
          });
        }).pipe(Effect.provide(ServerSettingsService.layerTest())),
      ),
    },
  ),
);

it.effect("append tolerates non-object entries and preserves them", () =>
  withLog(
    JSON.stringify({ entries: [null, 5, { id: "SB-0007", topic: "x", changed: "y" }] }),
    ({ service, file, fs }) =>
      Effect.gen(function* () {
        const state = yield* service.append(fieldsA, meta);
        assert.deepStrictEqual(state, { _tag: "Logged", sbId: "SB-0008" });
        const entries = parseVaultLog(yield* fs.readFileString(file)).entries;
        assert.strictEqual(entries.length, 4);
        assert.strictEqual(entries[0], null as never);
        assert.strictEqual(entries[1], 5 as never);
      }),
  ),
);

it.effect("concurrent appends get unique ids", () =>
  withLog(seed(), ({ service, file, fs }) =>
    Effect.gen(function* () {
      const [a, b] = yield* Effect.all(
        [service.append(fieldsA, meta), service.append(fieldsB, meta)],
        { concurrency: 2 },
      );
      assert.strictEqual(a._tag, "Logged");
      assert.strictEqual(b._tag, "Logged");
      const ids = [a, b].map((state) => (state._tag === "Logged" ? state.sbId : ""));
      assert.strictEqual(new Set(ids).size, 2);
      const log = parseVaultLog(yield* fs.readFileString(file));
      assert.deepStrictEqual(log.entries.map((entry) => entry.id).toSorted(), ids.toSorted());
      assert.deepStrictEqual(log.extra, { keep: true });
    }),
  ),
);

it.effect("verify false after another writer overwrites", () =>
  withLog(seed(), ({ service, file, fs }) =>
    Effect.gen(function* () {
      const state = yield* service.append(fieldsA, meta);
      assert.strictEqual(state._tag, "Logged");
      const sbId = state._tag === "Logged" ? state.sbId : "";
      assert.isTrue(yield* service.verify(sbId, fieldsA, meta.sessionId));
      yield* fs.writeFileString(file, seed());
      assert.isFalse(yield* service.verify(sbId, fieldsA, meta.sessionId));
    }),
  ),
);

it.effect("remove takes the entry back out", () =>
  withLog(seed(), ({ service, file, fs }) =>
    Effect.gen(function* () {
      const state = yield* service.append(fieldsA, meta);
      const sbId = state._tag === "Logged" ? state.sbId : "";
      assert.deepStrictEqual(yield* service.remove(sbId, fieldsA), { _tag: "Removed" });
      assert.deepStrictEqual(parseVaultLog(yield* fs.readFileString(file)).entries, []);
      assert.deepStrictEqual(yield* service.remove(sbId, fieldsA), { _tag: "NotFound" });
      yield* fs.writeFileString(file, "{ not json");
      assert.deepStrictEqual(yield* service.remove(sbId, fieldsA), {
        _tag: "Unavailable",
        reason: "log file is not valid JSON",
      });
    }),
  ),
);
