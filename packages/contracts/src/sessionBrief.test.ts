import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DEFAULT_SERVER_SETTINGS } from "./settings.ts";
import { SessionBriefAddInput, SessionBriefLogState } from "./sessionBrief.ts";

const decodeAddInput = Schema.decodeSync(SessionBriefAddInput);
const encodeLogState = Schema.encodeSync(SessionBriefLogState);
const decodeLogState = Schema.decodeSync(SessionBriefLogState);

describe("session brief contracts", () => {
  it("decodes a minimal add input", () => {
    const decoded = decodeAddInput({
      topic: "A",
      changed: "B",
      verified: "C",
    });
    expect(decoded.date).toBeUndefined();
  });

  it("rejects a bad date", () => {
    expect(() =>
      decodeAddInput({
        topic: "A",
        date: "2026-10-23",
        changed: "B",
        verified: "C",
      }),
    ).toThrow();
  });

  it("rejects an empty topic", () => {
    expect(() => decodeAddInput({ topic: "   ", changed: "B", verified: "C" })).toThrow();
  });

  it("round-trips every log state", () => {
    const states = [
      { _tag: "Pending" },
      { _tag: "Logged", sbId: "SB-1" },
      { _tag: "AlreadyLogged", sbId: "SB-2" },
      { _tag: "Retrying", reason: "locked", attempts: 2 },
      { _tag: "NotLogged", reason: "no path" },
    ] as const;
    for (const state of states) {
      const encoded = encodeLogState(state);
      expect(decodeLogState(encoded)).toEqual(state);
    }
  });

  it("defaults sessionBriefLogPath to empty", () => {
    expect(DEFAULT_SERVER_SETTINGS.sessionBriefLogPath).toBe("");
  });
});
