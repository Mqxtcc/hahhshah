import { ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";
import { EMOJIS } from "./emojis.js";
import { BOT_NAME } from "../config.js";
import { COMPONENTS_V2_COLORS, errorCard, infoCard, resolveEmojis, V2CardBuilder } from "./componentsV2.js";

export const COLORS = {
  brand: 0xd0a840,
  info: COMPONENTS_V2_COLORS.info,
  success: COMPONENTS_V2_COLORS.success,
  error: COMPONENTS_V2_COLORS.error,
  // Retained for legacy callers; V2CardBuilder.setColor is intentionally a no-op.
  warning: COMPONENTS_V2_COLORS.error,
  level: 0xf0c14a,
  premium: 0xd0a840,
  dark: 0x1a1a1e,
} as const;

type EmbedExtras = {
  thumbnail?: string;
  image?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
};

function applyBrand(card: V2CardBuilder, footer?: string): V2CardBuilder {
  card.setFooter(footer ?? `${BOT_NAME} `).setTimestamp();
  return card;
}

function applyContainerBrand(card: ContainerBuilder, footer = `${BOT_NAME} `): ContainerBuilder {
  const timestamp = Math.floor(Date.now() / 1000);
  card.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(resolveEmojis(`-# ${footer.trim()} · <t:${timestamp}:R>`)),
  );
  return card;
}

function applyExtras(card: V2CardBuilder, extras?: EmbedExtras): V2CardBuilder {
  if (!extras) return card;
  if (extras.thumbnail) card.setThumbnail(extras.thumbnail);
  if (extras.image) card.setImage(extras.image);
  if (extras.fields?.length) card.addFields(extras.fields);
  if (extras.footer) card.setFooter(extras.footer);
  return card;
}

function errorDetails(description?: string, extras?: EmbedExtras): string {
  const fields = extras?.fields?.map((field) => `**${field.name}**\n${field.value}`).join("\n\n");
  const footer = extras?.footer ? `-# ${extras.footer}` : "";
  return [description, fields, footer].filter(Boolean).join("\n\n");
}

function usageMessage(title: string, details: string): boolean {
  return /kullanım/i.test(title) || /(?:^|\n)\s*(?:<a?:[a-zA-Z0-9_]+:\d+>\s*)?Kullanım\s*:/i.test(details);
}

function usageBody(details: string): string {
  return details.replace(/^(?:<a?:[a-zA-Z0-9_]+:\d+>\s*)?Kullanım\s*:\s*/i, "").trim();
}

export function successEmbed(title: string, description?: string, extras?: EmbedExtras): ContainerBuilder {
  const cardOptions: import("./componentsV2.js").CardOptions = {
    title: `${EMOJIS.success} ${title}`,
    description: description,
    accentColor: COLORS.success,
    thumbnail: extras?.thumbnail,
    image: extras?.image,
  };
  
  if (extras?.fields?.length) {
    cardOptions.lines = extras.fields.map(f => `**${f.name}**\n${f.value}`).join("\n\n");
  }
  
  return applyContainerBrand(infoCard(cardOptions), extras?.footer);
}

export function errorEmbed(title: string, description?: string, extras?: EmbedExtras): ContainerBuilder {
  const details = errorDetails(description, extras);
  if (usageMessage(title, details)) {
    const body = usageBody(details);
    return applyContainerBrand(errorCard({
      usage: true,
      description: body || details,
      thumbnail: extras?.thumbnail,
      image: extras?.image,
    }));
  }
  return applyContainerBrand(errorCard({
    title: `${EMOJIS.error} ${title}`,
    description: details,
    thumbnail: extras?.thumbnail,
    image: extras?.image,
  }));
}

export function permissionErrorEmbed(description: string, botAvatarUrl?: string): ContainerBuilder {
  return applyContainerBrand(errorCard({
    title: `${EMOJIS.error} Yetkim Yok`,
    description,
    thumbnail: botAvatarUrl,
  }), `${BOT_NAME} • Yetki Hatası`);
}

export function warningEmbed(title: string, description?: string, extras?: EmbedExtras): ContainerBuilder {
  const details = errorDetails(description, extras);
  if (usageMessage(title, details)) {
    const body = usageBody(details);
    return applyContainerBrand(errorCard({
      usage: true,
      description: body || details,
      thumbnail: extras?.thumbnail,
      image: extras?.image,
    }));
  }
  return applyContainerBrand(infoCard({
    title: `${EMOJIS.alert} ${title}`,
    description: details,
    thumbnail: extras?.thumbnail,
    image: extras?.image,
  }));
}

export function infoEmbed(title: string, description?: string, extras?: EmbedExtras): ContainerBuilder {
  const cardOptions: import("./componentsV2.js").CardOptions = {
    title: `${EMOJIS.general} ${title}`,
    description: description,
    accentColor: COLORS.info,
    thumbnail: extras?.thumbnail,
    image: extras?.image,
  };
  if (extras?.fields?.length) {
    cardOptions.lines = extras.fields.map(f => `**${f.name}**\n${f.value}`).join("\n\n");
  }
  return applyContainerBrand(infoCard(cardOptions), extras?.footer);
}

export function premiumEmbed(title: string, description?: string, extras?: EmbedExtras): ContainerBuilder {
  const cardOptions: import("./componentsV2.js").CardOptions = {
    title: `${EMOJIS.prm1} ${title}`,
    description: description,
    accentColor: COLORS.premium,
    thumbnail: extras?.thumbnail,
    image: extras?.image,
  };
  if (extras?.fields?.length) {
    cardOptions.lines = extras.fields.map(f => `**${f.name}**\n${f.value}`).join("\n\n");
  }
  return applyContainerBrand(infoCard(cardOptions), extras?.footer);
}

export function premiumStatusLine(label: string, active: boolean): string {
  return `${EMOJIS.prm3} **${label}** ${active ? `${EMOJIS.success} Aktif` : `${EMOJIS.error} Pasif`}`;
}

export function levelEmbed(title: string, description?: string, extras?: EmbedExtras): ContainerBuilder {
  const cardOptions: import("./componentsV2.js").CardOptions = {
    title: `${EMOJIS.yildirim} ${title}`,
    description: description,
    accentColor: COLORS.level,
    thumbnail: extras?.thumbnail,
    image: extras?.image,
  };
  if (extras?.fields?.length) {
    cardOptions.lines = extras.fields.map(f => `**${f.name}**\n${f.value}`).join("\n\n");
  }
  return applyContainerBrand(infoCard(cardOptions), extras?.footer);
}

export function moderationEmbed(opts: {
  action: string;
  emoji?: string;
  color?: number;
  targetTag: string;
  targetId: string;
  targetAvatar?: string;
  moderatorTag: string;
  reason: string;
  caseId: string;
  duration?: string;
  extraFields?: { name: string; value: string; inline?: boolean }[];
}): ContainerBuilder {
  const lines = [
    `**${EMOJIS.user} Kullanıcı**\n${opts.targetTag} (\`${opts.targetId}\`)`,
    `**${EMOJIS.admin} Yetkili**\n${opts.moderatorTag}`,
    `**${EMOJIS.role} Vaka No**\n\`${opts.caseId}\``,
    `**${EMOJIS.info} Sebep**\n${opts.reason || "Belirtilmedi"}`,
  ];
  if (opts.duration) lines.push(`**${EMOJIS.loading} Süre**\n${opts.duration}`);
  if (opts.extraFields?.length) {
    for (const f of opts.extraFields) lines.push(`**${f.name}**\n${f.value}`);
  }
  
  return infoCard({
    title: `${opts.emoji ?? EMOJIS.mod} ${opts.action}`,
    lines: lines.join("\n\n"),
    thumbnail: opts.targetAvatar,
    accentColor: opts.color ?? COLORS.error,
    stats: `${BOT_NAME} · <t:${Math.floor(Date.now() / 1000)}:R>`,
  });
}

export const ButtonStyles = {
  primary: (customId: string, label: string, emoji?: string) =>
    new ButtonBuilder().setCustomId(customId).setLabel(resolveEmojis(label)).setStyle(ButtonStyle.Primary).setEmoji(resolveEmojis(emoji ?? EMOJIS.general)),
  success: (customId: string, label: string, emoji?: string) =>
    new ButtonBuilder().setCustomId(customId).setLabel(resolveEmojis(label)).setStyle(ButtonStyle.Success).setEmoji(resolveEmojis(emoji ?? EMOJIS.success)),
  danger: (customId: string, label: string, emoji?: string) =>
    new ButtonBuilder().setCustomId(customId).setLabel(resolveEmojis(label)).setStyle(ButtonStyle.Danger).setEmoji(resolveEmojis(emoji ?? EMOJIS.error)),
  secondary: (customId: string, label: string, emoji?: string) =>
    new ButtonBuilder().setCustomId(customId).setLabel(resolveEmojis(label)).setStyle(ButtonStyle.Secondary).setEmoji(resolveEmojis(emoji ?? EMOJIS.info)),
  premium: (customId: string, label: string, emoji?: string) =>
    new ButtonBuilder().setCustomId(customId).setLabel(resolveEmojis(label)).setStyle(ButtonStyle.Success).setEmoji(resolveEmojis(emoji ?? EMOJIS.prm2)),
};

/** V2 counterpart of the former banner helper; intentionally adds no decoration. */
export function brandBanner<T extends V2CardBuilder>(card: T): T {
  return card;
}

export function progressBar(current: number, max: number, length = 15): string {
  const filled = Math.min(length, Math.round((current / max) * length));
  const empty = length - filled;
  return `\`${"▰".repeat(filled)}${"▱".repeat(empty)}\` **${Math.round((current / max) * 100)}%**`;
}
