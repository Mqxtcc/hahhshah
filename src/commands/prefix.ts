import { errorCard, textCard } from "../utils/componentsV2.js";
import { MessageFlags,
  SlashCommandBuilder,
  type ContainerBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../types.js";
import { DEFAULT_PREFIX, OWNER_ID } from "../config.js";
import { EMOJIS } from "../utils/emojis.js";
import {
  getGuildPrefix,
  setGuildPrefix,
  resetGuildPrefix,
  requireOwnerOrGuildOwner,
} from "../events/messageCreate.js";
import { MSG, usageEmbed } from "../utils/messages.js";

// Kötüye kullanımı önlemek için: boşluksuz, makul uzunlukta, mention/kod
// bloğu gibi Discord'u karıştıracak karakterler içermeyen bir prefix.
const PREFIX_REGEX = /^[^\sA-Za-z0-9@#:`]{1,5}$|^[!.+?$%^&*\-_=~]{1,5}$/;

async function handlePrefixChange(
  guildId: string,
  userId: string,
  isGuildOwner: boolean,
  arg: string | undefined,
  reply: (payload: string | { components: ContainerBuilder[]; flags: MessageFlags.IsComponentsV2 }) => Promise<unknown>,
): Promise<void> {
  if (userId !== OWNER_ID && !isGuildOwner) {
    await reply(
      MSG.error("Bu komutu sadece sunucu sahibi kullanabilir."),
    );
    return;
  }

  const currentPrefix = getGuildPrefix(guildId);
  const firstArg = arg?.toLocaleLowerCase("tr-TR");

  if (!firstArg) {
    await reply(
      `${EMOJIS.info} Bu sunucudaki şu anki prefix: \`${currentPrefix}\`\n` +
        `Değiştirmek için: \`${currentPrefix}prefix <yeni-prefix>\` (ör. \`${currentPrefix}prefix +\`)\n` +
        `Varsayılana (\`${DEFAULT_PREFIX}\`) döndürmek için: \`${currentPrefix}prefix sıfırla\``,
    );
    return;
  }

  if (firstArg === "sıfırla" || firstArg === "reset") {
    if (currentPrefix === DEFAULT_PREFIX) {
      await reply(
        `${EMOJIS.info} Bu sunucu zaten varsayılan prefix'i (\`${DEFAULT_PREFIX}\`) kullanıyor.`,
      );
      return;
    }
    await resetGuildPrefix(guildId);
    await reply(
      `${EMOJIS.success} Prefix varsayılana döndürüldü: \`${currentPrefix}\` ${EMOJIS.next} \`${DEFAULT_PREFIX}\`\n` +
        `Artık bu sunucuda komutlar \`${DEFAULT_PREFIX}\` ile başlamalı (ör. \`${DEFAULT_PREFIX}ping\`).`,
    );
    return;
  }

  const newPrefix = arg!;

  if (newPrefix.length > 5 || !PREFIX_REGEX.test(newPrefix)) {
    await reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        usageEmbed(
          `${EMOJIS.usage} Kullanım: \`${currentPrefix}prefix <yeni-prefix>\` (ör. \`${currentPrefix}prefix +\`)`,
        ),
      ],
    });
    return;
  }

  if (newPrefix === currentPrefix) {
    await reply(
      `${EMOJIS.info} Bu sunucunun prefix'i zaten \`${currentPrefix}\`.`,
    );
    return;
  }

  await setGuildPrefix(guildId, newPrefix);

  await reply(
    `${EMOJIS.success} Bu sunucunun prefix'i güncellendi: \`${currentPrefix}\` ${EMOJIS.next} \`${newPrefix}\`\n` +
      `Artık bu sunucuda komutlar \`${newPrefix}\` ile başlamalı (ör. \`${newPrefix}ping\`). Bu ayar sadece bu sunucuyu etkiler, diğer sunucular kendi prefix'lerini korur.`,
  );
}

const command: Command = {
  name: "prefix",
  description:
    "Bu sunucuya özel komut prefix'ini değiştirir (sadece sunucu sahibi/taç sahibi)",
  usage: "!prefix <yeni-prefix | sıfırla>",
  category: "genel",

  slashData: new SlashCommandBuilder()
    .setName("prefix")
    .setDescription("Bu sunucuya özel komut prefix'ini gösterir veya değiştirir")
    .addStringOption((opt) =>
      opt
        .setName("yeni")
        .setDescription("Yeni prefix veya 'sıfırla'")
        .setRequired(false),
    ),

  async execute(message: Message, args: string[]) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bir sunucu içinde kullanılabilir.` })] });
    }
    // Yetki mesajı requireOwnerOrGuildOwner içinde gönderiliyor; handle'a
    // girmeden önce kontrol ediyoruz ki çift cevap olmasın.
    if (!(await requireOwnerOrGuildOwner(message))) return;

    await handlePrefixChange(
      message.guild.id,
      message.author.id,
      message.guild.ownerId === message.author.id,
      args[0],
      (payload) =>
        typeof payload === "string"
          ? message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(payload) })
          : message.reply({ ...payload }),
    );
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bir sunucu içinde kullanılabilir.` })],
        ephemeral: true,
      });
      return;
    }

    await handlePrefixChange(
      interaction.guild.id,
      interaction.user.id,
      interaction.guild.ownerId === interaction.user.id,
      interaction.options.getString("yeni") ?? undefined,
      (payload) =>
        typeof payload === "string"
          ? interaction.reply({
      flags: MessageFlags.IsComponentsV2, components: textCard(payload), ephemeral: false })
          : interaction.reply({ ...payload, ephemeral: false }),
    );
  },
};

export default command;
