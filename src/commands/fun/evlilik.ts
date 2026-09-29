import { resolveEmojis, textCard } from "../../utils/componentsV2.js";
import { MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Message,
  type User,
} from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { getMarriage, setMarriage, clearMarriage } from "../../marriage/store.js";
import { addSlash } from "../../utils/slashBridge.js";

const PROPOSE_TIMEOUT_MS = 60_000;

function pairKey(a: string, b: string): string {
  return `evlilik:${[a, b].sort().join(":")}:${Date.now()}`;
}

async function runPropose(message: Message, proposer: User, target: User): Promise<unknown> {
  if (target.bot) {
    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [errorEmbed("Olmaz", "Botla evlenemezsin, kusura bakma 🤖")] });
  }
  if (target.id === proposer.id) {
    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [errorEmbed("Olmaz", "Kendinle evlenemezsin. Gerçi... kimse karışamaz 😅")] });
  }
  const [myMarriage, theirMarriage] = await Promise.all([
    getMarriage(proposer.id).catch(() => null),
    getMarriage(target.id).catch(() => null),
  ]);
  if (myMarriage) {
    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [errorEmbed("Olmaz", "Zaten evlisin! Önce boşanman lazım 💔")] });
  }
  if (theirMarriage) {
    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [errorEmbed("Olmaz", `${target} zaten evli. Başkasına bak 😏`)] });
  }

  const key = pairKey(proposer.id, target.id);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${key}:evet`).setLabel(resolveEmojis("Evet 💍")).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${key}:hayir`).setLabel(resolveEmojis("Hayır")).setStyle(ButtonStyle.Danger),
  );

  const proposal = await message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: [...textCard(`${target}, ${proposer} sana evlenme teklif ediyor! 💍 (60 saniyen var)`), row],
  });

  const collector = proposal.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PROPOSE_TIMEOUT_MS,
  });

  collector.on("collect", (interaction) => {
    void (async () => {
      if (interaction.user.id !== target.id) {
        await interaction.reply({ flags: MessageFlags.IsComponentsV2,
        components: textCard("Bu teklif sana değil 😏"), ephemeral: true }).catch(() => null);
        return;
      }
      const accepted = interaction.customId.endsWith(":evet");
      collector.stop(accepted ? "accepted" : "rejected");
      await interaction.deferUpdate().catch(() => null);

      if (!accepted) {
        await proposal.edit({
          flags: MessageFlags.IsComponentsV2,
          components: textCard(`${target} teklifi reddetti. ${proposer}, sağlık olsun 💔`),
        }).catch(() => null);
        return;
      }

      // Kabul anında tekrar kontrol (arada biri evlenmiş olabilir).
      const [mineNow, theirsNow] = await Promise.all([
        getMarriage(proposer.id).catch(() => null),
        getMarriage(target.id).catch(() => null),
      ]);
      if (mineNow || theirsNow) {
        await proposal.edit({
          flags: MessageFlags.IsComponentsV2,
          components: textCard("O sırada biriniz evlenmiş... teklif geçersiz 😅"),
        }).catch(() => null);
        return;
      }

      await setMarriage(proposer.id, target.id).catch(() => null);
      await proposal.edit({
        flags: MessageFlags.IsComponentsV2,
        components: textCard(`🎉 ${proposer} ve ${target} evlendi! Mutluluklar! 💍🥂`),
      }).catch(() => null);
    })().catch(() => null);
  });

  collector.on("end", (_collected, reason) => {
    if (reason === "accepted" || reason === "rejected") return;
    void proposal.edit({
      flags: MessageFlags.IsComponentsV2,
      components: textCard(`${target} cevap vermedi, teklif zaman aşımına uğradı ⏳`),
    }).catch(() => null);
  });

  return null;
}

async function runDivorce(message: Message): Promise<unknown> {
  const marriage = await getMarriage(message.author.id).catch(() => null);
  if (!marriage) {
    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [errorEmbed("Bekarsın", "Evli değilsin ki boşanasın 😅")] });
  }

  const key = `bosanma:${message.author.id}:${Date.now()}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${key}:evet`).setLabel(resolveEmojis("Evet, boşan")).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${key}:vazgec`).setLabel(resolveEmojis("Vazgeç")).setStyle(ButtonStyle.Secondary),
  );

  const q = await message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: [...textCard(`Emin misin ${message.author}? <@${marriage.partnerId}> ile boşanacaksın. (60 saniye)`), row],
  });

  const collector = q.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PROPOSE_TIMEOUT_MS,
  });

  collector.on("collect", (interaction) => {
    void (async () => {
      if (interaction.user.id !== message.author.id) {
        await interaction.reply({ flags: MessageFlags.IsComponentsV2,
        components: textCard("Bu karar sana ait değil 😏"), ephemeral: true }).catch(() => null);
        return;
      }
      const confirm = interaction.customId.endsWith(":evet");
      collector.stop();
      await interaction.deferUpdate().catch(() => null);
      if (!confirm) {
        await q.edit({ flags: MessageFlags.IsComponentsV2,
        components: textCard("Vazgeçtin, evlilik devam ediyor 💕") }).catch(() => null);
        return;
      }
      await clearMarriage(message.author.id, marriage.partnerId).catch(() => null);
      await q.edit({ flags: MessageFlags.IsComponentsV2,
      components: textCard(`💔 ${message.author} boşandı. Her şey gönlünce olsun.`) }).catch(() => null);
    })().catch(() => null);
  });

  collector.on("end", (_c, reason) => {
    if (reason !== "time") return;
    void q.edit({ flags: MessageFlags.IsComponentsV2,
    components: textCard("Süre doldu, bir şey değişmedi.") }).catch(() => null);
  });

  return null;
}

function formatDuration(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 365) return `${Math.floor(days / 365)} yıl ${days % 365} gün`;
  if (days >= 30) return `${Math.floor(days / 30)} ay ${days % 30} gün`;
  if (days >= 1) return `${days} gün`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} saat`;
  return "1 saatten az";
}

async function runSpouse(message: Message, who: User): Promise<unknown> {
  const marriage = await getMarriage(who.id).catch(() => null);
  if (!marriage) {
    const self = who.id === message.author.id;
    return message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed("💔 Medeni Hal", self ? "Bekarsın. `!evlen` ile bu duruma son verebilirsin 😉" : `${who} bekar.`)] ,
    });
  }
  const dur = formatDuration(Date.now() - marriage.marriedAt);
  const date = new Date(marriage.marriedAt).toLocaleDateString("tr-TR");
  return message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: [
      infoEmbed(
        "💍 Evli",
        `${who} ❤️ <@${marriage.partnerId}>\n\n📅 Evlilik tarihi: **${date}**\n⏳ Birliktelik: **${dur}**`,
      ),
    ],
  });
}

export const evlen: Command = {
  name: "evlen",
  aliases: ["evlilik-teklifi", "marry"],
  description: "Birine evlenme teklif eder",
  usage: "!evlen <@kullanıcı>",
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Hata", "Bu komut sadece sunucuda çalışır.")] });
    }
    const target = message.mentions.users.first();
    if (!target) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Hatalı Kullanım", `Kime teklif edeceksin? Kullanım: \`${evlen.usage}\``)] });
    }
    void args;
    return runPropose(message, message.author, target);
  },
};

export const bosan: Command = {
  name: "boşan",
  aliases: ["bosan", "divorce"],
  description: "Eşinden boşanır (onay ister)",
  usage: "!boşan",
  category: "fun",

  async execute(message: Message) {
    if (!message.guild) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Hata", "Bu komut sadece sunucuda çalışır.")] });
    }
    return runDivorce(message);
  },
};

export const es: Command = {
  name: "eş",
  aliases: ["es", "spouse", "evlilik"],
  description: "Evlilik durumunu gösterir",
  usage: "!eş [@kullanıcı]",
  category: "fun",

  async execute(message: Message) {
    const who = message.mentions.users.first() ?? message.author;
    return runSpouse(message, who);
  },
};

addSlash(
  evlen,
  [{ name: "kullanici", description: "Evlenme teklif edilecek kişi", type: "user", required: true }],
  (v) => [v.userMention("kullanici") ?? ""],
);
addSlash(bosan, []);
addSlash(
  es,
  [{ name: "kullanici", description: "Durumu görülecek kişi", type: "user", required: false }],
  (v) => (v.userMention("kullanici") ? [v.userMention("kullanici") as string] : []),
);
