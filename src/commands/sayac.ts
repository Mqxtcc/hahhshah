import { errorCard, textCard } from "../utils/componentsV2.js";
import { MessageFlags, ChannelType, PermissionFlagsBits, type Message } from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import { requireModPerm, NO_PING, msg } from "./mod/_shared.js";
import { setCounter, clearCounter, getCounter, counterChannelName } from "../counter/store.js";
import { addSlash } from "../utils/slashBridge.js";

const command: Command = {
  name: "sayaç",
  aliases: ["sayac", "counter", "üyesayacı"],
  description: "Üye sayısı sayacı kurar (ses kanalının adı otomatik güncellenir)",
  usage: "!sayaç <hedef> [#kanal]  →  kapatmak için: !sayaç kapat",
  category: "genel",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucuda çalışır.")] });
    }
    if (!(await requireModPerm(message, "sayaç", PermissionFlagsBits.ManageGuild))) return;

    const sub = (args[0] ?? "").toLocaleLowerCase("tr-TR");

    if (sub === "kapat" || sub === "sil") {
      const existing = await getCounter(message.guild.id).catch(() => null);
      if (!existing) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Zaten kurulu bir sayaç yok.") })], ...NO_PING });
      }
      await clearCounter(message.guild.id).catch(() => null);
      const ch = message.guild.channels.cache.get(existing.channelId);
      if (ch) await ch.delete("Sayaç kapatıldı").catch(() => null);
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: textCard(msg.ok("Sayaç kapatıldı, kanal silindi.")), ...NO_PING });
    }

    const target = parseInt(args[0] ?? "", 10);
    if (isNaN(target) || target < 1 || target > 1_000_000) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Hatalı Kullanım", `Geçerli bir hedef yaz. Kullanım: \`${command.usage}\`\nÖrn: \`!sayaç 500\``)],
      });
    }

    const me = message.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Sayaç kanalı açmak için **Kanalları Yönet** yetkim yok.") })], ...NO_PING });
    }

    // Mevcut sayaç varsa önce temizle (çift kanal kalmasın).
    const existing = await getCounter(message.guild.id).catch(() => null);
    if (existing) {
      const old = message.guild.channels.cache.get(existing.channelId);
      if (old) await old.delete("Sayaç yenileniyor").catch(() => null);
      await clearCounter(message.guild.id).catch(() => null);
    }

    let channel;
    try {
      channel = await message.guild.channels.create({
        name: counterChannelName(message.guild.memberCount, target),
        type: ChannelType.GuildVoice,
        reason: "Üye sayacı kuruldu",
      });
    } catch {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Sayaç kanalı açılamadı — yetki/hiyerarşiyi kontrol et.") })], ...NO_PING });
    }

    await setCounter(message.guild.id, channel.id, target).catch(() => null);
    console.log(`[sayaç] ${message.guild.id} için kuruldu: #${channel.id} hedef=${target}`);
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        infoEmbed(
          "📊 Sayaç Kuruldu",
          `${channel} kanalı sayaç olarak ayarlandı.\n\n🎯 Hedef: **${target}** üye\n👥 Şu an: **${message.guild.memberCount}** üye\n\nÜye girip çıktıkça kanal adı otomatik güncellenir.`,
        ),
      ],
    });
  },
};

addSlash(
  command,
  [
    { name: "hedef", description: "Üye hedefi (kapatmak için 0 yaz)", type: "integer", required: true, minValue: 0, maxValue: 1000000 },
  ],
  (v) => {
    const t = v.int("hedef") ?? 0;
    return t <= 0 ? ["kapat"] : [String(t)];
  },
);

export default command;
