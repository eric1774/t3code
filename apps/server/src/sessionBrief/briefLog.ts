import type { SessionBriefFields } from "@t3tools/contracts";

export type VaultLog = Record<string, unknown> & { entries: Array<Record<string, unknown>> };

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time with its UTC offset, e.g. 2026-10-30T13:04:12-05:00. */
function localStamp(now: Date): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);

  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const daysInMonth = (year: number, month: number) => {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
};

/**
 * "MM/DD" to "YYYY-MM-DD" in the current year. A date later than today, or one that does not
 * exist in this year (00/00, 02/31), is a typo, so today wins.
 */
function isoDate(md: string, now: Date): string {
  const year = now.getFullYear();
  const today = `${year}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(md.trim());
  if (match === null) {
    return today;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return today;
  }
  const date = `${year}-${pad(month)}-${pad(day)}`;

  return date > today ? today : date;
}

export function parseVaultLog(text: string): VaultLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("log file is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error("log has no entries list");
  }

  return parsed as VaultLog;
}

/** Same bytes the Claude Code mod writes, so the file round-trips between both writers. */
export function serializeVaultLog(log: VaultLog, now: Date): string {
  log.entry_count = log.entries.length;
  log.generated_at = localStamp(now);

  return JSON.stringify(log, null, 2) + "\n";
}

// Entries come from a file another writer owns; tolerate and preserve anything that is not an object.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const sameBrief = (entry: unknown, fields: SessionBriefFields) =>
  isRecord(entry) && entry.topic === fields.topic && entry.changed === fields.changed;

export function appendToVaultLog(
  log: VaultLog,
  fields: SessionBriefFields,
  meta: { sessionId: string; sessionTitle: string; now: Date },
): { log: VaultLog; outcome: { _tag: "Logged" | "AlreadyLogged"; sbId: string } } {
  const existing = log.entries.find((entry) => sameBrief(entry, fields));
  if (isRecord(existing)) {
    return { log, outcome: { _tag: "AlreadyLogged", sbId: String(existing.id) } };
  }
  const last = log.entries.reduce((max, entry) => {
    const match = isRecord(entry) ? /^SB-(\d+)$/.exec(String(entry.id)) : null;
    return match === null ? max : Math.max(max, Number(match[1]));
  }, 0);
  const sbId = `SB-${String(last + 1).padStart(4, "0")}`;
  const entry: Record<string, unknown> = {
    id: sbId,
    date: isoDate(fields.date, meta.now),
    logged_at: localStamp(meta.now),
    topic: fields.topic,
    changed: fields.changed,
    verified: fields.verified,
    ...(fields.rollback === undefined ? {} : { rollback: fields.rollback }),
    ...(fields.note === undefined ? {} : { note: fields.note }),
    session_id: meta.sessionId,
    session_title: meta.sessionTitle,
    source: "t3",
  };

  return { log: { ...log, entries: [...log.entries, entry] }, outcome: { _tag: "Logged", sbId } };
}

/** Removes only the entry this brief wrote: id, topic and changed must all match. */
export function removeFromVaultLog(
  log: VaultLog,
  sbId: string,
  fields: SessionBriefFields,
): { log: VaultLog; removed: boolean } {
  const index = log.entries.findIndex(
    (entry) => isRecord(entry) && entry.id === sbId && sameBrief(entry, fields),
  );
  if (index === -1) {
    return { log, removed: false };
  }

  return { log: { ...log, entries: log.entries.filter((_, i) => i !== index) }, removed: true };
}

export function vaultLogHas(
  log: VaultLog,
  sbId: string,
  fields: SessionBriefFields,
  sessionId: string,
): boolean {
  return log.entries.some(
    (entry) =>
      isRecord(entry) &&
      entry.id === sbId &&
      sameBrief(entry, fields) &&
      entry.session_id === sessionId,
  );
}
