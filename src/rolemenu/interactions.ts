import { v2Payload } from "../utils/messages.js";
// src/rolemenu/interactions.ts
// ---------------------------------------------------------------------------
// 🎭 Rol menüsü etkileşimleri: `rm:<menuId>:<roleId>` (buton) ve
// `rms:<menuId>` (select menü). Menü tanımı DB'den gelir; restart'lar
// arası çalışır. Bilinmeyen menü dürüstçe "artık aktif değil" der.
// ---------------------------------------------------------------------------

import {
  type ButtonInteraction,
  type GuildMember,
  type Interaction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getMenu, parseMenuConfig } from "./store.js";

async function toggleRole(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  menuId: string,
  roleId: string,
): Promise<void> {
  const menu = await getMenu(menuId).catch(() => null);
  if (!menu || menu.guildId !== interaction.guildId) {
    await interaction.reply(v2Payload({ content: "Bu rol menüsü artık aktif değil.", ephemeral: true })).catch(() => null);
    return;
  }
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;
  if (!guild || !member) {
    await interaction.reply(v2Payload({ content: "Sunucu bilgisi okunamadı.", ephemeral: true })).catch(() => null);
    return;
  }
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    await interaction.reply(v2Payload({ content: "Bu rol artık sunucuda yok.", ephemeral: true })).catch(() => null);
    return;
  }
  const me = guild.members.me;
  if (!me || me.roles.highest.position <= role.position) {
    await interaction.reply(v2Payload({
      content: "Botun yetkisi bu role yetmiyor — bot rolünü daha yukarı taşı.",
      ephemeral: true,
    })).catch(() => null);
    return;
  }
  const cfg = parseMenuConfig(menu);
  const item = cfg.items.find((i) => i.roleId === roleId);
  const label = item?.label ?? role.name;
  try {
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, `Rol menüsü: ${menu.title}`);
      await interaction.reply(v2Payload({ content: `❌ **${label}** rolü alındı.`, ephemeral: true })).catch(() => null);
    } else {
      await member.roles.add(roleId, `Rol menüsü: ${menu.title}`);
      await interaction.reply(v2Payload({ content: `✅ **${label}** rolü verildi!`, ephemeral: true })).catch(() => null);
    }
  } catch {
    await interaction.reply(v2Payload({ content: "Rol işlemi başarısız — yetki/hiyerarşiyi kontrol et.", ephemeral: true })).catch(() => null);
  }
}

/**
 * interactionCreateEvent'in en başından çağrılır.
 * Rol menüsüne aitse işleyip true döner, değilse false.
 */
export async function handleRoleMenuInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton() && interaction.customId.startsWith("rm:")) {
    const [, menuId, roleId] = interaction.customId.split(":");
    if (!menuId || !roleId) return true; // bozuk id — yut, başkası bakmasın
    await toggleRole(interaction, menuId, roleId);
    return true;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rms:")) {
    const menuId = interaction.customId.slice("rms:".length);
    const roleId = interaction.values[0];
    if (!menuId || !roleId) return true;
    await toggleRole(interaction, menuId, roleId);
    return true;
  }
  return false;
}
