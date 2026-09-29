import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, ChannelType, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { EMOJIS } from "../../utils/emojis.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { OWNER_ID } from "../../config.js";
import {
  getGuildWelcomeConfig,
  updateGuildWelcomeConfig,
} from "../../welcome/store.js";
import { buildWelcomePanelView } from "../../welcome/panel.js";
import { renderWelcomeMessage, isTemplateTooLong, MAX_TEMPLATE_LENGTH } from "../../welcome/render.js";
import { extractRawRest } from "../../utils/parse.js";
import { registerPanelOwner } from "../../events/panelOwners.js";
import { addSlash } from "../../utils/slashBridge.js";

const PLACEHOLDER_HELP =
  "`{n}` üye sayısı • `{kullanici}` etiket • `{isim}` kullanıcı adı • `{sunucu}` sunucu adı";

// `!hosgeldin ayarla #kanal `<hoşgeldin mesajı>` `<görüşürüz mesajı>`` biçimini
// destekler: art arda gelen, backtick (`) ya da kod bloğu (```) ile sarılmış
// iki ayrı segment arar. Segmentler arasında/dışında sadece boşluk varsa iki
// ayrı mesaj olarak kabul edilir; format uymuyorsa (ör. eski tek-mesaj kullanımı,
// ya da mesajın içinde rastgele backtick geçmesi) null döner ve çağıran taraf
// tüm metni tek (hoşgeldin) mesajı olarak ele almaya devam eder — böylece eski
// kullanım biçimi bozulmaz.
function parseTwoFencedSegments(rest: string): { first: string; second: string } | null {
  const segments: string[] = [];
  let i = 0;
  const n = rest.length;

  while (segments.length < 2 && i < n) {
    while (i < n && /\s/.test(rest[i])) i++;
    if (i >= n || rest[i] !== "`") break;

    const fenceLen = rest.slice(i, i + 3) === "```" ? 3 : 1;
    const fence = "`".repeat(fenceLen);
    const contentStart = i + fenceLen;
    const closeIdx = rest.indexOf(fence, contentStart);
    if (closeIdx === -1) break;

    segments.push(rest.slice(contentStart, closeIdx).trim());
    i = closeIdx + fenceLen;
  }

  if (segments.length !== 2) return null;
  if (rest.slice(i).trim().length > 0) return null; // segmentlerden sonra fazladan metin varsa güvenilir değil
  if (!segments[0] || !segments[1]) return null;
  return { first: segments[0], second: segments[1] };
}

function usage() {
  return new V2CardBuilder()
    .setColor(0xd0a840)
    .setTitle(`${EMOJIS.usage} Kullanım`)
    .setDescription(
      [
        `**\`!hosgeldin\`** — interaktif paneli açar (kanal seç, mesaj/görsel butonları, aç-kapat). Çoğu şey için sadece bunu kullanman yeterli.`,
        "",
        "Aşağıdakiler panel yerine metinle/otomasyonla ayarlamak isteyenler için hâlâ çalışır:",
        "`!hosgeldin ayarla #kanal <mesaj>` — kanalı ve hoşgeldin mesajını tek seferde ayarlar, sistemi açar",
        "`!hosgeldin ayarla #kanal `<hoşgeldin mesajı>` `<görüşürüz mesajı>`` — aynı anda hem hoşgeldin hem görüşürüz mesajını ayarlar (her ikisi de backtick ` veya kod bloğu ``` içinde olmalı)",
        "`!hosgeldin kanal #kanal` — sadece kanalı değiştirir",
        "`!hosgeldin mesaj <mesaj>` — sadece hoşgeldin mesaj şablonunu değiştirir",
        "`!hosgeldin görüşürüz <mesaj>` — sadece ayrılış (görüşürüz) mesaj şablonunu değiştirir",
        "`!hosgeldin görüşürüz kaldır` — sadece görüşürüz mesajını kapatır (hoşgeldin sistemi etkilenmez)",
        "`!hosgeldin aç` / `!hosgeldin kapat` — sistemi aç/kapat (ayarlar korunur)",
        "`!hosgeldin test` — şu anki hoşgeldin (ve varsa görüşürüz) mesajının nasıl göründüğünü bu kanalda gösterir",
        "`!hosgeldin kaldır` — tüm ayarları sıfırlar",
        "`!hosgeldin ayarlar` — mevcut durumu gösterir",
        "",
        `Placeholder'lar: ${PLACEHOLDER_HELP}`,
        "",
        "Mesajı \\`\\`\\` kod bloğu içine yazabilirsin, birden fazla satır olabilir.",
        `Mesaj uzunluğu en fazla ${MAX_TEMPLATE_LENGTH} karakter olabilir.`,
      ].join("\n"),
    );
}

const command: Command = {
  name: "hosgeldin",
  aliases: ["welcome", "karsilama"],
  description: "Yeni üyelere otomatik hoşgeldin/görüşürüz mesajı sistemini yönetir (interaktif panel)",
  usage: "!hosgeldin — paneli açar",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;
    if (message.author.id !== OWNER_ID && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Bu komutu kullanmak için **Sunucuyu Yönet** yetkisine ihtiyacın var.` })] });
    }

    const guildId = message.guild.id;
    const prefix = getGuildPrefix(guildId);
    const sub = (args[0] ?? "").toLowerCase();

    switch (sub) {
      case "":
      case "panel":
      case "ayarlar":
      case "durum": {
        const panel = await buildWelcomePanelView(guildId);
        const sent = await message.reply({ ...panel, flags: COMPONENTS_V2_FLAG, components: [...((panel as any).embeds ?? []), ...((panel as any).components ?? [])] } as any);
        if (sent) registerPanelOwner(sent, message.author.id);
        return sent;
      }

      case "ayarla": {
        const channel = message.mentions.channels.first();
        if (!channel || channel.type !== ChannelType.GuildText) {
          return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usage()] });
        }
        const rawRest = extractRawRest(message.content, 3, prefix); // hosgeldin ayarla #kanal
        if (!rawRest) {
          return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Bir mesaj metni girmelisin.\n${PLACEHOLDER_HELP}` })] });
        }

        // İki backtick/kod-bloğu segmenti bulunursa: birincisi hoşgeldin,
        // ikincisi görüşürüz mesajıdır. Bulunamazsa (eski kullanım) tüm metin
        // AYNEN hoşgeldin mesajı olarak kaydedilir — görüşürüz mesajı önceki
        // haliyle korunur (üzerine yazılmaz).
        const parsed = parseTwoFencedSegments(rawRest);
        const welcomeTemplate = parsed ? parsed.first : rawRest;
        const leaveTemplate = parsed ? parsed.second : undefined;

        if (isTemplateTooLong(welcomeTemplate) || (leaveTemplate && isTemplateTooLong(leaveTemplate))) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Mesaj çok uzun. En fazla ${MAX_TEMPLATE_LENGTH} karakter olabilir.` })] });
        }

        await updateGuildWelcomeConfig(guildId, {
          channelId: channel.id,
          message: welcomeTemplate,
          ...(leaveTemplate !== undefined ? { leaveMessage: leaveTemplate } : {}),
          enabled: true,
        });
        const leaveNote = leaveTemplate ? " Görüşürüz mesajı da ayarlandı." : "";
        return message.reply(
          { flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Hoşgeldin sistemi ${channel} kanalına ayarlandı ve açıldı.${leaveNote}\nÖnizleme için \`${prefix}hosgeldin test\` yazabilirsin.`,) });
      }

      case "kanal": {
        const channel = message.mentions.channels.first();
        if (!channel || channel.type !== ChannelType.GuildText) {
          return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usage()] });
        }
        await updateGuildWelcomeConfig(guildId, { channelId: channel.id });
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Hoşgeldin kanalı ${channel} olarak güncellendi.`) });
      }

      case "mesaj": {
        const template = extractRawRest(message.content, 2, prefix); // hosgeldin mesaj
        if (!template) {
          return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usage()] });
        }
        if (isTemplateTooLong(template)) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Mesaj çok uzun. En fazla ${MAX_TEMPLATE_LENGTH} karakter olabilir.` })] });
        }
        await updateGuildWelcomeConfig(guildId, { message: template });
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Hoşgeldin mesajı güncellendi.\nÖnizleme için \`${prefix}hosgeldin test\` yazabilirsin.`) });
      }

      case "görüşürüz":
      case "gorusuruz":
      case "ayril":
      case "leave": {
        const sub2 = (args[1] ?? "").toLowerCase();
        if (sub2 === "kaldır" || sub2 === "kaldir" || sub2 === "sifirla" || sub2 === "reset") {
          await updateGuildWelcomeConfig(guildId, { leaveMessage: null });
          return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Görüşürüz mesajı kaldırıldı.`) });
        }
        const template = extractRawRest(message.content, 2, prefix); // hosgeldin görüşürüz
        if (!template) {
          return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usage()] });
        }
        if (isTemplateTooLong(template)) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Mesaj çok uzun. En fazla ${MAX_TEMPLATE_LENGTH} karakter olabilir.` })] });
        }
        await updateGuildWelcomeConfig(guildId, { leaveMessage: template });
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Görüşürüz mesajı güncellendi.\nÖnizleme için \`${prefix}hosgeldin test\` yazabilirsin.`) });
      }

      case "aç": {
        const cfg = await getGuildWelcomeConfig(guildId);
        if (!cfg.channelId || !cfg.message) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Önce bir kanal ve mesaj ayarlamalısın: \`${prefix}hosgeldin ayarla #kanal <mesaj>\`` })] });
        }
        await updateGuildWelcomeConfig(guildId, { enabled: true });
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Hoşgeldin sistemi açıldı.`) });
      }

      case "kapat": {
        await updateGuildWelcomeConfig(guildId, { enabled: false });
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.alert} Hoşgeldin sistemi kapatıldı.` })] });
      }

      case "kaldır":
      case "sifirla":
      case "reset": {
        await updateGuildWelcomeConfig(guildId, {
          enabled: false,
          channelId: null,
          message: null,
          leaveMessage: null,
          welcomeImage: null,
          leaveImage: null,
        });
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${EMOJIS.success} Hoşgeldin ayarları sıfırlandı.`) });
      }

      case "test": {
        const cfg = await getGuildWelcomeConfig(guildId);
        if (!cfg.message) {
          return message.reply(
            { flags: COMPONENTS_V2_FLAG, components: [errorCard({ description: `${EMOJIS.error} Henüz bir mesaj ayarlanmamış: \`${prefix}hosgeldin ayarla #kanal <mesaj>\`` })] });
        }
        const welcomePreview = renderWelcomeMessage(cfg.message, message.member);
        const parts = [
          `${EMOJIS.info} **Hoşgeldin önizlemesi:**\n${welcomePreview}${cfg.welcomeImage ? `\n${cfg.welcomeImage}` : ""}`,
        ];
        if (cfg.leaveMessage) {
          const leavePreview = renderWelcomeMessage(cfg.leaveMessage, message.member);
          parts.push(`${EMOJIS.info} **Görüşürüz önizlemesi:**\n${leavePreview}${cfg.leaveImage ? `\n${cfg.leaveImage}` : ""}`);
        }
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(parts.join("\n\n")) });
      }

      default:
        return message.reply({ flags: COMPONENTS_V2_FLAG, components: [usage()] });
    }
  },
};


addSlash(command, [
  { name: "islem", description: "Yapılacak işlem", type: "string", required: true, choices: [{ name: "Panel", value: "panel" }, { name: "Kanal + mesaj ayarla", value: "ayarla" }, { name: "Sadece kanal ayarla", value: "kanal" }, { name: "Karşılama mesajını değiştir", value: "mesaj" }, { name: "Görüşürüz mesajını değiştir", value: "gorusuruz" }, { name: "Test et", value: "test" }] },
  { name: "kanal", description: "Hoşgeldin kanalı", type: "channel" },
  { name: "metin", description: "Mesaj metni (değişkenler desteklenir)", type: "string" },
],
  (v) => {
    const islem = v.str("islem") ?? "panel";
    if (islem === "ayarla") return ["ayarla", v.channelMention("kanal") ?? "", v.str("metin") ?? ""].filter(Boolean);
    if (islem === "kanal") { const k = v.channelMention("kanal"); return k ? ["kanal", k] : ["kanal"]; }
    if (islem === "mesaj") return ["mesaj", v.str("metin") ?? ""].filter(Boolean);
    if (islem === "gorusuruz") return ["görüşürüz", v.str("metin") ?? ""].filter(Boolean);
    return [islem];
  }
);
export default command;
