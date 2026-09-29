import { errorCard, textCard } from "../utils/componentsV2.js";
import { MessageFlags, PermissionFlagsBits, type Message, type TextChannel } from "discord.js";
import type { Command } from "../types.js";
import { errorEmbed } from "../utils/embeds.js";
import { requireModPerm, NO_PING, msg } from "./mod/_shared.js";
import { addSlash, type SlashValues } from "../utils/slashBridge.js";

function targetChannel(message: Message): TextChannel | null {
  const mentioned = message.mentions.channels.first();
  if (mentioned && mentioned.isTextBased()) return mentioned as TextChannel;
  const ch = message.channel;
  return ch.isTextBased() ? (ch as TextChannel) : null;
}

/**
 * 🔒 Kanal kilidi: @everyone için SendMessages=false.
 * Var olan izin üzerine yazmaz, sadece @everyone overwrite'ını kapatır.
 */
const kilit: Command = {
  name: "kilit",
  aliases: ["lock", "kanalkilit"],
  description: "Kanalı kilitler (üyeler yazamaz)",
  usage: "!kilit [#kanal] [sebep]",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }
    if (!(await requireModPerm(message, "kilit", PermissionFlagsBits.ManageChannels))) return;

    const channel = targetChannel(message);
    if (!channel) return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kanal bulunamadı.") })], ...NO_PING });

    const me = message.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Bu kanalda kanal yönetme yetkim yok.") })], ...NO_PING });
    }

    const reason = args.filter((a) => !a.startsWith("<#")).join(" ").trim().slice(0, 200);
    try {
      await channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }, { reason: reason || "Kanal kilitlendi" });
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: textCard(msg.ok(`🔒 <#${channel.id}> kilitlendi.${reason ? ` Sebep: ${reason}` : ""}`)), ...NO_PING });
    } catch (err) {
      console.error("kilit patladı la:", err);
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kilitlenemedi — yetki/hiyerarşiyi kontrol et.") })], ...NO_PING });
    }
  },
};

const kilitac: Command = {
  name: "kilitac",
  aliases: ["unlock", "kilitaç", "kanalkilitac"],
  description: "Kanal kilidini açar (üyeler yeniden yazabilir)",
  usage: "!kilitac [#kanal]",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }
    if (!(await requireModPerm(message, "kilitac", PermissionFlagsBits.ManageChannels))) return;

    const channel = targetChannel(message);
    if (!channel) return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kanal bulunamadı.") })], ...NO_PING });

    const me = message.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Bu kanalda kanal yönetme yetkim yok.") })], ...NO_PING });
    }

    try {
      await channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null }, { reason: "Kanal kilidi açıldı" });
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: textCard(msg.ok(`🔓 <#${channel.id}> kilidi açıldı.`)), ...NO_PING });
    } catch (err) {
      console.error("kilitac patladı la:", err);
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kilidi açılamadı — yetki/hiyerarşiyi kontrol et.") })], ...NO_PING });
    }
  },
};

function kilitArgs(v: SlashValues): string[] {
  const args: string[] = [];
  const ch = v.channelMention("kanal");
  if (ch) args.push(ch);
  const sebep = v.str("sebep");
  if (sebep) args.push(...sebep.split(/\s+/));
  return args;
}

addSlash(
  kilit,
  [
    { name: "kanal", description: "Kilitlenecek kanal (boşsa bu kanal)", type: "channel" },
    { name: "sebep", description: "Kilit sebebi", type: "string" },
  ],
  kilitArgs,
);

addSlash(
  kilitac,
  [{ name: "kanal", description: "Kilidi açılacak kanal (boşsa bu kanal)", type: "channel" }],
  kilitArgs,
);

export default kilit;
export { kilitac };
