import type { ScopedThreadRef, SessionBriefView } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { useEnvironmentQuerySelector } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const selectEntryCount = (result: AsyncResult.AsyncResult<SessionBriefView, unknown>) =>
  AsyncResult.getOrElse(result, () => null)?.entries.length ?? 0;

/** Selects the count so only a changed count re-renders the tab, never the chat. */
export function SessionBriefTabTitle(props: { readonly threadRef: ScopedThreadRef }) {
  const count = useEnvironmentQuerySelector(
    serverEnvironment.sessionBriefLive({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    }),
    selectEntryCount,
  );
  return <span className="truncate">{count > 0 ? `Brief · ${count}` : "Brief"}</span>;
}
