import { V2CardBuilder, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { COLORS } from "../../utils/embeds.js";
import { getQuizLeaderboard } from "../../utils/quizStore.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";

const MEDALS = ["🥇", "🥈", "🥉"];

const command: Command = {
  name: "yarismaskor",
  aliases: ["quizskor", "yarismaliderlik"],
  description: "Bu sunucudaki bilgi yarışması skor tablosunu gösterir",
  usage: `${DEFAULT_PREFIX}yarismaskor`,
  category: "fun",

  async execute(message: Message) {
    if (!message.guild) return;

    const top = await getQuizLeaderboard(message.guild.id, 10);
    if (top.length === 0) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.info} Bu sunucuda henüz kimse bilgi yarışması kazanmadı — \`!bilgiyarismasi\` ile ilk galibiyeti sen al!`) });
    }

    const lines = top.map((entry, i) => {
      const rankLabel = MEDALS[i] ?? `**${i + 1}.**`;
      return `${rankLabel} <@${entry.userId}> — **${entry.wins}** galibiyet`;
    });

    const embed = new V2CardBuilder()
      .setColor(COLORS.info)
      .setTitle("🧠 Bilgi Yarışması Skor Tablosu")
      .setDescription(lines.join("\n"))
      .setTimestamp();

    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [embed] });
  },
};


addSlash(command, []);

export default command;
