import type { SessionBriefFields, SessionBriefLogState } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  appendToVaultLog,
  parseVaultLog,
  removeFromVaultLog,
  serializeVaultLog,
  vaultLogHas,
  type VaultLog,
} from "./briefLog.ts";

export type SessionBriefLogRemoval =
  | { readonly _tag: "Removed" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unavailable"; readonly reason: string };

export class SessionBriefLog extends Context.Service<
  SessionBriefLog,
  {
    /** Never fails: every problem becomes `Retrying` or `NotLogged`. */
    readonly append: (
      fields: SessionBriefFields,
      meta: { readonly sessionId: string; readonly sessionTitle: string },
    ) => Effect.Effect<SessionBriefLogState>;
    readonly verify: (
      sbId: string,
      fields: SessionBriefFields,
      sessionId: string,
    ) => Effect.Effect<boolean>;
    /** Never fails: a log that cannot be read or written is `Unavailable`. */
    readonly remove: (
      sbId: string,
      fields: SessionBriefFields,
    ) => Effect.Effect<SessionBriefLogRemoval>;
  }
>()("t3/sessionBrief/SessionBriefLog") {}

const shortReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0]?.trim() ?? "";
  return (line === "" ? "unknown error" : line).slice(0, 200);
};

class LogUnavailable extends Data.TaggedError("LogUnavailable")<{ readonly reason: string }> {}

export const layer = Layer.effect(
  SessionBriefLog,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);

    const logPath = settings.getSettings.pipe(
      Effect.map((value) => value.sessionBriefLogPath.trim()),
      Effect.mapError((error) => new LogUnavailable({ reason: shortReason(error) })),
    );
    const now = Effect.map(DateTime.now, DateTime.toDateUtc);

    // Every call re-reads the file and never creates it: it is a record shared with another writer.
    const readLog = (filePath: string) =>
      fs.readFileString(filePath).pipe(
        Effect.mapError(
          (error) =>
            new LogUnavailable({
              reason: error.reason._tag === "NotFound" ? "log file not found" : shortReason(error),
            }),
        ),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => parseVaultLog(text),
            catch: (error) => new LogUnavailable({ reason: shortReason(error) }),
          }),
        ),
      );

    const writeLog = (filePath: string, log: VaultLog, at: Date) =>
      writeFileStringAtomically({ filePath, contents: serializeVaultLog(log, at) }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((error) => new LogUnavailable({ reason: shortReason(error) })),
      );

    const append = Effect.fn("SessionBriefLog.append")(function* (
      fields: SessionBriefFields,
      meta: { readonly sessionId: string; readonly sessionTitle: string },
    ) {
      return yield* Effect.gen(function* () {
        const filePath = yield* logPath;
        if (filePath === "") {
          return {
            _tag: "NotLogged",
            reason: "no log path set in Settings",
          } as SessionBriefLogState;
        }
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const log = yield* readLog(filePath);
            const at = yield* now;
            const result = yield* Effect.try({
              try: () => appendToVaultLog(log, fields, { ...meta, now: at }),
              catch: (error) => new LogUnavailable({ reason: shortReason(error) }),
            });
            if (result.outcome._tag === "Logged") {
              yield* writeLog(filePath, result.log, at);
            }
            return result.outcome as SessionBriefLogState;
          }),
        );
      }).pipe(
        Effect.catchTags({
          LogUnavailable: (error) =>
            Effect.succeed({
              _tag: "Retrying",
              reason: error.reason,
              attempts: 1,
            } as SessionBriefLogState),
        }),
      );
    });

    const verify = Effect.fn("SessionBriefLog.verify")(function* (
      sbId: string,
      fields: SessionBriefFields,
      sessionId: string,
    ) {
      return yield* Effect.gen(function* () {
        const filePath = yield* logPath;
        if (filePath === "") return false;
        const log = yield* lock.withPermits(1)(readLog(filePath));
        return vaultLogHas(log, sbId, fields, sessionId);
      }).pipe(Effect.orElseSucceed(() => false));
    });

    const remove = Effect.fn("SessionBriefLog.remove")(function* (
      sbId: string,
      fields: SessionBriefFields,
    ) {
      return yield* Effect.gen(function* () {
        const filePath = yield* logPath;
        if (filePath === "") {
          return { _tag: "Unavailable", reason: "no log path set in Settings" } as const;
        }
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const result = removeFromVaultLog(yield* readLog(filePath), sbId, fields);
            if (!result.removed) return { _tag: "NotFound" } as const;
            yield* writeLog(filePath, result.log, yield* now);
            return { _tag: "Removed" } as const;
          }),
        );
      }).pipe(
        Effect.catchTags({
          LogUnavailable: (error) =>
            Effect.succeed({ _tag: "Unavailable", reason: error.reason } as const),
        }),
      );
    });

    return SessionBriefLog.of({ append, verify, remove });
  }),
);
