import { V2CardBuilder } from "../utils/componentsV2.js";
import { v2Payload } from "../utils/messages.js";
import {
  ChannelType,
  Client,
  Events,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from "discord.js";
import { BOT_NAME, DEFAULT_PREFIX } from "../config.js";
import { COLORS, brandBanner } from "../utils/embeds.js";
import { EMOJIS } from "../utils/emojis.js";
import { recordGuildJoin } from "../invites/store.js";
import { getGuildPrefix } from "./messageCreate.js";

/**
 * Bot bir sunucuya eklendiğinde (veya yeniden eklendiğinde) sistem kanalına
 * veya yazılabilir ilk metin kanalına tanıtım embed'i gönderir.
 * Ayrıca davet ödül sistemi için davet edeni beklemeye alır.
 */
export function registerGuildCreateEvents(client: Client): void {
  client.on(Events.GuildCreate, (guild) => {
    void sendIntroEmbed(guild).catch((err) => {
      console.error(`tanıtım mesajı gitmedi (${guild.id}):`, err);
    });
    // 🎁 Davet ödülü: davet edeni bul, 7 günlük beklemeye al.
    void recordGuildJoin(guild).catch((err) => {
      console.error(`davet kaydolmadı (${guild.id}):`, err);
    });
  });
}

async function sendIntroEmbed(guild: Guild): Promise<void> {
  const channel = await findIntroChannel(guild);
  if (!channel) {
    console.warn(
      `${guild.name} için yazılabilir tanıtım kanalı yok, geçiyorum`,
    );
    return;
  }

  const prefix = getGuildPrefix(guild.id) || DEFAULT_PREFIX;
  const me = guild.members.me;
  const botAvatar = me?.displayAvatarURL({ size: 256 }) ?? undefined;

  const embed = brandBanner(
    new V2CardBuilder()
      .setColor(COLORS.brand)
      .setAuthor({
        name: BOT_NAME,
        iconURL: botAvatar,
      })
      .setTitle(`${EMOJIS.welcomeBack} Merhaba! Ben ${BOT_NAME}`)
      .setDescription(
        [
          `Beni **${guild.name}** sunucusuna eklediğin için teşekkürler 💗`,
          "",
          `Bu sunucudaki prefix şu an: \`${prefix}\``,
          `Komutları keşfetmek için \`${prefix}help\` yazman yeterli.`,
          "",
          "Aşağıda en çok kullanılan özelliklerden bazıları var — hepsi `help` menüsünde.",
        ].join("\n"),
      )
      .addFields(
        {
          name: `${EMOJIS.fun} Eğlence & AI`,
          value: [
            `\`${prefix}sor\` — AI'ya soru sor`,
            `\`${prefix}özet\` / \`${prefix}özetle\` — metin özetle`,
            `\`${prefix}kod\` — kod yaz / analiz / düzelt`,
            `\`${prefix}avatar\` — profil fotoğrafı`,
            `\`${prefix}afk\` — AFK durumu`,
          ].join("\n"),
          inline: true,
        },
        {
          name: `${EMOJIS.mod} Moderasyon`,
          value: [
            `\`${prefix}ban\` / \`${prefix}kick\``,
            `\`${prefix}timeout\` / \`${prefix}warn\``,
            `\`${prefix}clear\` — mesaj temizle`,
            `\`${prefix}otomod\` — otomatik moderasyon`,
            `\`${prefix}guard\` — sunucu koruma`,
          ].join("\n"),
          inline: true,
        },
        {
          name: `${EMOJIS.suite} Faydalı`,
          value: [
            `\`${prefix}help\` — tüm komutlar`,
            `\`${prefix}prefix\` — prefix değiştir`,
            `\`${prefix}tekrarhoşgeldin\` — sessiz kalanları karşıla`,
            "`/rol` — slash ile rol yönetimi",
            "Daha fazlası `help` menüsünde!",
          ].join("\n"),
          inline: false,
        },
      )
      .setFooter({
        text: `${BOT_NAME} • Prefix: ${prefix} • Slash komutlar için / yaz`,
      })
      .setTimestamp(),
  );

  if (botAvatar) embed.setThumbnail(botAvatar);

  await channel.send(v2Payload({ components: [embed] }));
}

/** Sistem kanalı varsa onu, yoksa botun yazabildiği ilk metin kanalını dener. */
async function findIntroChannel(guild: Guild): Promise<TextChannel | null> {
  const me = guild.members.me;
  if (!me) return null;

  const canSend = (ch: TextChannel) =>
    ch
      .permissionsFor(me)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) === true;

  if (guild.systemChannel && guild.systemChannel.isTextBased()) {
    const sys = guild.systemChannel as TextChannel;
    if (canSend(sys)) return sys;
  }

  const textChannels = guild.channels.cache
    .filter(
      (ch) =>
        ch.type === ChannelType.GuildText && canSend(ch as TextChannel),
    )
    .sort((a, b) => (a as TextChannel).position - (b as TextChannel).position);

  const first = textChannels.first();
  return first ? (first as TextChannel) : null;
}
