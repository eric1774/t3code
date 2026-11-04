import type { SessionBriefFields } from "@t3tools/contracts";

const FIELDS: ReadonlyArray<readonly [keyof SessionBriefFields, string]> = [
  ["changed", "What changed"],
  ["verified", "Verified"],
  ["rollback", "Rollback"],
  ["note", "Note"],
];

const SUB_INDENT = "    ";

// Plain ticket text: numbered steps with numbered sub-lines, a blank line
// between steps; no Markdown marks, backticks dropped. Numbers are literal text
// so a paste anywhere keeps them.
export function formatSessionBriefText(
  entries: ReadonlyArray<SessionBriefFields>,
  eol = "\r\n",
): string {
  return entries
    .map((entry, index) => {
      const number = index + 1;
      const subs = FIELDS.flatMap(([field, label]) => {
        const text = entry[field];
        return text === undefined ? [] : [{ label, text }];
      });
      return [
        `${number}. ${entry.topic} (${entry.date})`,
        ...subs.map(
          (sub, subIndex) => `${SUB_INDENT}${number}.${subIndex + 1} ${sub.label}: ${sub.text}`,
        ),
      ].join(eol);
    })
    .join(eol + eol)
    .replace(/`/g, "");
}
