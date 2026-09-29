import { V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags, type GuildMember, type Message } from "discord.js";
import type { Command } from "../types.js";
import { COLORS } from "../utils/embeds.js";
import { errorEmbed } from "../utils/embeds.js";
import { getUserColor } from "../utils/userColor.js";
import { ensurePremiumLoaded, isPremium, getGiftExpiry } from "../premium/store.js";
import { INVITE_TIERS, getInviteStats } from "../invites/store.js";
import { addSlash } from "../utils/slashBridge.js";

function formatDate(date: Date): string {
  return date.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" });
}

/** Kullanıcının rozet satırı: premium + davet rozetleri. */
async function buildBadges(userId: string): Promise<string> {
  const badges: string[] = [];
  try {
    await ensurePremiumLoaded();
    if (isPremium(userId)) {
      const giftExp = getGiftExpiry(userId);
      badges.push(giftExp ? `⭐ Premium (hediye, ${formatDate(giftExp)}'e kadar)` : "⭐ Premium Üye");
    }
  } catch {
    /* premium okunamazsa rozetsiz devam */
  }
  try {
    const stats = await getInviteStats(userId);
    for (const tier of INVITE_TIERS) {
      if (stats.badges.includes(tier.key)) badges.push(tier.badge);
    }
    if (stats.invites > 0 && badges.length === 0) badges.push(`🎁 ${stats.invites} davet`);
  } catch {
    /* davet okunamazsa geç */
  }
  return badges.length > 0 ? badges.join(" · ") : "Rozet yok — `!davet` ile kazanmaya başla!";
}

const command: Command = {
  name: "bilgi",
  aliases: ["userinfo", "kullanici", "ui"],
  description: "Kendin ya da bir kullanıcı hakkında bilgi gösterir",
  usage: "!bilgi [@kullanıcı]",
  category: "genel",

  async execute(message: Message) {
    if (!message.guild) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }

    const mentioned = message.mentions.members?.first();
    const member: GuildMember = mentioned ?? (message.member as GuildMember);

    const roles = member.roles.cache
      .filter((r) => r.id !== message.guild!.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => `<@&${r.id}>`);

    // ⭐ Premium rengi varsa onu kullan, yoksa rol rengi, o da yoksa varsayılan.
    const customColor = await getUserColor(member.id).catch(() => null);
    const embedColor =
      customColor ??
      (member.displayHexColor !== "#000000"
        ? Number.parseInt(member.displayHexColor.slice(1), 16)
        : COLORS.info);

    const badges = await buildBadges(member.id);

    const embed = new V2CardBuilder()
      .setColor(embedColor)
      .setTitle(`👤 ${member.user.tag}`)
      .setThumbnail(member.user.displayAvatarURL({ size: 512 }))
      .addFields(
        { name: "🏅 Rozetler", value: badges },
        { name: "Takma ad", value: member.displayName, inline: true },
        { name: "Kullanıcı ID", value: member.id, inline: true },
        { name: "Bot mu?", value: member.user.bot ? "Evet" : "Hayır", inline: true },
        { name: "Hesap oluşturulma", value: formatDate(member.user.createdAt), inline: true },
        { name: "Sunucuya katılma", value: member.joinedAt ? formatDate(member.joinedAt) : "bilinmiyor", inline: true },
        { name: `Roller (${roles.length})`, value: roles.length > 0 ? roles.slice(0, 20).join(", ") : "yok" },
      )
      .setFooter({ text: `İsteyen: ${message.author.tag}` })
      .setTimestamp();

    return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [embed] });
  },
};


addSlash(command, [
  { name: "kullanici", description: "Bilgisi görülecek kullanıcı", type: "user" },
]);

export default command;
