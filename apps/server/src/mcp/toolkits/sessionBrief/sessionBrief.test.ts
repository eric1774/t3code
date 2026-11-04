import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type SessionBriefFields,
  type SessionBriefLogState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { SessionBriefService } from "../../../sessionBrief/SessionBriefService.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "session-brief", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "session-brief", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scopeFor = (
  thread: { readonly threadId: ThreadId; readonly subagent?: boolean } | undefined,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("brief-environment"),
  requestNamespace: "brief-session",
  thread:
    thread === undefined
      ? undefined
      : {
          ...thread,
          providerSessionId: "brief-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const input = { topic: "DHCP move", changed: "Moved scope.", verified: "Leases renewed." };

const run = (
  scope: McpInvocationContext.McpInvocationScope,
  log: SessionBriefLogState,
  args: Record<string, unknown> = input,
) => {
  const added: Array<{ caller: ThreadId; fields: SessionBriefFields }> = [];
  const program = Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_brief_add", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    return { result, added, tool: server.tools.find(({ tool }) => tool.name === "t3_brief_add") };
  }).pipe(
    Effect.provide(
      McpHttpServer.layerSessionBriefToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(SessionBriefService)({
            add: (caller, fields) => {
              added.push({ caller, fields });
              return Effect.succeed({ count: 1, log });
            },
          }),
        ),
      ),
    ),
  );
  return program;
};

it.effect("adds from a thread caller", () =>
  Effect.gen(function* () {
    const { result, added, tool } = yield* run(
      scopeFor({ threadId: ThreadId.make("brief-thread") }),
      { _tag: "Logged", sbId: "SB-0177" },
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ count: 1, log: "logged as SB-0177" });
    expect(added).toHaveLength(1);
    expect(added[0]?.caller).toBe(ThreadId.make("brief-thread"));
    expect(added[0]?.fields.date).toMatch(/^\d{2}\/\d{2}$/);
    expect(tool).toBeDefined();
  }),
);

it.effect("keeps a given date and words every log state", () =>
  Effect.gen(function* () {
    const states: ReadonlyArray<readonly [SessionBriefLogState, string]> = [
      [{ _tag: "AlreadyLogged", sbId: "SB-0123" }, "already in the annual log as SB-0123"],
      [
        { _tag: "Retrying", reason: "file locked", attempts: 2 },
        "NOT written to the annual log yet (file locked); retrying",
      ],
      [
        { _tag: "NotLogged", reason: "no log path set in Settings" },
        "NOT written to the annual log (no log path set in Settings)",
      ],
      [{ _tag: "Pending" }, "logging…"],
    ];
    for (const [state, text] of states) {
      const { result, added } = yield* run(
        scopeFor({ threadId: ThreadId.make("brief-thread") }),
        state,
        { ...input, date: "3/9" },
      );
      expect(result.structuredContent).toEqual({ count: 1, log: text });
      expect(added[0]?.fields.date).toBe("3/9");
    }
  }),
);

it.effect("delegated child adds to root", () =>
  Effect.gen(function* () {
    const { result, added } = yield* run(
      scopeFor({ threadId: ThreadId.make("brief-child"), subagent: true }),
      { _tag: "Logged", sbId: "SB-0001" },
    );
    expect(result.isError).toBe(false);
    expect(added[0]?.caller).toBe(ThreadId.make("brief-child"));
  }),
);

it.effect("refuses outside clients", () =>
  Effect.gen(function* () {
    const { result, added } = yield* run(scopeFor(undefined), { _tag: "Pending" });
    expect(declaredFailure(result)).toMatchObject({ code: "thread_credential_required" });
    expect(added).toEqual([]);
  }),
);
