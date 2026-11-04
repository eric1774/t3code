import { EnvironmentId, ThreadId, type SessionBriefEntry } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  entries: [] as ReadonlyArray<unknown>,
  confirm: vi.fn(),
  clear: vi.fn(),
  remove: vi.fn(),
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../../confirmDialog"), async (importOriginal) => ({
  ...(await importOriginal()),
  requestConfirmDialog: ((message: string, options: unknown) =>
    state.confirm(message, options)) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.clearSessionBrief ? state.clear : state.remove) as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { rootThreadId: "thread", entries: state.entries },
    error: null,
  })) as never,
  useEnvironmentQuerySelector: ((_atom: unknown, select: (result: unknown) => unknown) =>
    select(AsyncResult.success({ rootThreadId: "thread", entries: state.entries }))) as never,
}));

import { render } from "../../../test/render";
import { SessionBriefPanel } from "./SessionBriefPanel";
import { SessionBriefTabTitle } from "./SessionBriefTabTitle";

const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));

const entry = (
  n: number,
  log: SessionBriefEntry["log"],
  extra: Partial<SessionBriefEntry> = {},
): SessionBriefEntry => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  createdAt: "2026-10-23T12:00:00.000Z" as SessionBriefEntry["createdAt"],
  sourceThreadId: ThreadId.make("thread"),
  cleared: false,
  topic: `Topic ${n}`,
  date: "10/23",
  changed: `Changed ${n}.`,
  verified: `Verified ${n}.`,
  log,
  ...extra,
});

function setup(entries: ReadonlyArray<SessionBriefEntry>) {
  state.entries = entries;
  state.confirm.mockReset().mockResolvedValue(true);
  state.clear.mockReset().mockResolvedValue({ _tag: "Success" });
  state.remove.mockReset().mockResolvedValue({ _tag: "Success" });
}

it("renders numbered entries and badges", async () => {
  setup([
    entry(1, { _tag: "Logged", sbId: "SB-0177" }),
    entry(2, { _tag: "AlreadyLogged", sbId: "SB-0123" }),
    entry(3, { _tag: "Pending" }),
    entry(4, { _tag: "Retrying", reason: "vault locked", attempts: 3 }),
    entry(5, { _tag: "NotLogged", reason: "no vault" }, { rollback: "Undo it." }),
  ]);
  await using screen = await render(<SessionBriefPanel threadRef={threadRef} />, {
    router: false, // no navigation in the panel
  });
  const text = screen.container.textContent ?? "";
  for (const expected of [
    "5 entries",
    "1. Topic 1 (10/23)",
    "5. Topic 5 (10/23)",
    "1.1 What changed: Changed 1.",
    "5.3 Rollback: Undo it.",
    "SB-0177",
    "SB-0123 · already logged",
    "logging…",
    "retrying: vault locked",
    "not logged: no vault",
  ]) {
    expect(text).toContain(expected);
  }
});

it("shows the empty state", async () => {
  setup([]);
  await using screen = await render(<SessionBriefPanel threadRef={threadRef} />, {
    router: false, // no navigation in the panel
  });
  await expect
    .element(
      screen.getByText(
        "No verified steps yet. Entries appear here as the agent finishes and verifies work.",
      ),
    )
    .toBeVisible();
});

it("copy writes mod-format text", async () => {
  setup([
    entry(1, { _tag: "Logged", sbId: "SB-0177" }, { changed: "Added `CH-BLT-DC01`." }),
    entry(2, { _tag: "Pending" }, { note: "FS2 copy kept." }),
  ]);
  await using screen = await render(<SessionBriefPanel threadRef={threadRef} />, {
    router: false, // no navigation in the panel
  });
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await screen.getByRole("button", { name: "Copy" }).click();
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledWith(
    "1. Topic 1 (10/23)\r\n    1.1 What changed: Added CH-BLT-DC01.\r\n    1.2 Verified: Verified 1.\r\n\r\n" +
      "2. Topic 2 (10/23)\r\n    2.1 What changed: Changed 2.\r\n    2.2 Verified: Verified 2.\r\n    2.3 Note: FS2 copy kept.",
  );
  await expect.element(screen.getByText("Copied")).toBeVisible();
});

it("clear asks first and does nothing on cancel", async () => {
  setup([entry(1, { _tag: "Pending" })]);
  await using screen = await render(<SessionBriefPanel threadRef={threadRef} />, {
    router: false, // no navigation in the panel
  });
  state.confirm.mockResolvedValue(false);
  await screen.getByRole("button", { name: "Clear" }).click();
  await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce());
  expect(state.confirm).toHaveBeenCalledWith(
    "Clear the session brief? The annual log keeps every entry.",
    { variant: "destructive" },
  );
  expect(state.clear).not.toHaveBeenCalled();

  state.confirm.mockResolvedValue(true);
  await screen.getByRole("button", { name: "Clear" }).click();
  await vi.waitFor(() => expect(state.clear).toHaveBeenCalledOnce());
  expect(state.clear).toHaveBeenCalledWith({
    environmentId: "env",
    input: { threadId: "thread" },
  });
});

it("remove asks first then calls removeSessionBriefEntry with entryId", async () => {
  const first = entry(1, { _tag: "Pending" });
  setup([first, entry(2, { _tag: "Pending" })]);
  await using screen = await render(<SessionBriefPanel threadRef={threadRef} />, {
    router: false, // no navigation in the panel
  });
  state.confirm.mockResolvedValue(false);
  await screen.getByRole("button", { name: "Remove Topic 1" }).click();
  await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce());
  expect(state.confirm).toHaveBeenCalledWith(
    "Remove this entry from the brief and the annual log?",
    { variant: "destructive" },
  );
  expect(state.remove).not.toHaveBeenCalled();

  state.confirm.mockResolvedValue(true);
  await screen.getByRole("button", { name: "Remove Topic 1" }).click();
  await vi.waitFor(() => expect(state.remove).toHaveBeenCalledOnce());
  expect(state.remove).toHaveBeenCalledWith({
    environmentId: "env",
    input: { threadId: "thread", entryId: first.id },
  });
});

it("tab title shows count", async () => {
  setup([entry(1, { _tag: "Pending" }), entry(2, { _tag: "Pending" })]);
  await using screen = await render(<SessionBriefTabTitle threadRef={threadRef} />, {
    router: false, // no navigation in the title
  });
  expect(screen.container.textContent).toBe("Brief · 2");
  state.entries = [];
  await screen.rerender(<SessionBriefTabTitle threadRef={threadRef} />);
  expect(screen.container.textContent).toBe("Brief");
});
