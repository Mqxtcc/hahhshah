import { MessageFlags } from "discord.js";

/**
 * Components V2 responses may contain user/role/channel markup, but they must
 * not create notifications by default.  Unlike classic embeds (whose text never
 * parsed mentions), V2 component text goes through Discord's mention parser,
 * so an @user written into a component would ping that user unless we opt out.
 *
 * Keep this as a function so every payload gets its own options object and
 * callers cannot mutate a shared default.
 */
export function componentsV2AllowedMentions(): {
  parse: [];
} {
  return { parse: [] };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasComponentsV2Flag(value: JsonRecord): boolean {
  const flags = value.flags;
  return typeof flags === "number" && (flags & MessageFlags.IsComponentsV2) !== 0;
}

const API_ALLOWED_MENTIONS = { parse: [] } as const;

/**
 * Apply the V2 mention policy to an already serialized Discord API body.
 *
 * Message/channel/webhook payloads put `flags` at the top level.  Interaction
 * callbacks put the same message data under `data`, so both shapes are handled
 * here.  Bodies without the V2 bit are returned unchanged, which preserves the
 * existing non-V2 client behavior and its allowed-mentions defaults.
 *
 * When the caller explicitly set `allowed_mentions` (e.g. the welcome message
 * intentionally pinging the new member), it is preserved untouched.  Only
 * payloads without an explicit choice get the safe default `{ parse: [] }`,
 * so component text can no longer ping users/roles/@everyone by accident.
 * `replied_user` is deliberately left alone: V1 replies pinged the author and
 * that behavior is kept.
 */
export function applyComponentsV2MentionPolicy<T extends JsonRecord>(body: T): T {
  if (isRecord(body.data) && hasComponentsV2Flag(body.data)) {
    if (isRecord(body.data.allowed_mentions)) return body;
    return {
      ...body,
      data: {
        ...body.data,
        allowed_mentions: API_ALLOWED_MENTIONS,
      },
    } as T;
  }

  if (hasComponentsV2Flag(body)) {
    if (isRecord(body.allowed_mentions)) return body;
    return {
      ...body,
      allowed_mentions: API_ALLOWED_MENTIONS,
    } as T;
  }

  return body;
}

export function isRecordPayload(value: unknown): value is JsonRecord {
  return isRecord(value);
}
