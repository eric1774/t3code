import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  appendToVaultLog,
  parseVaultLog,
  removeFromVaultLog,
  serializeVaultLog,
  vaultLogHas,
} from "./briefLog.ts";

const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-04T12:00:03Z"));
const meta = { sessionId: "thread-1", sessionTitle: "Title", now };
const fields = { topic: "DHCP move", date: "11/03", changed: "Moved scope", verified: "Leases ok" };

const sample = (entries: ReadonlyArray<Record<string, unknown>>) => ({
  title: "Session Briefs Log",
  timezone: "America/Chicago",
  generated_at: "2026-10-30T13:04:12-05:00",
  entry_count: entries.length,
  session_history: [{ id: "x", nested: { a: [1, 2, 3] } }],
  superseded: ["SB-0001"],
  entries,
});
const oldEntry = (id: string, topic = "Old", changed = "Old change") => ({
  id,
  date: "2026-10-01",
  logged_at: "2026-10-01T09:00:00-05:00",
  topic,
  changed,
  verified: "ok",
  session_id: "s",
  source: "live",
});

describe("briefLog", () => {
  it("appends with next SB id", () => {
    const log = parseVaultLog(JSON.stringify(sample([oldEntry("SB-0175")])));
    const result = appendToVaultLog(log, { ...fields, rollback: "Revert", note: "n" }, meta);
    assert.deepStrictEqual(result.outcome, { _tag: "Logged", sbId: "SB-0176" });
    const added = result.log.entries[1]!;
    assert.deepStrictEqual(Object.keys(added), [
      "id",
      "date",
      "logged_at",
      "topic",
      "changed",
      "verified",
      "rollback",
      "note",
      "session_id",
      "session_title",
      "source",
    ]);
    assert.strictEqual(added.source, "t3");
    assert.strictEqual(added.date, "2026-11-03");
    assert.strictEqual(added.session_id, "thread-1");
    const text = serializeVaultLog(result.log, now);
    assert.strictEqual(parseVaultLog(text).entry_count, 2);
  });

  it("already logged on same topic+changed from any source", () => {
    const log = parseVaultLog(
      JSON.stringify(sample([oldEntry("SB-0042", fields.topic, fields.changed)])),
    );
    const before = JSON.stringify(log);
    const result = appendToVaultLog(log, fields, meta);
    assert.deepStrictEqual(result.outcome, { _tag: "AlreadyLogged", sbId: "SB-0042" });
    assert.strictEqual(JSON.stringify(result.log), before);
  });

  it("keeps unknown top-level keys", () => {
    const log = parseVaultLog(JSON.stringify(sample([oldEntry("SB-0001")])));
    const out = parseVaultLog(serializeVaultLog(appendToVaultLog(log, fields, meta).log, now));
    assert.strictEqual(
      JSON.stringify(out.session_history),
      JSON.stringify(sample([]).session_history),
    );
    assert.strictEqual(JSON.stringify(out.superseded), JSON.stringify(["SB-0001"]));
  });

  it("future date becomes today", () => {
    const log = parseVaultLog(JSON.stringify(sample([])));
    const result = appendToVaultLog(log, { ...fields, date: "12/31" }, meta);
    assert.strictEqual(result.log.entries[0]!.date, "2026-11-04");
    assert.deepStrictEqual(result.outcome, { _tag: "Logged", sbId: "SB-0001" });
  });

  it("impossible date becomes today", () => {
    for (const date of ["00/00", "02/31", "13/01", "04/31", "00/15"]) {
      const result = appendToVaultLog(
        parseVaultLog(JSON.stringify(sample([]))),
        { ...fields, date },
        meta,
      );
      assert.strictEqual(result.log.entries[0]!.date, "2026-11-04", date);
    }
    const leapless = appendToVaultLog(
      parseVaultLog(JSON.stringify(sample([]))),
      { ...fields, date: "02/29" },
      meta,
    );
    assert.strictEqual(leapless.log.entries[0]!.date, "2026-11-04");
    const valid = appendToVaultLog(
      parseVaultLog(JSON.stringify(sample([]))),
      { ...fields, date: "2/28" },
      meta,
    );
    assert.strictEqual(valid.log.entries[0]!.date, "2026-02-28");
  });

  it("remove only by matching sbId", () => {
    const log = parseVaultLog(
      JSON.stringify(
        sample([oldEntry("SB-0010"), oldEntry("SB-0011", fields.topic, fields.changed)]),
      ),
    );
    assert.isFalse(removeFromVaultLog(log, "SB-0010", fields).removed);
    const removed = removeFromVaultLog(log, "SB-0011", fields);
    assert.isTrue(removed.removed);
    assert.deepStrictEqual(
      removed.log.entries.map((entry) => entry.id),
      ["SB-0010"],
    );
    assert.isTrue(vaultLogHas(log, "SB-0011", fields, "s"));
    assert.isFalse(vaultLogHas(log, "SB-0010", fields, "s"));
    assert.isFalse(vaultLogHas(log, "SB-0011", fields, "other"));
  });

  it("serialize matches mod format", () => {
    const text = JSON.stringify(sample([oldEntry("SB-0001")]), null, 2) + "\n";
    const out = serializeVaultLog(parseVaultLog(text), now);
    const stamp = /"generated_at": "([^"]+)"/.exec(out)![1]!;
    assert.match(stamp, /^2026-11-0[34]T\d\d:\d\d:03[+-]\d\d:\d\d$/);
    assert.strictEqual(out, text.replace("2026-10-30T13:04:12-05:00", stamp));
  });

  it("rejects bad logs", () => {
    assert.throws(() => parseVaultLog("{nope"), "log file is not valid JSON");
    assert.throws(() => parseVaultLog('{"a":1}'), "log has no entries list");
    assert.throws(() => parseVaultLog("[]"), "log has no entries list");
  });
});
