import { resolveEmojis, COMPONENTS_V2_FLAG, V2CardBuilder } from "../utils/componentsV2.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";
import { COLORS } from "../utils/embeds.js";
import { getGuildWelcomeConfig } from "./store.js";
import { EMOJIS } from "../utils/emojis.js";

// ---------------------------------------------------------------------------
// !hosgeldin komutunun interaktif paneli. Eskiden bu sistem 10'dan fazla alt
// komutla yönetiliyordu (ayarla/kanal/mesaj/görüşürüz/aç/kapat/test/kaldır/
// ayarlar) — artık tek bir panel üzerinden butonlarla yönetiliyor. Metin
// komutları geriye dönük uyumluluk için hâlâ çalışıyor (bkz.
// commands/mod/hosgeldin.ts), ama varsayılan görünüm bu panel.
//
// Buton/menü işleyicileri events/interactionCreate.ts içinde, "welcome_panel_"
// önekiyle. Tüm aksiyonlar ManageGuild yetkisi (veya bot sahibi) gerektirir.
// ---------------------------------------------------------------------------

export const WELCOME_PLACEHOLDER_HELP =
  "`{n}` üye sayısı • `{kullanici}` etiket • `{isim}` kullanıcı adı • `{sunucu}` sunucu adı";

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function buildWelcomePanelView(guildId: string) {
  const cfg = await getGuildWelcomeConfig(guildId);

  const embed = new V2CardBuilder()
    .setColor(cfg.enabled ? COLORS.success : COLORS.info)
    .setTitle("👋 Hoşgeldin & Görüşürüz Sistemi")
    .setDescription(
      [
        `**Durum**\n${cfg.enabled ? `${EMOJIS.success} Aktif` : `${EMOJIS.error} Kapalı`}`,
        `**Kanal**\n${cfg.channelId ? `<#${cfg.channelId}>` : "*ayarlanmamış*"}`,
      ].join("\n\n"),
    )
    .addFields(
      {
        name: "📝 Giriş Mesajı",
        value: cfg.message ? `\`\`\`\n${truncate(cfg.message)}\n\`\`\`` : "*ayarlanmamış*",
      },
      {
        name: "🖼️ Giriş Görseli",
        value: cfg.welcomeImage ? truncate(cfg.welcomeImage, 100) : "*ayarlanmamış*",
        inline: true,
      },
      {
        name: "📝 Çıkış Mesajı",
        value: cfg.leaveMessage ? `\`\`\`\n${truncate(cfg.leaveMessage)}\n\`\`\`` : "*ayarlanmamış (gönderilmiyor)*",
      },
      {
        name: "🖼️ Çıkış Görseli",
        value: cfg.leaveImage ? truncate(cfg.leaveImage, 100) : "*ayarlanmamış*",
        inline: true,
      },
    )
    .setFooter({ text: `${WELCOME_PLACEHOLDER_HELP} • Sadece Sunucuyu Yönet yetkisine sahip kişiler kullanabilir` })
    .setTimestamp();

  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("welcome_panel_channel")
      .setPlaceholder(resolveEmojis("Giriş/çıkış kanalını seç ya da değiştir…"))
      .addChannelTypes(ChannelType.GuildText),
  );

  const msgRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("welcome_panel_msg_welcome").setLabel(resolveEmojis("Giriş Mesajı")).setEmoji("📝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("welcome_panel_msg_leave").setLabel(resolveEmojis("Çıkış Mesajı")).setEmoji("📝").setStyle(ButtonStyle.Primary),
  );

  const imgRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("welcome_panel_img_welcome").setLabel(resolveEmojis("Giriş Görseli")).setEmoji("🖼️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("welcome_panel_img_leave").setLabel(resolveEmojis("Çıkış Görseli")).setEmoji("🖼️").setStyle(ButtonStyle.Secondary),
  );

  const resetRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("welcome_panel_reset_welcome").setLabel(resolveEmojis("Girişi Sıfırla")).setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("welcome_panel_reset_leave").setLabel(resolveEmojis("Çıkışı Sıfırla")).setEmoji("🔄").setStyle(ButtonStyle.Secondary),
  );

  const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    cfg.enabled
      ? new ButtonBuilder().setCustomId("welcome_panel_toggle").setLabel(resolveEmojis("Sistemi Kapat")).setEmoji("⛔").setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId("welcome_panel_toggle").setLabel(resolveEmojis("Sistemi Aç")).setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("welcome_panel_refresh").setLabel(resolveEmojis("Yenile")).setEmoji("🔁").setStyle(ButtonStyle.Secondary),
  );

  return {
    flags: COMPONENTS_V2_FLAG,
    components: [embed, channelRow, msgRow, imgRow, resetRow, controlRow],
  };
}
