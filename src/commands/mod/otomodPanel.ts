import { resolveEmojis, COMPONENTS_V2_FLAG, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Message,
  type MessageComponentInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getGuildConfig, updateGuildConfig, normalizeCustomWord } from "../../automod/store.js";
import { COLORS } from "../../utils/embeds.js";
import { EMOJIS } from "../../utils/emojis.js";
import { OWNER_ID } from "../../config.js";

export type AutomodPanelView = "main" | "protection" | "words" | "punishment" | "access";
type PanelInteraction = ButtonInteraction | StringSelectMenuInteraction | ChannelSelectMenuInteraction | RoleSelectMenuInteraction;

const TOGGLE_KEYS = {
  enabled: "enabled",
  words: "bannedWords",
  invites: "inviteLinks",
  spam: "spamFlood",
  caps: "capsLock",
} as const;

function onOff(value: boolean): string {
  return `${value ? EMOJIS.active : EMOJIS.error} ${value ? "Açık" : "Kapalı"}`;
}

function optionEmoji(raw: string) {
  const match = raw.match(/^<(?:(a):)?([^:>]+):(\d+)>$/);
  return match
    ? { animated: Boolean(match[1]), name: match[2], id: match[3] }
    : undefined;
}

function panelEmbed(cfg: Awaited<ReturnType<typeof getGuildConfig>>, view: AutomodPanelView): V2CardBuilder {
  const titles: Record<AutomodPanelView, string> = {
    main: `${EMOJIS.mod} Otomod Kontrol Merkezi`,
    protection: `${EMOJIS.suite} Koruma Modülleri`,
    words: `${EMOJIS.help} Kelime ve Kanal Yönetimi`,
    punishment: `${EMOJIS.timeout} Ceza Politikası`,
    access: `${EMOJIS.admin} Muafiyet ve Log`,
  };
  const descriptions: Record<AutomodPanelView, string> = {
    main: "Otomod sistemini tek ekrandan yönet. Aşağıdaki çekmeceyi kullanarak ayar kategorisini seç.",
    protection: "Her modülü ayrı ayrı açıp kapatabilirsin. Düzenleme bypass koruması otomatik olarak aktiftir.",
    words: "Özel kelime listesini ve davet linki istisna kanalını yönet.",
    punishment: "İhlal sayacı ve kademeli timeout politikasını ayarla.",
    access: "Muaf roller ve otomod log kanalını seç.",
  };
  const embed = new V2CardBuilder()
    .setColor(view === "punishment" ? 0xed4245 : COLORS.info)
    .setTitle(titles[view])
    .setDescription(descriptions[view])
    .setFooter({ text: "Bu panel yalnızca sunucu sahibi yetkisiyle kullanılabilir." })
    .setTimestamp();

  if (view === "main") {
    embed.addFields(
      { name: "Genel durum", value: onOff(cfg.enabled), inline: true },
      { name: "Kelime filtresi", value: onOff(cfg.bannedWords), inline: true },
      { name: "Davet engeli", value: onOff(cfg.inviteLinks), inline: true },
      { name: "Spam / Flood", value: onOff(cfg.spamFlood), inline: true },
      { name: "Caps koruması", value: onOff(cfg.capsLock), inline: true },
      { name: "Timeout", value: `${cfg.strikesBeforeTimeout}. ihlal → ${cfg.baseTimeoutMinutes}-${cfg.maxTimeoutMinutes} dk`, inline: true },
    );
  } else if (view === "protection") {
    embed.addFields(
      { name: "Yasaklı kelime", value: onOff(cfg.bannedWords), inline: true },
      { name: "Davet linki", value: onOff(cfg.inviteLinks), inline: true },
      { name: "Spam / Flood / Mention", value: onOff(cfg.spamFlood), inline: true },
      { name: "Caps", value: onOff(cfg.capsLock), inline: true },
      { name: "Edit koruması", value: `${EMOJIS.active} Her zaman aktif`, inline: true },
    );
  } else if (view === "words") {
    embed.addFields(
      { name: `Özel kelimeler (${cfg.wordList.length})`, value: cfg.wordList.length ? cfg.wordList.slice(0, 25).map((word) => `• \`${word}\``).join("\n") : "Henüz özel kelime yok.", inline: false },
      { name: "Davet izinli kanallar", value: cfg.inviteAllowedChannelIds.length ? cfg.inviteAllowedChannelIds.map((id) => `<#${id}>`).join(", ") : "Yok", inline: false },
    );
  } else if (view === "punishment") {
    embed.addFields(
      { name: "Timeout eşiği", value: `${cfg.strikesBeforeTimeout} ihlal`, inline: true },
      { name: "Başlangıç timeout", value: `${cfg.baseTimeoutMinutes} dakika`, inline: true },
      { name: "Timeout üst sınırı", value: `${cfg.maxTimeoutMinutes} dakika`, inline: true },
      { name: "Strike sıfırlama", value: `${cfg.strikeResetMinutes} dakika sessizlik`, inline: true },
      { name: "Model", value: "Kademeli: başlangıç süresi her ihlalde 2× artar.", inline: false },
    );
  } else {
    embed.addFields(
      { name: "Muaf roller", value: cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map((id) => `<@&${id}>`).join(", ") : "Yok", inline: false },
      { name: "Log kanalı", value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : "Ayarlanmadı", inline: false },
      { name: "Sistem muafları", value: "Sunucu sahibi", inline: false },
    );
  }
  return embed;
}

function drawerRow(view: AutomodPanelView): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("automod_panel_drawer")
    .setPlaceholder(resolveEmojis("Bir ayar çekmecesi aç..."))
    .addOptions(
      { label: resolveEmojis("Genel Bakış"), value: "main", emoji: optionEmoji(EMOJIS.general), default: view === "main" },
      { label: resolveEmojis("Koruma Modülleri"), value: "protection", emoji: optionEmoji(EMOJIS.mod), default: view === "protection" },
      { label: resolveEmojis("Kelime ve Kanallar"), value: "words", emoji: optionEmoji(EMOJIS.help), default: view === "words" },
      { label: resolveEmojis("Ceza Politikası"), value: "punishment", emoji: optionEmoji(EMOJIS.timeout), default: view === "punishment" },
      { label: resolveEmojis("Muafiyet ve Log"), value: "access", emoji: optionEmoji(EMOJIS.admin), default: view === "access" },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function button(customId: string, label: string, style: ButtonStyle, emoji: string, disabled = false): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(resolveEmojis(label)).setStyle(style).setEmoji(emoji).setDisabled(disabled);
}

function controls(cfg: Awaited<ReturnType<typeof getGuildConfig>>, view: AutomodPanelView): ActionRowBuilder<ButtonBuilder>[] {
  if (view === "main") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("automod_toggle_enabled", cfg.enabled ? "Otomodu Kapat" : "Otomodu Aç", cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success, cfg.enabled ? EMOJIS.error : EMOJIS.success),
      button("automod_refresh", "Yenile", ButtonStyle.Secondary, EMOJIS.loading),
    )];
  }
  if (view === "protection") {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("automod_toggle_words", `Kelime: ${cfg.bannedWords ? "Açık" : "Kapalı"}`, cfg.bannedWords ? ButtonStyle.Success : ButtonStyle.Secondary, EMOJIS.help),
        button("automod_toggle_invites", `Davet: ${cfg.inviteLinks ? "Açık" : "Kapalı"}`, cfg.inviteLinks ? ButtonStyle.Success : ButtonStyle.Secondary, EMOJIS.invite),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("automod_toggle_spam", `Spam: ${cfg.spamFlood ? "Açık" : "Kapalı"}`, cfg.spamFlood ? ButtonStyle.Success : ButtonStyle.Secondary, EMOJIS.alert),
        button("automod_toggle_caps", `Caps: ${cfg.capsLock ? "Açık" : "Kapalı"}`, cfg.capsLock ? ButtonStyle.Success : ButtonStyle.Secondary, EMOJIS.info),
      ),
    ];
  }
  if (view === "words") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("automod_word_add", "Kelime Ekle", ButtonStyle.Success, EMOJIS.success),
      button("automod_word_remove", "Kelime Sil", ButtonStyle.Danger, EMOJIS.error),
      button("automod_word_clear_custom", "Özel Listeyi Temizle", ButtonStyle.Secondary, EMOJIS.loading),
    ), new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("automod_invite_channel").setPlaceholder(resolveEmojis("🔗 Davet izni verilecek kanalı seç")).setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1),
    ) as unknown as ActionRowBuilder<ButtonBuilder>];
  }
  if (view === "punishment") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("automod_set_threshold", "İhlal Eşiği", ButtonStyle.Primary, EMOJIS.warn),
      button("automod_set_timeout", "Timeout Süreleri", ButtonStyle.Primary, EMOJIS.timeout),
      button("automod_set_reset", "Strike Süresi", ButtonStyle.Secondary, EMOJIS.back),
    )];
  }
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("automod_clear_roles", "Muaf Rolleri Temizle", ButtonStyle.Danger, EMOJIS.loading),
    button("automod_disable_log", "Logu Kapat", ButtonStyle.Secondary, EMOJIS.error),
  ), new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder().setCustomId("automod_exempt_role").setPlaceholder(resolveEmojis("Muaf rol seç")).setMinValues(1).setMaxValues(1),
  ) as unknown as ActionRowBuilder<ButtonBuilder>, new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder().setCustomId("automod_log_channel").setPlaceholder(resolveEmojis("📋 Log kanalını seç")).setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1),
  ) as unknown as ActionRowBuilder<ButtonBuilder>];
}

export async function buildAutomodPanel(guildId: string, view: AutomodPanelView = "main") {
  const cfg = await getGuildConfig(guildId);
  return { flags: MessageFlags.IsComponentsV2 as const, components: [panelEmbed(cfg, view), drawerRow(view), ...controls(cfg, view)] };
}

function modalFor(customId: string, title: string, fields: Array<{ id: string; label: string; value: string; placeholder: string }>): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(...fields.map((field) => new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(field.id).setLabel(resolveEmojis(field.label)).setStyle(TextInputStyle.Short).setRequired(true).setValue(field.value).setPlaceholder(resolveEmojis(field.placeholder)),
  )));
  return modal;
}

async function updatePanel(interaction: MessageComponentInteraction, view: AutomodPanelView): Promise<void> {
  if (!interaction.isRepliable()) return;
  await interaction.update(await buildAutomodPanel(interaction.guild!.id, view));
}

export async function attachAutomodPanel(message: Message, guildId: string): Promise<void> {
  const panelMessage = await message.reply(await buildAutomodPanel(guildId));
  const collector = panelMessage.createMessageComponentCollector({ time: 15 * 60_000 });
  collector.on("collect", (interaction: PanelInteraction) => {
    void (async () => {
      if (interaction.user.id !== interaction.guild?.ownerId && interaction.user.id !== OWNER_ID) {
        await interaction.reply({ flags: COMPONENTS_V2_FLAG, components: textCard("Bu paneli yalnızca sunucu sahibi kullanabilir."), ephemeral: true  });
        return;
      }
      const id = interaction.customId;
      if (interaction.isStringSelectMenu() && id === "automod_panel_drawer") {
        await updatePanel(interaction, interaction.values[0] as AutomodPanelView);
        return;
      }
      if (interaction.isChannelSelectMenu() && id === "automod_invite_channel") {
        const cfg = await getGuildConfig(guildId);
        const channelId = interaction.values[0];
        const allowed = cfg.inviteAllowedChannelIds.includes(channelId);
        await updateGuildConfig(guildId, { inviteAllowedChannelIds: allowed ? cfg.inviteAllowedChannelIds.filter((id) => id !== channelId) : [...cfg.inviteAllowedChannelIds, channelId] });
        await updatePanel(interaction, "words");
        return;
      }
      if (interaction.isChannelSelectMenu() && id === "automod_log_channel") {
        await updateGuildConfig(guildId, { logChannelId: interaction.values[0] ?? null });
        await updatePanel(interaction, "access");
        return;
      }
      if (interaction.isRoleSelectMenu() && id === "automod_exempt_role") {
        const cfg = await getGuildConfig(guildId);
        const roleId = interaction.values[0];
        const exists = cfg.exemptRoleIds.includes(roleId);
        await updateGuildConfig(guildId, { exemptRoleIds: exists ? cfg.exemptRoleIds.filter((id) => id !== roleId) : [...cfg.exemptRoleIds, roleId] });
        await updatePanel(interaction, "access");
        return;
      }
      if (!interaction.isButton()) return;
      if (id === "automod_refresh") { await updatePanel(interaction, "main"); return; }
      const cfg = await getGuildConfig(guildId);
      const toggleMap: Record<string, keyof typeof TOGGLE_KEYS> = { automod_toggle_enabled: "enabled", automod_toggle_words: "words", automod_toggle_invites: "invites", automod_toggle_spam: "spam", automod_toggle_caps: "caps" };
      if (toggleMap[id]) {
        const key = TOGGLE_KEYS[toggleMap[id]];
        await updateGuildConfig(guildId, { [key]: !cfg[key] });
        await updatePanel(interaction, id === "automod_toggle_enabled" ? "main" : "protection");
        return;
      }
      if (id === "automod_clear_roles") { await updateGuildConfig(guildId, { exemptRoleIds: [] }); await updatePanel(interaction, "access"); return; }
      if (id === "automod_disable_log") { await updateGuildConfig(guildId, { logChannelId: null }); await updatePanel(interaction, "access"); return; }
      if (id === "automod_word_clear_custom") { await updateGuildConfig(guildId, { wordList: [] }); await updatePanel(interaction, "words"); return; }
      if (id === "automod_word_add" || id === "automod_word_remove") {
        await interaction.showModal(modalFor(id === "automod_word_add" ? "automod_modal_word_add" : "automod_modal_word_remove", id === "automod_word_add" ? "Özel Kelime Ekle" : "Özel Kelime Sil", [{ id: "word", label: "Kelime", value: "", placeholder: "Kelime veya ifade" }]));
        const modal = await interaction.awaitModalSubmit({ time: 60_000, filter: (submitted) => submitted.user.id === interaction.user.id });
        const word = normalizeCustomWord(modal.fields.getTextInputValue("word"));
        if (!word || word.length > 64) {
          await modal.reply({ flags: COMPONENTS_V2_FLAG, components: textCard("Kelime veya ifade 1–64 karakter arasında olmalı."), ephemeral: true  });
          return;
        }
        const current = await getGuildConfig(guildId);
        const words = id === "automod_word_add"
          ? current.wordList.some((item) => normalizeCustomWord(item) === word)
            ? current.wordList
            : [...current.wordList, word].slice(0, 500)
          : current.wordList.filter((item) => normalizeCustomWord(item) !== word);
        await updateGuildConfig(guildId, { wordList: words });
        await modal.deferUpdate();
        await panelMessage.edit(await buildAutomodPanel(guildId, "words")).catch(() => null);
        return;
      }
      if (id === "automod_set_threshold" || id === "automod_set_reset") {
        const isThreshold = id === "automod_set_threshold";
        await interaction.showModal(modalFor(isThreshold ? "automod_modal_threshold" : "automod_modal_reset", isThreshold ? "İhlal Eşiği" : "Strike Sıfırlama Süresi", [{ id: "value", label: isThreshold ? "Kaçıncı ihlalde timeout?" : "Kaç dakika sessizlik?", value: String(isThreshold ? cfg.strikesBeforeTimeout : cfg.strikeResetMinutes), placeholder: "Örn. 3" }]));
        const modal = await interaction.awaitModalSubmit({ time: 60_000, filter: (submitted) => submitted.user.id === interaction.user.id });
        const value = Number(modal.fields.getTextInputValue("value"));
        if (Number.isInteger(value) && value > 0) await updateGuildConfig(guildId, isThreshold ? { strikesBeforeTimeout: Math.min(value, 100) } : { strikeResetMinutes: Math.min(value, 10_080) });
        await modal.deferUpdate();
        await panelMessage.edit(await buildAutomodPanel(guildId, "punishment")).catch(() => null);
        return;
      }
      if (id === "automod_set_timeout") {
        await interaction.showModal(modalFor("automod_modal_timeout", "Timeout Süreleri", [{ id: "base", label: "Başlangıç dakika", value: String(cfg.baseTimeoutMinutes), placeholder: "Örn. 1" }, { id: "max", label: "Üst sınır dakika", value: String(cfg.maxTimeoutMinutes), placeholder: "Örn. 60" }]));
        const modal = await interaction.awaitModalSubmit({ time: 60_000, filter: (submitted) => submitted.user.id === interaction.user.id });
        const base = Number(modal.fields.getTextInputValue("base"));
        const max = Number(modal.fields.getTextInputValue("max"));
        if (Number.isInteger(base) && Number.isInteger(max) && base > 0 && max >= base) await updateGuildConfig(guildId, { baseTimeoutMinutes: Math.min(base, 40_320), maxTimeoutMinutes: Math.min(max, 40_320) });
        await modal.deferUpdate();
        await panelMessage.edit(await buildAutomodPanel(guildId, "punishment")).catch(() => null);
      }
    })().catch((error) => console.error("otomod panel patladı:", error));
  });
  collector.on("end", () => void panelMessage.edit({ flags: COMPONENTS_V2_FLAG, components: [] }).catch(() => null));
}
