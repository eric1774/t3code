import {
  OrchestratorMcpFailure,
  SessionBriefAddInput,
  SessionBriefAddResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import { SessionBriefService } from "../../../sessionBrief/SessionBriefService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SessionBriefAddTool = Tool.make("t3_brief_add", {
  description:
    "Record one finished, verified step in this thread's session brief. Fields are short, plain and past tense; the date defaults to today (MM/DD). Reports whether the step reached the annual log.",
  parameters: SessionBriefAddInput,
  success: SessionBriefAddResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SessionBriefService,
  ],
})
  .annotate(Tool.Title, "Add to session brief")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, false);

export const SessionBriefToolkit = Toolkit.make(SessionBriefAddTool);
