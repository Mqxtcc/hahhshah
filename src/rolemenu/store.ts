import { COMPONENTS_V2_FLAG, resolveEmojis, V2CardBuilder } from "../utils/componentsV2.js";
import { v2Payload } from "../utils/messages.js";
// src/rolemenu/store.ts
// ---------------------------------------------------------------------------
// 🎭 Rol menüleri: restart-proof tasarım.
//
// Sorun: klasik rol menüleri buton customId'lerini veya collector'ları
// bellekte tutar; bot kapanıp açılınca menüler ölür.
// Çözüm:
//   1) Menü tanımı DB'dedir (discord_role_menus). customId'ler kalıcıdır:
//      buton `rm:<menuId>:<roleId>`, select menü `rms:<menuId>`.
//      interactionCreate DB'den çözümler — restart'tan etkilenmez.
//   2) Açılışta reconcileRoleMenus(): silinmiş menü mesajı AYNI kanala
//      yeniden gönderilir (messageId güncellenir); emoji menülerde botun
//      tepkileri eksikse tamamlanır.
//   3) interactionCreate bilinmeyen/silinmiş menüye gelen tıklamayı
//      "bu menü artık aktif değil" diye dürüstçe yanıtlar (yalan yok).
// ---------------------------------------------------------------------------

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  parseEmoji,
  StringSelectMenuBuilder,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Role,
} from "discord.js";
import { db } from "../db/index.js";
import { roleMenusTable, type RoleMenuConfig, type RoleMenuItem, type RoleMenuRow } from "../db/schema.js";
import { eq } from "../db/jsonOrm.js";
import { COLORS } from "../utils/embeds.js";

export type RoleMenuType = "button" | "select" | "reaction";

const menuCache = new Map<string, RoleMenuRow>();
/** messageId -> menuId (reaksiyon eventleri için hızlı arama). */
const messageIndex = new Map<string, string>();

function newMenuId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Emoji girdisini (`👍` veya `<:elmas:123>`) normalize edilmiş tanıma çevirir. */
export function normalizeEmoji(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const parsed = parseEmoji(t);
  if (!parsed) {
    // parseEmoji unicode'u çözemeyebilir; tek "karakter" ise kabul et.
    return [...t].length <= 4 ? t : null;
  }
  if (parsed.id) return `${parsed.name}:${parsed.id}`;
  return parsed.name ?? null;
}

/** normalizeEmoji çıktısının react() için kullanılabilir hali. */
export function emojiForReact(normalized: string): string {
  return normalized.includes(":") ? `<:${normalized}>` : normalized;
}

function cacheMenu(row: RoleMenuRow): void {
  menuCache.set(row.id, row);
  messageIndex.set(row.messageId, row.id);
}

function uncacheMenu(row: RoleMenuRow): void {
  menuCache.delete(row.id);
  if (messageIndex.get(row.messageId) === row.id) messageIndex.delete(row.messageId);
}

export async function getMenu(id: string): Promise<RoleMenuRow | null> {
  const hit = menuCache.get(id);
  if (hit) return hit;
  const rows = await db.select().from(roleMenusTable).where(eq(roleMenusTable.id, id)).limit(1);
  const row = rows[0] ?? null;
  if (row) cacheMenu(row);
  return row;
}

export async function getMenuByMessage(messageId: string): Promise<RoleMenuRow | null> {
  const id = messageIndex.get(messageId);
  if (id) return getMenu(id);
  const rows = await db.select().from(roleMenusTable);
  const row = rows.find((r) => r.messageId === messageId) ?? null;
  if (row) cacheMenu(row);
  return row;
}

export async function listMenus(guildId: string): Promise<RoleMenuRow[]> {
  const rows = await db.select().from(roleMenusTable).where(eq(roleMenusTable.guildId, guildId));
  for (const r of rows) cacheMenu(r);
  return rows;
}

export function parseMenuConfig(row: RoleMenuRow): RoleMenuConfig {
  try {
    const cfg = JSON.parse(row.config) as RoleMenuConfig;
    if (cfg && Array.isArray(cfg.items)) return cfg;
  } catch { /* bozuk config */ }
  return { items: [] };
}

function menuEmbed(row: RoleMenuRow): V2CardBuilder {
  const typeLabel = row.type === "button" ? "butonlara tıklayarak" : row.type === "select" ? "aşağıdaki menüden seçerek" : "tepki ekleyerek";
  return new V2CardBuilder()
    .setColor(COLORS.brand)
    .setTitle(`🎭 ${row.title}`)
    .setDescription(`İstediğin rolleri ${typeLabel} alıp bırakabilirsin.`);
}

export function buildMenuComponents(row: RoleMenuRow): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const cfg = parseMenuConfig(row);
  if (row.type === "button") {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let cur = new ActionRowBuilder<ButtonBuilder>();
    for (const item of cfg.items.slice(0, 25)) {
      if (cur.components.length >= 5) {
        rows.push(cur);
        cur = new ActionRowBuilder<ButtonBuilder>();
      }
      const btn = new ButtonBuilder()
        .setCustomId(`rm:${row.id}:${item.roleId}`)
        .setLabel(resolveEmojis((item.label ?? "Rol").slice(0, 80)))
        .setStyle(ButtonStyle.Secondary);
      if (item.emoji) btn.setEmoji(resolveEmojis(emojiForReact(item.emoji)));
      cur.addComponents(btn);
    }
    if (cur.components.length > 0) rows.push(cur);
    return rows;
  }
  if (row.type === "select") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rms:${row.id}`)
      .setPlaceholder(resolveEmojis("Almak istediğin rolü seç"))
      .setMinValues(1)
      .setMaxValues(1);
    for (const item of cfg.items.slice(0, 25)) {
      const opt: { label: string; value: string; emoji?: string } = {
        label: resolveEmojis((item.label ?? "Rol").slice(0, 100)),
        value: item.roleId,
      };
      if (item.emoji) opt.emoji = resolveEmojis(emojiForReact(item.emoji));
      menu.addOptions(opt);
    }
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
  }
  return [];
}

async function sendMenuMessage(
  channel: GuildTextBasedChannel,
  row: RoleMenuRow,
): Promise<{ id: string }> {
  const payload: { flags: number; components: (V2CardBuilder | ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>)[] } = {
    flags: COMPONENTS_V2_FLAG,
    components: [menuEmbed(row)],
  };
  const components = buildMenuComponents(row);
  if (components.length > 0) payload.components = [menuEmbed(row), ...components];
  const sent = await channel.send(v2Payload(payload));
  if (row.type === "reaction") {
    const cfg = parseMenuConfig(row);
    for (const item of cfg.items) {
      if (item.emoji) await sent.react(emojiForReact(item.emoji)).catch(() => null);
    }
  }
  return sent;
}

/** Yeni menü oluştur: mesajı gönder, DB'ye yaz, önbelleğe al. */
export async function createMenu(opts: {
  guild: Guild;
  channelId: string;
  type: RoleMenuType;
  title: string;
  items: RoleMenuItem[];
  createdBy: string;
}): Promise<RoleMenuRow> {
  const channel = await opts.guild.channels.fetch(opts.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error("Kanal bulunamadı veya yazılabilir değil.");
  const id = newMenuId();
  const row: RoleMenuRow = {
    id,
    guildId: opts.guild.id,
    channelId: opts.channelId,
    messageId: "",
    type: opts.type,
    title: opts.title,
    config: JSON.stringify({ items: opts.items } satisfies RoleMenuConfig),
    createdBy: opts.createdBy,
    createdAt: new Date(),
  };
  const sent = await sendMenuMessage(channel as GuildTextBasedChannel, row);
  const full: RoleMenuRow = { ...row, messageId: sent.id };
  await db.insert(roleMenusTable).values(full);
  cacheMenu(full);
  return full;
}

/** Menüyü sil: mesajı da kaldır (olmuyorsa sessiz geç), satırı düş. */
export async function deleteMenu(client: Client, id: string): Promise<boolean> {
  const row = await getMenu(id);
  if (!row) return false;
  try {
    const guild = client.guilds.cache.get(row.guildId);
    const channel = guild ? await guild.channels.fetch(row.channelId).catch(() => null) : null;
    if (channel && channel.isTextBased()) {
      const msg = await (channel as GuildTextBasedChannel).messages.fetch(row.messageId).catch(() => null);
      if (msg) await msg.delete().catch(() => null);
    }
  } catch { /* en iyi çaba */ }
  await db.delete(roleMenusTable).where(eq(roleMenusTable.id, id)).catch(() => null);
  uncacheMenu(row);
  return true;
}

/**
 * Açılış uzlaşması: her menünün mesajı duruyor mu bak; silinmişse aynı
 * kanala yeniden gönder ve messageId'yi güncelle. Kanal gitmişse menüyü
 * düşür. Emoji menülerde bot tepkilerini tamamla.
 */
export async function reconcileRoleMenus(client: Client): Promise<void> {
  let resent = 0;
  let dropped = 0;
  try {
    const rows = await db.select().from(roleMenusTable);
    for (const row of rows) {
      cacheMenu(row);
      const guild = client.guilds.cache.get(row.guildId);
      if (!guild) continue;
      const channel = await guild.channels.fetch(row.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await db.delete(roleMenusTable).where(eq(roleMenusTable.id, row.id)).catch(() => null);
        uncacheMenu(row);
        dropped++;
        continue;
      }
      const textChannel = channel as GuildTextBasedChannel;
      const msg = await textChannel.messages.fetch(row.messageId).catch(() => null);
      if (!msg) {
        try {
          const sent = await sendMenuMessage(textChannel, row);
          await db.update(roleMenusTable).set({ messageId: sent.id }).where(eq(roleMenusTable.id, row.id));
          uncacheMenu(row);
          cacheMenu({ ...row, messageId: sent.id });
          resent++;
        } catch (err) {
          console.error(`rol menüsü geri gönderilemedi (${row.id}):`, err instanceof Error ? err.message : err);
        }
        continue;
      }
      if (row.type === "reaction") {
        const cfg = parseMenuConfig(row);
        for (const item of cfg.items) {
          if (!item.emoji) continue;
          const has = msg.reactions.cache.some((r) => {
            const rid = r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : (r.emoji.name ?? "");
            return rid === item.emoji;
          });
          if (!has) await msg.react(emojiForReact(item.emoji)).catch(() => null);
        }
      }
    }
    if (resent > 0 || dropped > 0) {
      console.log(`[rolmenu] ${resent} geri gönderildi, ${dropped} silindi`);
    }
  } catch (err) {
    console.error("rol menüsü uzlaşması patladı:", err instanceof Error ? err.message : err);
  }
}

/** Rol için görünen ad (kayıt anında çözülür, DB'de durur). */
export function labelFor(role: Role, custom?: string): string {
  return (custom?.trim() || role.name).slice(0, 80);
}
