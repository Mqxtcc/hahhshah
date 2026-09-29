import { resolveEmojis, COMPONENTS_V2_FLAG, V2CardBuilder } from "../utils/componentsV2.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, RoleSelectMenuBuilder, type Guild, type Client } from "discord.js";
import { getGuildPrefix, vipUsers } from "./messageCreate.js";
import { getAllLogChannels, getLogChannelId, LOG_CATEGORIES } from "../utils/logger.js";
import { getAllChannelSettings, CHANNEL_SETTINGS } from "../utils/channelSettings.js";
import { EMOJIS } from "../utils/emojis.js";

// ---------------------------------------------------------------------------
// ÖLÜ KOD NOTU: Bu dosya kaldırılan !panel komutunun sekme görünümleriydi.
// Web dashboard bu işi devraldığı için komut silindi; dosya + interactionCreate.ts
// içindeki panel_* handler'ları artık tetiklenemiyor. Güvenli silme için
// interactionCreate.ts'teki ilgili bloklarla birlikte kaldırılmalı.
// ---------------------------------------------------------------------------

export type PanelTab = "genel" | "mod" | "uyeler" | "info" | "bulksilme";

function tabRow(active: PanelTab): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_tab_genel")
      .setLabel(resolveEmojis("Genel"))
      .setEmoji("⚙️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(active === "genel"),
    new ButtonBuilder()
      .setCustomId("panel_tab_mod")
      .setLabel(resolveEmojis("Moderasyon"))
      .setEmoji("🔨")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(active === "mod"),
    new ButtonBuilder()
      .setCustomId("panel_tab_uyeler")
      .setLabel(resolveEmojis("Üyeler"))
      .setEmoji("👥")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(active === "uyeler"),
    new ButtonBuilder()
      .setCustomId("panel_tab_info")
      .setLabel(resolveEmojis("Durum"))
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(active === "info"),
  );
}

// ---------------------------------------------------------------------------
// ⚙️ Genel
// ---------------------------------------------------------------------------
export function buildGenelTab(guildId?: string | null) {
  const prefix = getGuildPrefix(guildId);
  const embed = new V2CardBuilder()
    .setColor(0xd0a840)
    .setTitle("🎛️ Bot Kontrol Merkezi")
    .setDescription("Sunucu yönetim araçlarına hızlı erişim. Aşağıdaki sekmelerden bir alan seç.")
    .addFields(
      { name: "⚙️ Sunucu Ayarı", value: `Prefix: \`${prefix}\`\nÇalışma süresi: **${formatUptime(process.uptime())}**`, inline: true },
      { name: "✨ Özel Üyeler", value: `Kayıtlı özel üye: **${vipUsers.size}**`, inline: true },
      { name: "💡 Hızlı Bilgi", value: `Detaylar için \`${prefix}istatistik\` ve \`${prefix}uptime\` komutlarını kullanabilirsin.`, inline: false },
    )
    .setFooter({ text: "Discord v14 Yönetim Paneli • Bir sekme seçerek devam et" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_duyuru_open")
      .setLabel(resolveEmojis("Duyuru Gönder"))
      .setEmoji("📢")
      .setStyle(ButtonStyle.Primary),
  );

  return { flags: COMPONENTS_V2_FLAG, components: [embed, tabRow("genel"), row] };
}

// ---------------------------------------------------------------------------
// 🔨 Moderasyon
// ---------------------------------------------------------------------------
export function buildModTab() {
  const embed = new V2CardBuilder()
    .setColor(0xed4245)
    .setTitle("🔨 Moderasyon Merkezi")
    .setDescription("Üye işlemlerini butonlara dokunarak açılan güvenli formlarla yönet.")
    .addFields(
      { name: `${EMOJIS.alert} Cezalandırma`, value: `${EMOJIS.ban} Ban\n${EMOJIS.kick} Kick\n${EMOJIS.timeout} Mute / Unmute`, inline: true },
      { name: `${EMOJIS.admin} Kayıt & İnceleme`, value: `${EMOJIS.warn} Warn\n${EMOJIS.info} Uyarılar\n${EMOJIS.active} Unban`, inline: true },
      { name: "🗑️ Toplu İşlemler", value: "Toplu Silme; kanal ve rol seçimleriyle ayrı, onaylı bir ekranda çalışır.", inline: false },
    )
    .setFooter({ text: "Her işlem kendi Discord yetkisini kontrol eder" })
    .setTimestamp();
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_open_ban").setLabel(resolveEmojis("Ban")).setEmoji("🔨").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel_open_kick").setLabel(resolveEmojis("Kick")).setEmoji("👢").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel_open_mute").setLabel(resolveEmojis("Mute")).setEmoji("🔇").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_open_unmute").setLabel(resolveEmojis("Unmute")).setEmoji("🔊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_open_unban").setLabel(resolveEmojis("Unban")).setEmoji("♻️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_open_warn").setLabel(resolveEmojis("Warn")).setEmoji("⚠️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_open_uyarigor").setLabel(resolveEmojis("Uyarılar")).setEmoji("👁️").setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_tab_bulksilme").setLabel(resolveEmojis("Toplu Sil")).setEmoji("🗑️").setStyle(ButtonStyle.Danger),
  );
  return { flags: COMPONENTS_V2_FLAG, components: [embed, tabRow("mod"), row1, row2, row3] };
}

// ---------------------------------------------------------------------------
// 🗑️ Toplu Silme (Kanal ve Rol)
// ---------------------------------------------------------------------------
export function buildBulkSilmeTab() {
  const embed = new V2CardBuilder()
    .setColor(0xed4245)
    .setTitle("🗑️ Bot Paneli — Toplu Silme")
    .setDescription(
      [
        "Bu sekmeden seçtiğin kanalları ve/veya rolleri hızlıca silebilirsin.",
        "",
        "**Nasıl çalışır:**",
        "1️⃣ Kanalları doğrudan aşağıdan seç",
        "2️⃣ Rol filtresi yap (ör. 💎 emojisine sahip rolleri bul)",
        "3️⃣ Silme işlemini onayla",
        "",
        `${EMOJIS.alert} **UYARI:** Silinen kanallar ve roller geri getirilemez! Bu işlem Yönetici izni gerektirir.`,
      ].join("\n"),
    )
    .setFooter({ text: "Yönetici izni zorunludur." })
    .setTimestamp();

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_tab_mod")
      .setLabel(resolveEmojis("← Geri"))
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary),
  );

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId("panel_bulksilme_channels")
    .setPlaceholder(resolveEmojis("📄 Silinecek kanalları seç..."))
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory)
    .setMinValues(0)
    .setMaxValues(25);

  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect);

  const roleButtonsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_bulksilme_rolefilter")
      .setLabel(resolveEmojis("Rol Filtresi"))
      .setEmoji("🔍")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("panel_bulksilme_roledirect")
      .setLabel(resolveEmojis("Tüm Roller"))
      .setEmoji("👤")
      .setStyle(ButtonStyle.Secondary),
  );

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_bulksilme_confirm")
      .setLabel(resolveEmojis("Siliş Onayla"))
      .setEmoji("✅")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("panel_bulksilme_cancel")
      .setLabel(resolveEmojis("İptal Et"))
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );

  return { flags: COMPONENTS_V2_FLAG, components: [embed, backRow, channelRow, roleButtonsRow, confirmRow] };
}

// ---------------------------------------------------------------------------
// 👥 Üyeler (yasaklılar / özel üyeler)
// ---------------------------------------------------------------------------
export function buildUyelerTab() {
  const vipList = [...vipUsers].slice(0, 15).map((id) => `<@${id}>`);

  const embed = new V2CardBuilder()
    .setColor(0xd0a840)
    .setTitle("👥 Bot Paneli — Üyeler")
    .addFields({
      name: `✨ Özel Üyeler (${vipUsers.size})`,
      value: vipList.length
        ? vipList.join(", ") + (vipUsers.size > 15 ? `\n...+${vipUsers.size - 15} daha` : "")
        : "Şu an özel üye yok.",
    })
    .setFooter({
      text: "Özel Üye: Yönetici izni gerekir (toggle).",
    })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_open_ozelde")
      .setLabel(resolveEmojis("Özel Üye"))
      .setEmoji("✨")
      .setStyle(ButtonStyle.Primary),
  );

  return { flags: COMPONENTS_V2_FLAG, components: [embed, tabRow("uyeler"), row] };
}

// ---------------------------------------------------------------------------
// 📊 Durum
// ---------------------------------------------------------------------------
export function buildInfoTab(guild?: Guild | null, client?: Client | null) {
  const ping = client?.ws.ping;
  const memberCount = guild?.memberCount;
  const channelCount = guild?.channels.cache.size;
  const roleCount = guild?.roles.cache.size;
  const prefix = getGuildPrefix(guild?.id);

  const embed = new V2CardBuilder()
    .setColor(0x57f287)
    .setTitle("📊 Sistem Durumu")
    .setDescription("Botun bağlantı ve sunucu istatistikleri.")
    .addFields(
      { name: "🟢 Bağlantı", value: `Ping: **${ping !== undefined && ping >= 0 ? `${ping}ms` : "Bilinmiyor"}**\nUptime: **${formatUptime(process.uptime())}**`, inline: true },
      { name: "🏠 Sunucu", value: `Üye: **${memberCount ?? "?"}**\nKanal: **${channelCount ?? "?"}**\nRol: **${roleCount ?? "?"}**`, inline: true },
      { name: "💡 Kısayollar", value: `Detaylar: \`${prefix}istatistik\` · \`${prefix}uptime\``, inline: false },
    )
    .setFooter({ text: "Yenile butonu ile canlı durumu tekrar al" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_shortcut_logpanel")
      .setLabel(resolveEmojis("Log Kanalları"))
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("panel_shortcut_extrapanel")
      .setLabel(resolveEmojis("Diğer Kanallar"))
      .setEmoji("🧩")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("panel_refresh_info")
      .setLabel(resolveEmojis("Yenile"))
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );

  return { flags: COMPONENTS_V2_FLAG, components: [embed, tabRow("info"), row] };
}

// ---------------------------------------------------------------------------
// 📋 Log Kanalları — "Durum" sekmesindeki "Log Kanalları" butonuyla açılır.
// Ayrı bir ana sekme değil (tabRow zaten 5 butonla dolu), "Durum"un altında
// bir alt görünüm. Her kategori için bir kanal seçim menüsü var; menüden
// seçim temizlenirse (min 0) o kategori kapanır. Discord'un mesaj başına
// 5 action row limiti yüzünden geri butonu + 4 kategori menüsü = tam 5 satır.
// ---------------------------------------------------------------------------
export async function buildLogTab(guildId: string) {
  const settings = await getAllLogChannels(guildId);

  const embed = new V2CardBuilder()
    .setColor(0xd0a840)
    .setTitle("📋 Bot Paneli — Log Kanalları")
    .setDescription(
      LOG_CATEGORIES.map((c) => {
        const channelId = settings[c.id];
        return `${c.emoji} **${c.label}** — ${channelId ? `<#${channelId}>` : "*ayarlanmamış*"}\n↳ ${c.ornek}`;
      }).join("\n\n") +
        "\n\nAşağıdaki butonlardan bir kategori seçerek kanal atamasını yapabilirsiniz."
    )
    .setFooter({ text: "Log kanalı ayarlamak/kaldırmak Sunucuyu Yönet iznine ihtiyaç duyar." })
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_log_open_mesaj").setLabel(resolveEmojis("Mesaj")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_log_open_uyari").setLabel(resolveEmojis("Uyarı")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_log_open_giris-cikis").setLabel(resolveEmojis("Giriş-Çıkış")).setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_log_open_ses").setLabel(resolveEmojis("Ses")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_log_open_rol").setLabel(resolveEmojis("Rol")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_log_open_kanal").setLabel(resolveEmojis("Kanal")).setStyle(ButtonStyle.Primary)
  );

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_shortcut_infoback").setLabel(resolveEmojis("Geri")).setEmoji("◀️").setStyle(ButtonStyle.Secondary)
  );

  return { flags: COMPONENTS_V2_FLAG, components: [embed, row1, row2, backRow] };
}

export async function buildLogCategoryTab(guildId: string, categoryId: string) {
  const category = LOG_CATEGORIES.find(c => c.id === categoryId)!;
  const channelId = await getLogChannelId(guildId, categoryId as any);

  const embed = new V2CardBuilder()
    .setColor(0xd0a840)
    .setTitle(`${category.emoji} ${category.label} Ayarı`)
    .setDescription(`Seçili kanal: ${channelId ? `<#${channelId}>` : "*Yok*"}\n\nAşağıdaki menüden bu log kategorisi için bir kanal seçin. İptal etmek için seçimi temizleyin.`);

  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`panel_log_${categoryId}`)
    .setPlaceholder(resolveEmojis(`${category.emoji} ${category.label}`))
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(0)
    .setMaxValues(1);
  
  if (channelId) select.setDefaultChannels(channelId);

  const selectRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_log_back").setLabel(resolveEmojis("Geri")).setEmoji("◀️").setStyle(ButtonStyle.Secondary)
  );

  return { flags: COMPONENTS_V2_FLAG, components: [embed, selectRow, backRow] };
}

// ---------------------------------------------------------------------------
// 🧩 Diğer Kanallar — "Durum" sekmesindeki "Diğer Kanallar" butonuyla açılır.
// Log kategorisi sayılmayan ama yine de sunucuya özel tek bir kanala ihtiyaç
// duyan ayarlar burada (ceza logları vb.). Ayrı tutulma
// sebebi: "Log Kanalları" görünümü zaten Discord'un mesaj başına 5 action-row
// limitine tam oturuyor (geri + 4 kategori), yeni satır eklenemiyor.
// ---------------------------------------------------------------------------
export async function buildExtraChannelsTab(guildId: string) {
  const settings = await getAllChannelSettings(guildId);

  const embed = new V2CardBuilder()
    .setColor(0xd0a840)
    .setTitle("🧩 Bot Paneli — Diğer Kanallar")
    .setDescription(
      CHANNEL_SETTINGS.map((c) => {
        const channelId = settings[c.id];
        return `${c.emoji} **${c.label}** — ${channelId ? `<#${channelId}>` : "*ayarlanmamış*"}\n↳ ${c.ornek}`;
      }).join("\n\n") +
        "\n\nAşağıdaki menülerden her ayar için bir kanal seç. Seçimi çarpıya basıp temizlersen o ayar kapanır.",
    )
    .setFooter({ text: "Kanal ayarlamak/kaldırmak Sunucuyu Yönet iznine ihtiyaç duyar." })
    .setTimestamp();

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_shortcut_infoback").setLabel(resolveEmojis("Geri")).setEmoji("◀️").setStyle(ButtonStyle.Secondary),
  );

  const selectRows = CHANNEL_SETTINGS.map((c) => {
    const current = settings[c.id];
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`panel_chset_${c.id}`)
      .setPlaceholder(resolveEmojis(`${c.emoji} ${c.label}`))
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(0)
      .setMaxValues(1);
    if (current) select.setDefaultChannels(current);
    return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  });

  return { flags: COMPONENTS_V2_FLAG, components: [embed, backRow, ...selectRows] };
}

export function buildPanelView(tab: PanelTab, ctx?: { guild?: Guild | null; client?: Client | null }) {
  if (tab === "mod") return buildModTab();
  if (tab === "uyeler") return buildUyelerTab();
  if (tab === "info") return buildInfoTab(ctx?.guild, ctx?.client);
  if (tab === "bulksilme") return buildBulkSilmeTab();
  return buildGenelTab(ctx?.guild?.id);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}g`);
  if (h) parts.push(`${h}s`);
  parts.push(`${m}dk`);
  return parts.join(" ");
}
