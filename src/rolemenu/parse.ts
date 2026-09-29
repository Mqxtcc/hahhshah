// src/rolemenu/parse.ts
// ---------------------------------------------------------------------------
// Rol menüsü komutları için argüman ayrıştırıcılar (prefix + slash köprüsü
// aynı biçimi kullanır; slash map'i argümanları bu biçime dönüştürür).
// ---------------------------------------------------------------------------

import type { Guild } from "discord.js";
import { normalizeEmoji, labelFor } from "./store.js";
import type { RoleMenuItem } from "../db/schema.js";

const ROLE_MENTION = /<@&(\d+)>/;

export interface ParsedMenu {
  title: string;
  items: RoleMenuItem[];
  error?: string;
}

function resolveRole(guild: Guild, id: string) {
  return guild.roles.cache.get(id) ?? null;
}

/**
 * Butonrol biçimi: `Başlık kelimeleri @rol etiket kelimeleri @rol2 ...`
 * Başlık = ilk rol etiketinden önceki kelimeler; her rol etiketinden
 * sonraki kelimeler (sonraki etikete kadar) o rolün düğme etiketidir.
 */
export function parseButtonArgs(guild: Guild, args: string[]): ParsedMenu {
  const titleParts: string[] = [];
  const items: RoleMenuItem[] = [];
  let current: { roleId: string; labelParts: string[] } | null = null;
  let seenMention = false;

  const flush = () => {
    if (!current) return;
    const role = resolveRole(guild, current.roleId);
    if (!role) return;
    items.push({ roleId: current.roleId, label: labelFor(role, current.labelParts.join(" ")) });
    current = null;
  };

  for (const tok of args) {
    const m = tok.match(ROLE_MENTION);
    if (m) {
      seenMention = true;
      flush();
      current = { roleId: m[1], labelParts: [] };
    } else if (!seenMention) {
      titleParts.push(tok);
    } else if (current) {
      current.labelParts.push(tok);
    }
  }
  flush();

  const title = titleParts.join(" ").trim();
  if (!title) return { title: "", items, error: "Başlık yazmadın." };
  if (items.length === 0) return { title, items, error: "En az bir rol etiketi gerekli: `!butonrol #kanal Başlık @rol Etiket`" };
  if (items.length > 25) return { title, items, error: "En fazla 25 rol." };
  return { title, items };
}

/**
 * Emojirol biçimi: `Başlık 👍 @rol 🎉 @rol2 ...`
 * Başlık = ilk emoji/rol etiketinden önceki kelimeler; sonra katı
 * `emoji @rol` çiftleri beklenir.
 */
export function parseEmojiArgs(guild: Guild, args: string[]): ParsedMenu {
  const titleParts: string[] = [];
  const items: RoleMenuItem[] = [];
  let i = 0;
  // Başlığı bul: ilk emoji-benzeri veya rol etiketi başlayana kadar.
  for (; i < args.length; i++) {
    const tok = args[i];
    if (ROLE_MENTION.test(tok) || normalizeEmoji(tok)) break;
    titleParts.push(tok);
  }
  for (; i < args.length; i += 2) {
    const emojiTok = args[i];
    const mentionTok = args[i + 1];
    const emoji = emojiTok ? normalizeEmoji(emojiTok) : null;
    const m = mentionTok ? mentionTok.match(ROLE_MENTION) : null;
    if (!emoji || !m) {
      return {
        title: "", items,
        error: "Biçim bozuk: `!emojirol #kanal Başlık 👍 @rol 🎉 @rol2` (emoji + rol çifti)",
      };
    }
    const role = resolveRole(guild, m[1]);
    if (!role) continue;
    items.push({ roleId: m[1], label: labelFor(role), emoji });
  }
  const title = titleParts.join(" ").trim();
  if (!title) return { title: "", items, error: "Başlık yazmadın." };
  if (items.length === 0) return { title, items, error: "En az bir `emoji @rol` çifti gerekli." };
  if (items.length > 20) return { title, items, error: "En fazla 20 emoji-rol çifti." };
  return { title, items };
}

/**
 * Kategorirol biçimi: `Başlık @rol @rol2 ...`
 * Etiketler rol adından gelir; seçim menüsü (dropdown) kurulur.
 */
export function parseSelectArgs(guild: Guild, args: string[]): ParsedMenu {
  const titleParts: string[] = [];
  const items: RoleMenuItem[] = [];
  let seenMention = false;
  for (const tok of args) {
    const m = tok.match(ROLE_MENTION);
    if (m) {
      seenMention = true;
      const role = resolveRole(guild, m[1]);
      if (role && !items.some((x) => x.roleId === m[1])) {
        items.push({ roleId: m[1], label: labelFor(role) });
      }
    } else if (!seenMention) {
      titleParts.push(tok);
    }
  }
  const title = titleParts.join(" ").trim();
  if (!title) return { title: "", items, error: "Başlık yazmadın." };
  if (items.length === 0) return { title, items, error: "En az bir rol etiketi gerekli: `!kategorirol #kanal Başlık @rol @rol2`" };
  if (items.length > 25) return { title, items, error: "En fazla 25 rol." };
  return { title, items };
}

/** Rol hiyerarşisi: bot bu rollerin hepsini verebilmeli. */
export function hierarchyProblems(guild: Guild, items: RoleMenuItem[]): string[] {
  const me = guild.members.me;
  const problems: string[] = [];
  for (const item of items) {
    const role = resolveRole(guild, item.roleId);
    if (!role) {
      problems.push(`Rol bulunamadı: ${item.roleId}`);
      continue;
    }
    if (role.managed) problems.push(`Entegrasyon rolü: ${role.name}`);
    else if (role.id === guild.id) problems.push("@everyone verilemez");
    else if (me && me.roles.highest.position <= role.position) problems.push(`Benden üstte: ${role.name}`);
  }
  return problems;
}
