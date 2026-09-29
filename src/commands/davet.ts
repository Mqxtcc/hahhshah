import { resolveEmojis, V2CardBuilder } from "../utils/componentsV2.js";
import { MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
} from "discord.js";
import type { Command } from "../types.js";
import { BOT_NAME, INVITE_URL } from "../config.js";
import { COLORS } from "../utils/embeds.js";
import { getUserColor } from "../utils/userColor.js";
import {
  INVITE_TIERS,
  VEST_DAYS,
  MIN_HUMANS,
  getInviteStats,
  nextTier,
  vestMaturedForUser,
} from "../invites/store.js";

function daysLeft(joinedAt: number): number {
  const msLeft = joinedAt + VEST_DAYS * 24 * 60 * 60 * 1000 - Date.now();
  return Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
}

async function buildView(client: Client, userId: string) {
  // Komutu gören kişinin süresi dolmuş davetleri hemen hak kazansın.
  await vestMaturedForUser(client, userId);

  const stats = await getInviteStats(userId);
  const tier = nextTier(stats.invites);
  const customColor = await getUserColor(userId).catch(() => null);

  const embed = new V2CardBuilder()
    .setColor(customColor ?? COLORS.brand)
    .setTitle(`🎁 ${BOT_NAME} Davet Ödülleri`)
    .setDescription(
      [
        `Botu yeni sunuculara davet et, ödülleri kap!`,
        ``,
        `**Hak kazanılmış davet:** \`${stats.invites}\``,
        stats.pending.length > 0
          ? `**Bekleyen:** \`${stats.pending.length}\` (${stats.pending
              .map((p) => {
                const left = daysLeft(p.joinedAt);
                // 7 gün dolmuş ama hâlâ bekliyorsa üye şartı sağlanmıyordur.
                return left > 0 ? `${p.guildName}: ${left} gün` : `${p.guildName}: ⏳ üye şartı bekleniyor`;
              })
              .join(" • ")})`
          : `**Bekleyen:** yok`,
        stats.badges.length > 0
          ? `**Rozetlerin:** ${stats.badges.map((b) => INVITE_TIERS.find((t) => t.key === b)?.badge ?? b).join(" ")}`
          : `**Rozetlerin:** henüz yok`,
      ].join("\n"),
    );

  const tierLines = INVITE_TIERS.map((t) => {
    const done = stats.invites >= t.count;
    return `${done ? "✅" : "⬜"} **${t.count} davet** → ${t.badge} — ${t.reward}`;
  });
  embed.addFields({ name: "🏆 Kademeler", value: tierLines.join("\n") });

  if (tier) {
    embed.addFields({
      name: "🎯 Sonraki hedef",
      value: `${tier.badge} için **${tier.count - stats.invites}** davet daha lazım!`,
    });
  } else {
    embed.addFields({
      name: "🎯 Sonraki hedef",
      value: "Tüm kademeleri tamamladın, efsanesin! 👑",
    });
  }

  embed.setFooter({
    text: `Davet ${VEST_DAYS} gün + en az ${MIN_HUMANS} üyeli sunucuda kalınca sayılır • Boş sunucular sayılmaz`,
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(resolveEmojis("🤖 Botu Davet Et"))
      .setStyle(ButtonStyle.Link)
      .setURL(INVITE_URL),
  );

  return { flags: MessageFlags.IsComponentsV2 as const, components: [embed, row] };
}

const command: Command = {
  name: "davet",
  aliases: ["invite", "davetet"],
  description: "Davet ödül sistemin: istatistiğin, kademeler ve davet linkin",
  usage: "!davet",
  category: "genel",

  slashData: new SlashCommandBuilder()
    .setName("davet")
    .setDescription("Davet ödül istatistiğin ve davet linkin"),

  async execute(message: Message) {
    const view = await buildView(message.client, message.author.id);
    return message.reply({
      ...view, allowedMentions: { repliedUser: false } });
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    const view = await buildView(interaction.client, interaction.user.id);
    await interaction.reply({
      ...view });
  },
};

export default command;
