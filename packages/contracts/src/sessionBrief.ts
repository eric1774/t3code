import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

const SessionBriefDate = Schema.String.check(Schema.isPattern(/^\d{1,2}\/\d{1,2}$/));

export const SessionBriefFields = Schema.Struct({
  topic: Text(200),
  date: SessionBriefDate,
  changed: Text(4000),
  verified: Text(4000),
  rollback: Schema.optional(Text(4000)),
  note: Schema.optional(Text(4000)),
});
export type SessionBriefFields = typeof SessionBriefFields.Type;

export const SessionBriefLogState = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Logged", { sbId: Schema.String }),
  Schema.TaggedStruct("AlreadyLogged", { sbId: Schema.String }),
  Schema.TaggedStruct("Retrying", { reason: Schema.String, attempts: Schema.Number }),
  Schema.TaggedStruct("NotLogged", { reason: Schema.String }),
]);
export type SessionBriefLogState = typeof SessionBriefLogState.Type;

export const SessionBriefEntry = Schema.Struct({
  ...SessionBriefFields.fields,
  id: Schema.String.check(Schema.isUUID()),
  createdAt: IsoDateTime,
  sourceThreadId: ThreadId,
  cleared: Schema.Boolean,
  log: SessionBriefLogState,
});
export type SessionBriefEntry = typeof SessionBriefEntry.Type;

/** Only uncleared entries, in insertion order. */
export const SessionBriefView = Schema.Struct({
  rootThreadId: ThreadId,
  entries: Schema.Array(SessionBriefEntry),
});
export type SessionBriefView = typeof SessionBriefView.Type;

export const SessionBriefAddInput = Schema.Struct({
  ...SessionBriefFields.fields,
  date: Schema.optional(SessionBriefDate),
});
export type SessionBriefAddInput = typeof SessionBriefAddInput.Type;

export const SessionBriefAddResult = Schema.Struct({
  count: Schema.Number,
  log: Schema.String,
});
export type SessionBriefAddResult = typeof SessionBriefAddResult.Type;

export const SessionBriefSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type SessionBriefSubscribeInput = typeof SessionBriefSubscribeInput.Type;

export const SessionBriefClearInput = Schema.Struct({ threadId: ThreadId });
export type SessionBriefClearInput = typeof SessionBriefClearInput.Type;

export const SessionBriefClearResult = Schema.Struct({ cleared: Schema.Number });
export type SessionBriefClearResult = typeof SessionBriefClearResult.Type;

export const SessionBriefRemoveInput = Schema.Struct({
  threadId: ThreadId,
  entryId: Schema.String,
});
export type SessionBriefRemoveInput = typeof SessionBriefRemoveInput.Type;

export const SessionBriefRemoveResult = Schema.Struct({
  removedSbId: Schema.NullOr(Schema.String),
});
export type SessionBriefRemoveResult = typeof SessionBriefRemoveResult.Type;

export class SessionBriefError extends Schema.TaggedError<SessionBriefError>()(
  "SessionBriefError",
  {
    message: Schema.String,
  },
) {}
