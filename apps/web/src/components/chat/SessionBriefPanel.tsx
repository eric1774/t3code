import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, SessionBriefEntry } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatSessionBriefText } from "@t3tools/shared/sessionBriefText";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SUB_LINES = [
  ["changed", "What changed"],
  ["verified", "Verified"],
  ["rollback", "Rollback"],
  ["note", "Note"],
] as const;

function LogBadge({ log }: { readonly log: SessionBriefEntry["log"] }) {
  switch (log._tag) {
    case "Logged":
      return <Badge variant="success">{log.sbId}</Badge>;
    case "AlreadyLogged":
      return <Badge variant="success">{`already logged as ${log.sbId}`}</Badge>;
    case "Pending":
      return <Badge variant="warning">logging…</Badge>;
    case "Retrying":
      return (
        <Tooltip>
          {/* Capped so a long reason never squeezes the title or the Remove button. */}
          <TooltipTrigger
            render={
              <Badge variant="warning" className="max-w-[12rem]">
                <span className="truncate">{`retrying: ${log.reason}`}</span>
              </Badge>
            }
          />
          <TooltipPopup>{`${log.reason} (attempt ${log.attempts})`}</TooltipPopup>
        </Tooltip>
      );
    case "NotLogged":
      return <span className="text-xs text-muted-foreground">{`not logged: ${log.reason}`}</span>;
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function SessionBriefPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const query = useEnvironmentQuery(
    serverEnvironment.sessionBriefLive({ environmentId, input: { threadId } }),
  );
  const canEdit = useAtomValue(serverEnvironment.clearSessionBrief.permissionAtom(environmentId));
  const clearBrief = useAtomCommand(serverEnvironment.clearSessionBrief, {
    label: "session brief clear",
    reportFailure: false,
  });
  const removeEntry = useAtomCommand(serverEnvironment.removeSessionBriefEntry, {
    label: "session brief remove",
    reportFailure: false,
  });
  const [clearing, setClearing] = useState(false);
  const [removingIds, setRemovingIds] = useState<readonly string[]>([]);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "session brief",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy brief",
          description: error.message,
        }),
      );
    },
  });
  const entries = query.data?.entries ?? [];

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({ type: "error", title, description: failureMessage(error) }),
    );
  };

  // Busy is set before the confirm opens so a double click cannot queue two removes.
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      const confirmed = await requestConfirmDialog(
        "Clear the session brief? The annual log keeps every entry.",
        { variant: "destructive" },
      );
      if (!confirmed) return;
      const result = await clearBrief({ environmentId, input: { threadId } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not clear brief", squashAtomCommandFailure(result));
      }
    } finally {
      setClearing(false);
    }
  };

  const remove = async (entryId: string) => {
    if (removingIds.includes(entryId)) return;
    setRemovingIds((ids) => [...ids, entryId]);
    try {
      const confirmed = await requestConfirmDialog(
        "Remove this entry from the brief and the annual log?",
        { variant: "destructive" },
      );
      if (!confirmed) return;
      const result = await removeEntry({ environmentId, input: { threadId, entryId } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not remove entry", squashAtomCommandFailure(result));
      }
    } finally {
      setRemovingIds((ids) => ids.filter((id) => id !== entryId));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-session-brief-panel>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
        </span>
        <Button
          size="compact"
          disabled={entries.length === 0}
          onClick={() => copyToClipboard(formatSessionBriefText(entries), undefined)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="compact"
          variant="outline"
          disabled={entries.length === 0 || clearing || !canEdit}
          onClick={() => void clear()}
        >
          Clear
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {query.error !== null && entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-destructive-foreground">{query.error}</p>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No verified steps yet. Entries appear here as the agent finishes and verifies work.
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {entries.map((entry, index) => {
              const number = index + 1;
              const subs = SUB_LINES.flatMap(([field, label]) => {
                const text = entry[field];
                return text === undefined ? [] : [{ label, text }];
              });
              return (
                <li key={entry.id} className="min-w-0">
                  <div className="flex items-start gap-2">
                    <h3 className="min-w-0 flex-1 break-words text-sm font-medium">
                      {`${number}. ${entry.topic} (${entry.date})`}
                    </h3>
                    <LogBadge log={entry.log} />
                    <Button
                      size="icon-xs"
                      variant="ghost-destructive"
                      aria-label={`Remove ${entry.topic}`}
                      disabled={removingIds.includes(entry.id) || !canEdit}
                      onClick={() => void remove(entry.id)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-xs text-muted-foreground">
                    {subs.map((sub, subIndex) => (
                      <li key={sub.label} className="whitespace-pre-wrap break-words">
                        {`${number}.${subIndex + 1} ${sub.label}: ${sub.text}`}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
