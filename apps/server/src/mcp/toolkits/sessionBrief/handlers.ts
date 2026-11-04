import { OrchestratorMcpFailure, type SessionBriefLogState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SessionBriefService } from "../../../sessionBrief/SessionBriefService.ts";
import { SessionBriefToolkit } from "./tools.ts";

const logText = (log: SessionBriefLogState) => {
  switch (log._tag) {
    case "Logged":
      return `logged as ${log.sbId}`;
    case "AlreadyLogged":
      return `already in the annual log as ${log.sbId}`;
    case "Retrying":
      return `NOT written to the annual log yet (${log.reason}); retrying`;
    case "NotLogged":
      return `NOT written to the annual log (${log.reason})`;
    case "Pending":
      return "logging…";
  }
};

const pad = (value: number) => String(value).padStart(2, "0");
const today = Effect.map(DateTime.now, (now) => {
  const { month, day } = DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal()));
  return `${pad(month)}/${pad(day)}`;
});

export const layer = McpToolAccess.toLayer(SessionBriefToolkit, {
  t3_brief_add: McpToolAccess.actsAsCaller(({ date, ...fields }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
      const brief = yield* SessionBriefService;
      const { count, log } = yield* brief
        .add(thread.threadId, { ...fields, date: date ?? (yield* today) })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      return { count, log: logText(log) };
    }),
  ),
});
