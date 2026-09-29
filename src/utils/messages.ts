import { MessageFlags } from "discord.js";
import { EMOJIS } from "./emojis.js";
import { errorCard, fileComponents, textCard } from "./componentsV2.js";
import { componentsV2AllowedMentions } from "./componentsV2Mentions.js";

/**
 * Kısa komut cevapları için ortak dil.
 * İşlem cevapları düz metin kalır; liste/ayar/log gibi yoğun içerikler
 * ve kullanım rehberi mesajları embed kullanır.
 */
export const MSG = {
  success: (text: string) => `${EMOJIS.success} ${text}`,
  error: (text: string) => `${EMOJIS.error} ${text}`,
  info: (text: string) => `${EMOJIS.general} ${text}`,
  usage: (text: string) => `${EMOJIS.usage} ${text}`,
} as const;

/** Convert legacy message arguments to Components V2 without sending content/embeds. */
export function v2Payload(payload: unknown): any {
  if (typeof payload === "string") {
    return {
      flags: MessageFlags.IsComponentsV2,
      components: textCard(payload),
      allowedMentions: componentsV2AllowedMentions(),
    };
  }
  if (!payload || typeof payload !== "object") {
    return {
      flags: MessageFlags.IsComponentsV2,
      components: textCard("\u200b"),
      allowedMentions: componentsV2AllowedMentions(),
    };
  }
  const source = payload as Record<string, any>;
  const { content, embeds, flags, components, ...rest } = source;
  const nextComponents = Array.isArray(components) ? [...components] : [];
  if (Array.isArray(embeds)) nextComponents.unshift(...embeds);
  if (typeof content === "string" && content.length > 0) nextComponents.unshift(...textCard(content));
  if (Array.isArray(rest.files)) nextComponents.push(...fileComponents(rest.files));
  if (nextComponents.length === 0) nextComponents.push(...textCard("\u200b"));
  return {
    ...rest,
    flags: (typeof flags === "number" ? flags : 0) | MessageFlags.IsComponentsV2,
    components: nextComponents,
    // V2 component text parses mentions, so default to no-ping.  An explicit
    // caller choice (e.g. the welcome ping) is preserved untouched.
    allowedMentions: rest.allowedMentions ?? componentsV2AllowedMentions(),
  };
}

/** Metin başındaki "<emoji> Kullanım:" kalıbı — başlıkta zaten var, gövdeden silinir. */
const LEADING_USAGE_RE = /^(<a?:[a-zA-Z0-9_]+:\d+>\s*)?Kullanım\s*:\s*/i;

/**
 * Küçük kullanım-rehberi V2 kartı. Metin aynen description'a konur;
 * sadece baştaki "<emoji> Kullanım:" kalıbı başlığa taşındığı için gövdeden
 * temizlenir. Başka bir kalıpla başlıyorsa metne dokunulmaz.
 */
export function usageEmbed(text: string): ReturnType<typeof errorCard> {
  const body = text.replace(LEADING_USAGE_RE, "").trim();
  return errorCard({ usage: true, description: body || text });
}
