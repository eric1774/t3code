import { describe, expect, it } from "vite-plus/test";

import { formatSessionBriefText } from "./sessionBriefText.ts";

describe("formatSessionBriefText", () => {
  it("matches the Claude Code mod byte for byte", () => {
    const entries = [
      {
        topic: "Synology PW-FILES DC list",
        date: "10/23",
        changed: "Added `CH-BLT-DC01`.",
        verified: "DSM test passed.",
      },
      {
        topic: "CA backup",
        date: "10/23",
        changed: "Ran `Backup-CARoleService`.",
        verified: "Hashes match.",
        note: "FS2 copy kept.",
      },
    ];
    expect(formatSessionBriefText(entries)).toBe(
      "1. Synology PW-FILES DC list (10/23)\r\n    1.1 What changed: Added CH-BLT-DC01.\r\n    1.2 Verified: DSM test passed.\r\n\r\n" +
        "2. CA backup (10/23)\r\n    2.1 What changed: Ran Backup-CARoleService.\r\n    2.2 Verified: Hashes match.\r\n    2.3 Note: FS2 copy kept.",
    );
  });

  it("returns empty string for no entries", () => {
    expect(formatSessionBriefText([])).toBe("");
  });

  it("uses the given eol", () => {
    const entries = [
      { topic: "CA backup", date: "10/23", changed: "Ran it.", verified: "Checked." },
    ];
    expect(formatSessionBriefText(entries, "\n")).toBe(
      "1. CA backup (10/23)\n    1.1 What changed: Ran it.\n    1.2 Verified: Checked.",
    );
  });
});
