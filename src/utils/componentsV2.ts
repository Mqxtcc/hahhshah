import {
  ActionRowBuilder,
  ButtonBuilder,
  ContainerBuilder,
  FileBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { db, emojiOverridesTable } from "../db/index.js";
import { EMOJIS } from "./emojis.js";

/** Discord Components V2 requires this flag on every message payload. */
export const COMPONENTS_V2_FLAG = MessageFlags.IsComponentsV2;

/** Semantic palette; only usage (blue) and error (red) cards use an accent stripe. */
export const COMPONENTS_V2_COLORS = {
  info: 0x3498db,
  success: 0x2ecc71,
  error: 0xe74c3c,
  usage: 0xfee75c,
} as const;

export type CardOptions = {
  title?: string;
  description?: string;
  lines?: string | string[];
  stats?: string;
  thumbnail?: string;
  thumbnailDescription?: string;
  image?: string;
  accentColor?: number;
  buttons?: ButtonBuilder[];
  separator?: boolean;
};

function text(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(resolveEmojis(content));
}

function displayParts(content: string): string[] {
  let remaining = resolveEmojis(content || "\u200b");
  const parts: string[] = [];
  while (remaining.length > 4000) {
    let boundary = remaining.lastIndexOf("\n", 4000);
    if (boundary < 2000) boundary = 4000;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  parts.push(remaining || "\u200b");
  return parts;
}

function addTextDisplays(container: ContainerBuilder, content: string): void {
  container.addTextDisplayComponents(...displayParts(content).map(text));
}

function joinedLines(lines?: string | string[]): string {
  return Array.isArray(lines) ? lines.join("\n") : lines ?? "";
}

function makeCard(options: CardOptions): ContainerBuilder {
  const card = new ContainerBuilder();
  const title = options.title?.trim();
  const description = options.description?.trim();
  const lines = joinedLines(options.lines).trim();

  if (options.thumbnail && (title || description)) {
    const section = new SectionBuilder();
    if (title) section.addTextDisplayComponents(text(`## ${title}`));
    const descriptionParts = description ? displayParts(description) : [];
    const sectionCapacity = 3 - (title ? 1 : 0);
    section.addTextDisplayComponents(...descriptionParts.slice(0, sectionCapacity).map(text));
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(options.thumbnail)
        .setDescription(resolveEmojis(options.thumbnailDescription ?? title ?? "Görsel")),
    );
    card.addSectionComponents(section);
    for (const part of descriptionParts.slice(sectionCapacity)) card.addTextDisplayComponents(text(part));
  } else {
    if (title) card.addTextDisplayComponents(text(`## ${title}`));
    if (description) addTextDisplays(card, description);
  }

  if (options.separator && card.components.length > 0) {
    card.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
  }
  if (lines) addTextDisplays(card, lines);
  if (options.image) {
    card.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(options.image).setDescription(resolveEmojis(title ?? "Görsel")),
      ),
    );
  }
  if (options.stats) addTextDisplays(card, `-# ${options.stats}`);
  if (options.buttons?.length) card.addActionRowComponents(buttonRow(options.buttons));

  // Keep a valid, minimal body even when a caller passes an empty card.
  if (card.components.length === 0) card.addTextDisplayComponents(text("\u200b"));
  if (options.accentColor !== undefined) card.setAccentColor(options.accentColor);
  return card;
}

/** Informational card; optional thumbnail and controls are used only when needed. */
export function infoCard(options: CardOptions): ContainerBuilder {
  return makeCard(options);
}

/** Help-menu card using the shared informational layout. */
export function helpCard(options: CardOptions): ContainerBuilder {
  return makeCard(options);
}

/** Compact usage/error card: usage is blue; all errors are red. */
export function errorCard(
  options: CardOptions & { usage?: boolean; usageText?: string },
): ContainerBuilder {
  const isUsage = Boolean(options.usage);
  const accent = isUsage ? COMPONENTS_V2_COLORS.usage : COMPONENTS_V2_COLORS.error;
  const heading = isUsage
    ? `**${EMOJIS.usage} Kullanım**`
    : options.title?.trim() ? `**${options.title.trim()}**` : "";
  const body = [
    heading,
    options.description,
    joinedLines(options.lines),
    options.usageText ? `**Kullanım:**\n${options.usageText}` : "",
    options.stats ? `-# ${options.stats}` : "",
  ]
    .filter(Boolean)
    .join(isUsage ? "\n" : " ");
  return makeCard({ ...options, title: undefined, description: body, lines: undefined, stats: undefined })
    .setAccentColor(accent);
}

/** Plain system/settings panel without an accent stripe. */
export function panelCard(options: CardOptions): ContainerBuilder {
  return makeCard(options);
}

/** Plain top-level TextDisplay components for ordinary bot messages. */
export function textCard(content: string, _accentColor?: number): TextDisplayBuilder[] {
  return displayParts(content || "\u200b").map(text);
}

/** Reference an attached upload from a Components V2 file component. */
export function fileComponent(filename: string): FileBuilder {
  return new FileBuilder().setURL(`attachment://${filename}`);
}

/** Build file components for AttachmentBuilder-like values with a name. */
export function fileComponents(files: readonly unknown[]): FileBuilder[] {
  return files.flatMap((file) => {
    if (!file || typeof file !== "object") return [];
    const name = (file as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? [fileComponent(name)] : [];
  });
}

/** Add a row of existing buttons without changing their IDs or behavior. */
export function buttonRow(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  for (const button of buttons) {
    const label = (button.data as { label?: unknown }).label;
    if (typeof label === "string") button.setLabel(resolveEmojis(label));
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/**
 * Transitional V2 card builder preserving the fluent methods used by existing
 * command code while serializing only a Container component (never an embed).
 */
export class V2CardBuilder extends ContainerBuilder {
  private cardTitle?: string;
  private cardDescription?: string;
  private cardAuthor?: string;
  private cardAuthorIcon?: string;
  private cardAuthorUrl?: string;
  private cardThumbnail?: string;
  private cardImage?: string;
  private cardFooter?: string;
  private cardFooterIcon?: string;
  private cardTimestamp?: Date;
  private cardUrl?: string;
  private cardFields: { name: string; value: string; inline?: boolean }[] = [];
  private cardColor?: number;

  setColor(color: number): this {
    this.cardColor = color;
    return this;
  }

  setTitle(title: string): this {
    this.cardTitle = title;
    return this;
  }

  setDescription(description: string): this {
    this.cardDescription = description;
    return this;
  }

  setAuthor(author: { name: string; iconURL?: string; url?: string }): this {
    this.cardAuthor = author.name;
    this.cardAuthorIcon = author.iconURL;
    this.cardAuthorUrl = author.url;
    return this;
  }

  setURL(url: string): this {
    this.cardUrl = url;
    return this;
  }

  setThumbnail(url: string): this {
    this.cardThumbnail = url;
    return this;
  }

  setImage(url: string): this {
    this.cardImage = url;
    return this;
  }

  addFields(
    ...fields: ({ name: string; value: string; inline?: boolean } | { name: string; value: string; inline?: boolean }[])[]
  ): this {
    for (const field of fields.flat()) this.cardFields.push(field);
    return this;
  }

  setFooter(footer: string | { text: string; iconURL?: string }): this {
    this.cardFooter = typeof footer === "string" ? footer : footer.text;
    this.cardFooterIcon = typeof footer === "string" ? undefined : footer.iconURL;
    return this;
  }

  setTimestamp(timestamp?: Date | number): this {
    this.cardTimestamp = timestamp instanceof Date ? timestamp : new Date(timestamp ?? Date.now());
    return this;
  }

  override toJSON() {
    let titleStr = this.cardTitle;
    if (this.cardUrl && titleStr) titleStr = `[${titleStr}](${this.cardUrl})`;

    const descParts: string[] = [];
    if (this.cardAuthor) {
      const author = this.cardAuthorUrl
        ? `[${this.cardAuthor}](${this.cardAuthorUrl})`
        : this.cardAuthor;
      descParts.push(`**${author}**`);
    }
    if (this.cardDescription) {
      descParts.push(this.cardDescription);
    }

    const lines: string[] = [];
    if (this.cardFields.length) {
      lines.push(this.cardFields.map(f => `**${f.name}**\n${f.value}`).join("\n\n"));
    }

    let stats = this.cardFooter;
    if (this.cardTimestamp) {
      const time = `<t:${Math.floor(this.cardTimestamp.getTime() / 1000)}:R>`;
      stats = stats ? `${stats} · ${time}` : time;
    }

    const card = makeCard({
      title: titleStr,
      description: descParts.length > 0 ? descParts.join("\n\n") : undefined,
      lines: lines.length > 0 ? lines : undefined,
      thumbnail: this.cardThumbnail ?? this.cardAuthorIcon,
      thumbnailDescription: this.cardTitle ?? this.cardAuthor ?? "Görsel",
      image: this.cardImage,
      stats: stats,
      accentColor: this.cardColor,
    });
    
    // Preserve custom footer icon if provided using a minimal footer section
    if (this.cardFooterIcon) {
       const footerSection = new SectionBuilder().addTextDisplayComponents(text(`-# ${stats || this.cardFooter}`));
       footerSection.setThumbnailAccessory(
         new ThumbnailBuilder()
           .setURL(this.cardFooterIcon)
           .setDescription(resolveEmojis(this.cardFooter ?? "İkon")),
       );
       card.addSectionComponents(footerSection);
    }

    return card.toJSON();
  }
}

const emojiOverrides = new Map<string, string>();
let emojiOverridesLoaded = false;

/** Load persisted unicode-to-custom emoji mappings after the DB tables are ready. */
export async function loadEmojiOverrides(): Promise<void> {
  const rows = await db.select().from(emojiOverridesTable);
  emojiOverrides.clear();
  for (const row of rows) emojiOverrides.set(row.unicode, row.custom);
  emojiOverridesLoaded = true;
}

/** Update the in-memory view immediately after a command changes persistence. */
export function setEmojiOverride(unicode: string, custom: string): void {
  emojiOverrides.set(unicode, custom);
  emojiOverridesLoaded = true;
}

export function removeEmojiOverride(unicode: string): void {
  emojiOverrides.delete(unicode);
}

/**
 * Resolve configured emoji outside inline/fenced code spans. Longest keys are
 * replaced first so multi-codepoint emoji cannot be partially consumed.
 */
export function resolveEmojis(value: string): string {
  if (!emojiOverridesLoaded || emojiOverrides.size === 0 || !value) return value;
  const keys = [...emojiOverrides.keys()].sort((a, b) => b.length - a.length);
  const codeSpan = /(```[\s\S]*?```|`[^`]*`)/g;
  return value.split(codeSpan).map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return part;
    let resolved = part;
    for (const unicode of keys) resolved = resolved.split(unicode).join(emojiOverrides.get(unicode)!);
    return resolved;
  }).join("");
}
