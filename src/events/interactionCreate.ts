import { resolveEmojis, V2CardBuilder } from "../utils/componentsV2.js";
import { v2Payload } from "../utils/messages.js";
import {
  type Interaction,
  Collection,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { Command } from "../types.js";
import { errorEmbed } from "../utils/embeds.js";
import { MSG } from "../utils/messages.js";
import { toggleVipById } from "./messageCreate.js";
import {
  buildPanelView,
  buildLogTab, buildLogCategoryTab,
  buildExtraChannelsTab,
  type PanelTab,
} from "./panel.js";
import { db } from "../db/index.js";
import { warningsTable } from "../db/schema.js";
import { and, eq } from "../db/jsonOrm.js";
import { setLogChannel, type LogCategory } from "../utils/logger.js";
import {
  setChannelSetting,
  type ChannelSettingId,
} from "../utils/channelSettings.js";
import { OWNER_ID } from "../config.js";
import { notifyOwnerCommandUsed } from "../utils/notifyOwner.js";
import {
  buildGuardAdvancedPanel,
  buildGuardPanel,
  getGuardConfig,
  updateGuardConfig,
  GUARD_CORE_SELECT_KEYS,
  GUARD_NUKE_SELECT_KEYS,
  type GuardConfig,
} from "../utils/guard.js";
import {
  botModerationBlockMessage,
  canModerate,
  getBotModerationBlockReason,
} from "../utils/hierarchy.js";
import {
  buildModellerView,
  MODELLER_SELECT_PREFIX,
  MODELLER_RESET_PREFIX,
} from "./modellerPanel.js";
import {
  setActiveModel,
  resetActiveModel,
  type ModelGroup,
} from "../utils/modelSettings.js";
import { buildWelcomePanelView } from "../welcome/panel.js";
import { handleRoleMenuInteraction } from "../rolemenu/interactions.js";
import {
  getGuildWelcomeConfig,
  updateGuildWelcomeConfig,
} from "../welcome/store.js";
import { isTemplateTooLong, MAX_TEMPLATE_LENGTH } from "../welcome/render.js";
import {
  bulkSelectionKey,
  getBulkSelection,
  saveBulkSelection,
  deleteBulkSelection,
} from "./bulkSelection.js";
import { EMOJIS } from "../utils/emojis.js";
import { getPanelOwnerId } from "./panelOwners.js";

function parseUserId(raw: string): string | null {
  const cleaned = raw.trim().replace(/[<@!>]/g, "");
  return /^\d{15,25}$/.test(cleaned) ? cleaned : null;
}

const MAX_PANEL_REASON_LENGTH = 450;

function panelReason(
  interaction: import("discord.js").ModalSubmitInteraction,
  customId = "reason",
): string {
  const value = safeGetField(interaction, customId).trim();
  return (value || "Sebep belirtilmedi").slice(0, MAX_PANEL_REASON_LENGTH);
}

// ---------------------------------------------------------------------------
// İzin haritası: Discord-içi panellerin (!guard, !hosgeldin, !modeller)
// içindeki her aksiyon kendi doğal Discord iznine bağlanıyor.
// discord.js'in .has() metodu Administrator'ı zaten otomatik olarak her izni
// kapsıyor sayıyor, o yüzden ayrıca kontrol etmeye gerek yok.
// NOT: !panel komutu kaldırıldı; aşağıdaki panel_tab_/panel_* handler'ları
// artık tetiklenemeyen ölü koddur, ileride topluca silinebilir.
// ---------------------------------------------------------------------------
const PANEL_OPEN_PERMISSION = "ModerateMembers" as const;

type PermissionName =
  | "BanMembers"
  | "KickMembers"
  | "ModerateMembers"
  | "Administrator"
  | "ManageGuild";

const ACTION_PERMISSIONS: Record<string, PermissionName> = {
  ban: "BanMembers",
  unban: "BanMembers",
  kick: "KickMembers",
  mute: "ModerateMembers",
  unmute: "ModerateMembers",
  warn: "ModerateMembers",
  uyarigor: "ModerateMembers",
  ozelde: "Administrator",
  bulksilme: "Administrator",
  duyuru: "ManageGuild",
};

const PERMISSION_LABELS: Record<PermissionName, string> = {
  BanMembers: "Üyeleri Yasakla",
  KickMembers: "Üyeleri At",
  ModerateMembers: "Üyeleri Yönet (Zaman Aşımı)",
  Administrator: "Yönetici",
  ManageGuild: "Sunucuyu Yönet",
};

// ---------------------------------------------------------------------------
// Panel sahibi kontrolü: interaction'ın geldiği mesajın panelOwners
// store'unda kayıtlı olup olmadığına (yani gerçekten !guard /
// !hosgeldin / !modeller komutlarından biriyle açılmış bir panel mesajı mı)
// VE kaydedilen sahibiyle interaction'ı tetikleyen kişinin aynı olup
// olmadığına bakar. Üç ihtimalde de false döner:
//  1) mesaj store'da hiç kayıtlı değilse (uydurma/taklit customId),
//  2) mesaj süresi dolup temizlenmişse,
//  3) interaction'ı başka biri tetikliyorsa (paneli açan kişi o değilse).
// ---------------------------------------------------------------------------
function panelMessageId(interaction: Interaction): string | null {
  if (interaction.isMessageComponent()) return interaction.message?.id ?? null;
  if (interaction.isModalSubmit()) return interaction.message?.id ?? null;
  return null;
}

function isPanelOwner(interaction: Interaction): boolean {
  const ownerId = getPanelOwnerId(panelMessageId(interaction));
  if (!ownerId) return false;
  return interaction.user.id === ownerId;
}

function isGuildOwner(interaction: Interaction): boolean {
  return (
    interaction.inGuild() &&
    interaction.guild?.ownerId === interaction.user.id
  );
}

function hasGuardPanelAccess(interaction: Interaction): boolean {
  if (!interaction.inGuild()) return false;
  if (interaction.user.id === interaction.client.user?.id) return true;
  if (interaction.user.id === OWNER_ID) return true;
  if (isGuildOwner(interaction)) return true;
  if (!isPanelOwner(interaction)) return false;
  return interaction.user.id === interaction.guild?.ownerId;
}

// !hosgeldin paneli: mevcut metin komutuyla aynı yetki kuralı (Sunucuyu Yönet
// veya bot sahibi) — bkz. commands/mod/hosgeldin.ts.
function hasWelcomePanelAccess(interaction: Interaction): boolean {
  if (!interaction.inGuild()) return false;
  if (interaction.user.id === OWNER_ID) return true;
  if (isGuildOwner(interaction)) return true;
  if (!isPanelOwner(interaction)) return false;
  return interaction.memberPermissions?.has("ManageGuild") ?? false;
}

function hasPanelAccess(interaction: Interaction): boolean {
  if (!interaction.inGuild()) return false;
  if (interaction.user.id === OWNER_ID) return true;
  if (isGuildOwner(interaction)) return true;
  if (!isPanelOwner(interaction)) return false;
  return interaction.memberPermissions?.has(PANEL_OPEN_PERMISSION) ?? false;
}

function hasActionPermission(
  interaction: Interaction,
  action: string,
): boolean {
  if (!interaction.inGuild()) return false;
  // VIP/özel üyelik küresel bir bot özelliğidir; sunucu yöneticilerine
  // verilmesi, metin komutundaki owner-only güvenlik modelini aşmamalı.
  if (action === "ozelde") return interaction.user.id === OWNER_ID;
  const perm = ACTION_PERMISSIONS[action];
  if (!perm) return false;
  if (interaction.user.id === OWNER_ID) return true;
  if (isGuildOwner(interaction)) return true;
  if (!isPanelOwner(interaction)) return false;
  return interaction.memberPermissions?.has(perm) ?? false;
}

function permissionLabelFor(action: string): string {
  const perm = ACTION_PERMISSIONS[action];
  return PERMISSION_LABELS[perm] ?? perm ?? "gerekli izin";
}

type PanelModerationPermission =
  | typeof PermissionFlagsBits.BanMembers
  | typeof PermissionFlagsBits.KickMembers
  | typeof PermissionFlagsBits.ModerateMembers;

type PanelTargetValidation = {
  member: import("discord.js").GuildMember | null;
  error: string | null;
};

function panelTargetIdentityError(
  interaction: Interaction,
  userId: string,
): string | null {
  if (userId === interaction.user.id)
    return "Kendin üzerinde bu işlemi uygulayamazsın.";
  if (userId === interaction.client.user?.id)
    return "Bot üzerinde bu işlemi uygulayamam.";
  if (userId === OWNER_ID) return "Bot sahibine karşı bu işlemi uygulayamam.";
  return null;
}

async function validatePanelMember(
  interaction: import("discord.js").ModalSubmitInteraction,
  userId: string,
  permission: PanelModerationPermission,
  action:
    | "susturamam"
    | "atamam"
    | "yasaklayamam"
    | "susturmasını kaldıramam"
    | "uyaramam",
): Promise<PanelTargetValidation> {
  const identityError = panelTargetIdentityError(interaction, userId);
  if (identityError) return { member: null, error: identityError };

  const member = await interaction
    .guild!.members.fetch(userId)
    .catch(() => null);
  if (!member)
    return { member: null, error: "Bu kullanıcıyı sunucuda bulamadım." };

  const botBlock = getBotModerationBlockReason(
    interaction.guild!.members.me,
    member,
    permission,
    interaction.user.id,
  );
  if (botBlock)
    return { member: null, error: botModerationBlockMessage(botBlock, action) };

  const executor = await interaction
    .guild!.members.fetch(interaction.user.id)
    .catch(() => null);
  if (!executor)
    return {
      member: null,
      error: "İşlemi yapan üye doğrulanamadı; lütfen tekrar dene.",
    };
  if (!canModerate(executor, member)) {
    return {
      member: null,
      error: "Bu kullanıcının rolü seninkiyle aynı ya da daha yüksek.",
    };
  }

  return { member, error: null };
}

// ---------------------------------------------------------------------------
// Modal (form) builder yardımcıları
// ---------------------------------------------------------------------------
function textInput(
  customId: string,
  label: string,
  opts?: {
    placeholder?: string;
    required?: boolean;
    long?: boolean;
    maxLength?: number;
  },
) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(resolveEmojis(label))
    .setStyle(opts?.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(opts?.required ?? true);
  if (opts?.placeholder) input.setPlaceholder(resolveEmojis(opts.placeholder));
  if (opts?.maxLength !== undefined) input.setMaxLength(opts.maxLength);
  return input;
}

function buildModal(
  customId: string,
  title: string,
  rows: TextInputBuilder[],
): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(
    ...rows.map((r) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(r),
    ),
  );
  return modal;
}

const USER_ID_INPUT = () =>
  textInput("userId", "Kullanıcı ID'si", {
    placeholder: "ör. 123456789012345678",
  });
const REASON_INPUT = (required = true) =>
  textInput("reason", "Sebep", {
    long: true,
    required,
    maxLength: MAX_PANEL_REASON_LENGTH,
  });

const DURATION_INPUT = () =>
  textInput("duration", "Süre (dakika)", { placeholder: "ör. 60" });

// action -> modal tanımı. Her biri panel_open_<action> butonuna basınca açılır,
// panel_submit_<action> olarak geri döner.
const MODAL_BUILDERS: Record<string, () => ModalBuilder> = {
  ban: () =>
    buildModal("panel_submit_ban", "Kullanıcıyı Banla", [
      USER_ID_INPUT(),
      REASON_INPUT(),
    ]),
  kick: () =>
    buildModal("panel_submit_kick", "Kullanıcıyı At (Kick)", [
      USER_ID_INPUT(),
      REASON_INPUT(),
    ]),
  mute: () =>
    buildModal("panel_submit_mute", "Kullanıcıyı Sustur", [
      USER_ID_INPUT(),
      REASON_INPUT(),
      DURATION_INPUT(),
    ]),
  unmute: () =>
    buildModal("panel_submit_unmute", "Susturmayı Kaldır", [
      USER_ID_INPUT(),
      REASON_INPUT(false),
    ]),
  unban: () =>
    buildModal("panel_submit_unban", "Banı Kaldır", [
      USER_ID_INPUT(),
      REASON_INPUT(false),
    ]),
  warn: () =>
    buildModal("panel_submit_warn", "Kullanıcıya Uyarı Ver", [
      USER_ID_INPUT(),
      REASON_INPUT(),
    ]),
  uyarigor: () =>
    buildModal("panel_submit_uyarigor", "Kullanıcının Uyarılarını Görüntüle", [
      USER_ID_INPUT(),
    ]),
  ozelde: () =>
    buildModal("panel_submit_ozelde", "Özel Üyeliği Aç/Kapat", [
      USER_ID_INPUT(),
    ]),
  bulksilme_rolefilter: () =>
    buildModal("panel_submit_bulksilme_rolefilter", "Rol Filtresi", [
      textInput("filter", "Rol Emojisi veya Adının Başlangıcı", {
        placeholder: "ör. 💎 veya elmas",
        required: true,
      }),
    ]),
};

export async function interactionCreateEvent(
  interaction: Interaction,
  commands: Collection<string, Command>,
): Promise<void> {
  // 🎭 Rol menüleri (restart-proof): DB'den çözülür, kalıcı customId.
  if (await handleRoleMenuInteraction(interaction)) return;

  // -------------------------------------------------------------------
  // !bilgiyarismasi: yarışma bittikten sonra (doğru cevap / süre dolması)
  // butonlara geç tıklayanlara cevap ver — yoksa "etkileşim başarısız
  // oldu" görünür. Collector aktifken bu dal sessiz kalır (cevabı
  // collector verir); çift cevap vermemek için yarışmanın bitip bitmediği
  // butonların devre dışı olup olmadığına bakılarak anlaşılır.
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId.startsWith("quiz_answer_")
  ) {
    const ended =
      interaction.message.components.length > 0 &&
      interaction.message.components.every((row) =>
        ((row as unknown as {
          components?: readonly { data?: { disabled?: boolean } }[];
        }).components?.every((component) => component.data?.disabled === true) ?? false),
      );
    if (ended) {
      await interaction
        .reply(v2Payload({ content: MSG.error("Yarışma bitti."), ephemeral: true }))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // !modeller: sağlayıcı model seçim menüleri + "Tümünü Sıfırla" butonu.
  // Owner-only — mesaj komutu zaten requireOwner ile korunuyor ama menü
  // herkese görünür olduğu için burada da tekrar kontrol ediyoruz.
  // -------------------------------------------------------------------
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith(MODELLER_SELECT_PREFIX)
  ) {
    if (interaction.user.id !== OWNER_ID) {
      await interaction
        .reply(v2Payload({
          content: MSG.error("Bu menüyü yalnızca bot sahibi kullanabilir."),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const group = interaction.customId.replace(
      MODELLER_SELECT_PREFIX,
      "",
    ) as ModelGroup;
    const model = interaction.values[0];
    if (!model || !["gemini", "groq", "openrouter"].includes(group)) {
      await interaction
        .reply(v2Payload({ content: MSG.error("Geçersiz seçim."), ephemeral: true }))
        .catch(() => null);
      return;
    }
    try {
      setActiveModel(group, model);
      await interaction.update(v2Payload(buildModellerView())).catch(() => null);
    } catch (err) {
      console.error("model ayarı kaydolmadı:", err);
      await interaction
        .reply(v2Payload({
          content: MSG.error("Model ayarı kaydedilirken bir hata oluştu."),
          ephemeral: true,
        }))
        .catch(() => null);
    }
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith(MODELLER_RESET_PREFIX)
  ) {
    if (interaction.user.id !== OWNER_ID) {
      await interaction
        .reply(v2Payload({
          content: MSG.error("Bu menüyü yalnızca bot sahibi kullanabilir."),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      resetActiveModel("gemini");
      resetActiveModel("groq");
      resetActiveModel("openrouter");
      await interaction.update(v2Payload(buildModellerView())).catch(() => null);
    } catch (err) {
      console.error("model ayarları sıfırlanmadı:", err);
      await interaction
        .reply(v2Payload({
          content: MSG.error("Model ayarları sıfırlanırken bir hata oluştu."),
          ephemeral: true,
        }))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Guard paneli butonları
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId === "guard_open_advanced"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await interaction
      .reply(v2Payload({
        ...(await buildGuardAdvancedPanel(interaction.guildId!)),
        ephemeral: true,
      }))
      .catch(() => null);
    return;
  }
  if (interaction.isButton() && interaction.customId === "guard_back_panel") {
    // Diğer tüm guard_* etkileşimleriyle tutarlı olması için burada da
    // hasGuardPanelAccess kontrolü şart: eksikse, gelişmiş panele erişimi
    // olmayan biri "Panele Dön" ile eşik/muafiyet/log gibi hassas guard
    // ayarlarını görebilirdi.
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await interaction
      .update(v2Payload(await buildGuardPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (interaction.isButton() && interaction.customId === "guard_open_penalty") {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const config = await getGuardConfig(interaction.guildId!);
    const modal = new ModalBuilder()
      .setCustomId("guard_submit_penalty")
      .setTitle("Ceza ve Kanal Kurtarma");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("actionPunishment")
          .setLabel(resolveEmojis("Ceza: none/warn/kick/ban/timeout"))
          .setStyle(TextInputStyle.Short)
          .setValue(config.actionPunishment)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("restoreDeletedChannels")
          .setLabel(resolveEmojis("Silinen kanalı geri oluştur: true/false"))
          .setStyle(TextInputStyle.Short)
          .setValue(String(config.restoreDeletedChannels))
          .setRequired(true),
      ),
    );
    await interaction.showModal(modal).catch(() => null);
    return;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId === "guard_submit_penalty"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const punishment = interaction.fields
      .getTextInputValue("actionPunishment")
      .trim()
      .toLowerCase();
    const restoreRaw = interaction.fields
      .getTextInputValue("restoreDeletedChannels")
      .trim()
      .toLowerCase();
    if (
      !"none warn kick ban timeout".split(" ").includes(punishment) ||
      !["true", "false"].includes(restoreRaw)
    ) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Ceza none, warn, kick, ban veya timeout olmalı; kurtarma true/false olmalı.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuardConfig(interaction.guildId!, {
      actionPunishment: punishment as GuardConfig["actionPunishment"],
      restoreDeletedChannels: restoreRaw === "true",
    });
    await interaction
      .reply(v2Payload({
        content: `${EMOJIS.success} Ceza ve kanal kurtarma ayarları kaydedildi.`,
        ephemeral: true,
      }))
      .catch(() => null);
    return;
  }
  if (
    interaction.isButton() &&
    interaction.customId === "guard_open_thresholds"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const config = await getGuardConfig(interaction.guildId!);
    const modal = new ModalBuilder()
      .setCustomId("guard_submit_thresholds")
      .setTitle("Guard Eşiklerini Ayarla");
    const fields = [
      [
        "roleDeleteThreshold",
        "Rol silme eşiği",
        String(config.roleDeleteThreshold),
      ],
      [
        "channelDeleteThreshold",
        "Kanal silme eşiği",
        String(config.channelDeleteThreshold),
      ],
      ["botAddThreshold", "Bot ekleme eşiği", String(config.botAddThreshold)],
      [
        "actionWindowSeconds",
        "Rol/kanal/bot zaman penceresi (saniye)",
        String(config.actionWindowSeconds),
      ],
      [
        "raidSettings",
        "Raid eşiği / saniye (ör. 5/10)",
        `${config.raidJoinThreshold}/${config.raidWindowSeconds}`,
      ],
    ];
    modal.addComponents(
      ...fields.map(([id, label, value]) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(id)
            .setLabel(resolveEmojis(label))
            .setStyle(TextInputStyle.Short)
            .setValue(value)
            .setRequired(true),
        ),
      ),
    );
    await interaction.showModal(modal).catch(() => null);
    return;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId === "guard_submit_thresholds"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const number = (id: string): number =>
      Number.parseInt(interaction.fields.getTextInputValue(id), 10);
    const raidParts = interaction.fields
      .getTextInputValue("raidSettings")
      .split(/[\s/,:;-]+/)
      .map((value) => Number.parseInt(value, 10));
    const values = {
      roleDeleteThreshold: number("roleDeleteThreshold"),
      channelDeleteThreshold: number("channelDeleteThreshold"),
      botAddThreshold: number("botAddThreshold"),
      actionWindowSeconds: number("actionWindowSeconds"),
      raidJoinThreshold: raidParts[0] ?? Number.NaN,
      raidWindowSeconds: raidParts[1] ?? Number.NaN,
    };
    if (
      Object.values(values).some(
        (value) => !Number.isInteger(value) || value < 1,
      )
    ) {
      await interaction
        .reply(v2Payload({
          content: MSG.error("Eşikler pozitif tam sayı olmalıdır."),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuardConfig(interaction.guildId!, values);
    await interaction
      .reply(v2Payload({ content: `${EMOJIS.success} Guard eşikleri kaydedildi.`, ephemeral: true }))
      .catch(() => null);
    return;
  }
  if (
    interaction.isButton() &&
    interaction.customId === "guard_open_nuke_thresholds"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const config = await getGuardConfig(interaction.guildId!);
    const modal = new ModalBuilder()
      .setCustomId("guard_submit_nuke_thresholds")
      .setTitle("Anti-Nuke Eşiklerini Ayarla");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("massBanThreshold")
          .setLabel(resolveEmojis("Toplu ban eşiği (kaç ban / pencere)"))
          .setStyle(TextInputStyle.Short)
          .setValue(String(config.massBanThreshold))
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("massKickThreshold")
          .setLabel(resolveEmojis("Toplu kick eşiği (kaç kick / pencere)"))
          .setStyle(TextInputStyle.Short)
          .setValue(String(config.massKickThreshold))
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("raidSettings")
          .setLabel(resolveEmojis("Raid eşiği / saniye (ör. 5/10)"))
          .setStyle(TextInputStyle.Short)
          .setValue(`${config.raidJoinThreshold}/${config.raidWindowSeconds}`)
          .setRequired(true),
      ),
    );
    await interaction.showModal(modal).catch(() => null);
    return;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId === "guard_submit_nuke_thresholds"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const number = (id: string): number =>
      Number.parseInt(interaction.fields.getTextInputValue(id), 10);
    const raidParts = interaction.fields
      .getTextInputValue("raidSettings")
      .split(/[\s/,:;-]+/)
      .map((value) => Number.parseInt(value, 10));
    const values = {
      massBanThreshold: number("massBanThreshold"),
      massKickThreshold: number("massKickThreshold"),
      raidJoinThreshold: raidParts[0] ?? Number.NaN,
      raidWindowSeconds: raidParts[1] ?? Number.NaN,
    };
    if (
      Object.values(values).some(
        (value) => !Number.isInteger(value) || value < 1,
      )
    ) {
      await interaction
        .reply(v2Payload({
          content: MSG.error("Eşikler pozitif tam sayı olmalıdır."),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuardConfig(interaction.guildId!, values);
    await interaction
      .reply(v2Payload({ content: `${EMOJIS.success} Anti-nuke eşikleri kaydedildi.`, ephemeral: true }))
      .catch(() => null);
    return;
  }
  if (interaction.isButton() && interaction.customId === "guard_refresh") {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await interaction
      .update(v2Payload(await buildGuardPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (
    interaction.isButton() &&
    interaction.customId.startsWith("guard_profile_")
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const profile = interaction.customId.replace("guard_profile_", "");
    const presets: Record<string, Partial<GuardConfig>> = {
      off: {
        enabled: false,
        antiRoleDelete: false,
        antiChannelDelete: false,
        antiBotAdd: false,
        antiRaid: false,
        antiMassBan: false,
        antiMassKick: false,
        antiPermissionEscalation: false,
        raidAutoKick: false,
      },
      low: {
        enabled: true,
        antiRoleDelete: false,
        antiChannelDelete: false,
        antiBotAdd: true,
        antiRaid: false,
        antiMassBan: false,
        antiMassKick: false,
        antiPermissionEscalation: false,
        raidAutoKick: false,
      },
      medium: {
        enabled: true,
        antiRoleDelete: true,
        antiChannelDelete: false,
        antiBotAdd: true,
        antiRaid: true,
        antiMassBan: true,
        antiMassKick: true,
        antiPermissionEscalation: false,
        raidAutoKick: false,
      },
      high: {
        enabled: true,
        antiRoleDelete: true,
        antiChannelDelete: true,
        antiBotAdd: true,
        antiRaid: true,
        antiMassBan: true,
        antiMassKick: true,
        antiPermissionEscalation: true,
        raidAutoKick: true,
      },
    };
    const preset = presets[profile];
    if (!preset) return;
    await updateGuardConfig(interaction.guildId!, preset);
    await interaction
      .update(v2Payload(await buildGuardPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (
    interaction.isRoleSelectMenu() &&
    interaction.customId === "guard_select_exempt_role"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const config = await getGuardConfig(interaction.guildId!);
    const id = interaction.values[0];
    const exemptRoleIds = config.exemptRoleIds.includes(id)
      ? config.exemptRoleIds.filter((item) => item !== id)
      : [...config.exemptRoleIds, id];
    await updateGuardConfig(interaction.guildId!, { exemptRoleIds });
    await interaction
      .update(v2Payload(await buildGuardAdvancedPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (
    interaction.isUserSelectMenu() &&
    interaction.customId === "guard_select_exempt_user"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const config = await getGuardConfig(interaction.guildId!);
    const id = interaction.values[0];
    const exemptUserIds = config.exemptUserIds.includes(id)
      ? config.exemptUserIds.filter((item) => item !== id)
      : [...config.exemptUserIds, id];
    await updateGuardConfig(interaction.guildId!, { exemptUserIds });
    await interaction
      .update(v2Payload(await buildGuardAdvancedPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId === "guard_select_exempt_channel"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const config = await getGuardConfig(interaction.guildId!);
    const id = interaction.values[0];
    const exemptChannelIds = config.exemptChannelIds.includes(id)
      ? config.exemptChannelIds.filter((item) => item !== id)
      : [...config.exemptChannelIds, id];
    await updateGuardConfig(interaction.guildId!, { exemptChannelIds });
    await interaction
      .update(v2Payload(await buildGuardAdvancedPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId === "guard_select_log_channel"
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuardConfig(interaction.guildId!, {
      logChannelId: interaction.values[0] ?? null,
    });
    await interaction
      .update(v2Payload(await buildGuardAdvancedPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (interaction.isButton() && interaction.customId === "guard_clear_lists") {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuardConfig(interaction.guildId!, {
      exemptUserIds: [],
      exemptRoleIds: [],
      exemptChannelIds: [],
    });
    await interaction
      .update(v2Payload(await buildGuardAdvancedPanel(interaction.guildId!)))
      .catch(() => null);
    return;
  }
  if (
    interaction.isStringSelectMenu() &&
    (interaction.customId === "guard_select_core" ||
      interaction.customId === "guard_select_nuke")
  ) {
    if (!interaction.inGuild() || !hasGuardPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli yalnızca sunucu sahibi kullanabilir.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const allowedKeys =
      interaction.customId === "guard_select_core"
        ? GUARD_CORE_SELECT_KEYS
        : GUARD_NUKE_SELECT_KEYS;
    const selected = new Set(interaction.values);
    const updates = Object.fromEntries(
      allowedKeys.map((key) => [key, selected.has(key)]),
    ) as Partial<GuardConfig>;
    try {
      await updateGuardConfig(interaction.guildId!, updates);
      await interaction
        .update(v2Payload(await buildGuardPanel(interaction.guildId!)))
        .catch(() => null);
    } catch (error) {
      console.error("guard panel güncellenemedi:", error);
      await interaction
        .reply(v2Payload({
          content: MSG.error("Guard ayarı kaydedilemedi."),
          ephemeral: true,
        }))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // !hosgeldin paneli — kanal seçimi, mesaj/görsel modalları, aç-kapat,
  // sıfırlama ve yenileme. Tüm "welcome_panel_" customId'leri burada.
  // -------------------------------------------------------------------
  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId === "welcome_panel_channel"
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const channelId = interaction.values[0];
    await updateGuildWelcomeConfig(interaction.guildId!, { channelId });
    await interaction
      .update(v2Payload(await buildWelcomePanelView(interaction.guildId!)))
      .catch(() => null);
    return;
  }

  if (
    interaction.isButton() &&
    (interaction.customId === "welcome_panel_msg_welcome" ||
      interaction.customId === "welcome_panel_msg_leave")
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const side =
      interaction.customId === "welcome_panel_msg_welcome"
        ? "welcome"
        : "leave";
    const cfg = await getGuildWelcomeConfig(interaction.guildId!);
    const current = (side === "welcome" ? cfg.message : cfg.leaveMessage) ?? "";
    const modal = new ModalBuilder()
      .setCustomId(`welcome_panel_submit_msg_${side}`)
      .setTitle(side === "welcome" ? "Giriş Mesajı" : "Çıkış Mesajı");
    const input = new TextInputBuilder()
      .setCustomId("value")
      .setLabel(resolveEmojis("Mesaj metni ({n} {kullanici} {isim} {sunucu})"))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(MAX_TEMPLATE_LENGTH);
    if (current) input.setValue(current);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
    await interaction.showModal(modal).catch(() => null);
    return;
  }

  if (
    interaction.isModalSubmit() &&
    (interaction.customId === "welcome_panel_submit_msg_welcome" ||
      interaction.customId === "welcome_panel_submit_msg_leave")
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const side =
      interaction.customId === "welcome_panel_submit_msg_welcome"
        ? "welcome"
        : "leave";
    const value = interaction.fields.getTextInputValue("value").trim();
    if (!value) {
      await interaction
        .reply(v2Payload({ content: MSG.error("Mesaj boş olamaz."), ephemeral: true }))
        .catch(() => null);
      return;
    }
    if (isTemplateTooLong(value)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Mesaj çok uzun. En fazla ${MAX_TEMPLATE_LENGTH} karakter olabilir.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuildWelcomeConfig(
      interaction.guildId!,
      side === "welcome" ? { message: value } : { leaveMessage: value },
    );
    await interaction
      .reply(v2Payload({
        content: `${EMOJIS.success} ${side === "welcome" ? "Giriş" : "Çıkış"} mesajı kaydedildi. Paneli görmek için \`Yenile\`ye bas.`,
        ephemeral: true,
      }))
      .catch(() => null);
    return;
  }

  if (
    interaction.isButton() &&
    (interaction.customId === "welcome_panel_img_welcome" ||
      interaction.customId === "welcome_panel_img_leave")
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const side =
      interaction.customId === "welcome_panel_img_welcome"
        ? "welcome"
        : "leave";
    const cfg = await getGuildWelcomeConfig(interaction.guildId!);
    const current =
      (side === "welcome" ? cfg.welcomeImage : cfg.leaveImage) ?? "";
    const modal = new ModalBuilder()
      .setCustomId(`welcome_panel_submit_img_${side}`)
      .setTitle(side === "welcome" ? "Giriş Görseli" : "Çıkış Görseli");
    const input = new TextInputBuilder()
      .setCustomId("value")
      .setLabel(resolveEmojis("Resim URL'si (boş bırak = kaldır)"))
      .setPlaceholder(resolveEmojis("https://..."))
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(500);
    if (current) input.setValue(current);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
    await interaction.showModal(modal).catch(() => null);
    return;
  }

  if (
    interaction.isModalSubmit() &&
    (interaction.customId === "welcome_panel_submit_img_welcome" ||
      interaction.customId === "welcome_panel_submit_img_leave")
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const side =
      interaction.customId === "welcome_panel_submit_img_welcome"
        ? "welcome"
        : "leave";
    const raw = interaction.fields.getTextInputValue("value").trim();
    if (raw && !/^https?:\/\/\S+$/i.test(raw)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Geçerli bir http(s):// resim linki gir, ya da boş bırakıp kaydet.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuildWelcomeConfig(
      interaction.guildId!,
      side === "welcome"
        ? { welcomeImage: raw || null }
        : { leaveImage: raw || null },
    );
    await interaction
      .reply(v2Payload({
        content: `${EMOJIS.success} ${side === "welcome" ? "Giriş" : "Çıkış"} görseli ${raw ? "kaydedildi" : "kaldırıldı"}. Paneli görmek için \`Yenile\`ye bas.`,
        ephemeral: true,
      }))
      .catch(() => null);
    return;
  }

  if (
    interaction.isButton() &&
    (interaction.customId === "welcome_panel_reset_welcome" ||
      interaction.customId === "welcome_panel_reset_leave")
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const side =
      interaction.customId === "welcome_panel_reset_welcome"
        ? "welcome"
        : "leave";
    await updateGuildWelcomeConfig(
      interaction.guildId!,
      side === "welcome"
        ? { message: null, welcomeImage: null }
        : { leaveMessage: null, leaveImage: null },
    );
    await interaction
      .update(v2Payload(await buildWelcomePanelView(interaction.guildId!)))
      .catch(() => null);
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId === "welcome_panel_toggle"
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const cfg = await getGuildWelcomeConfig(interaction.guildId!);
    if (!cfg.enabled && (!cfg.channelId || !cfg.message)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Sistemi açmadan önce bir kanal ve giriş mesajı ayarlamalısın.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await updateGuildWelcomeConfig(interaction.guildId!, {
      enabled: !cfg.enabled,
    });
    await interaction
      .update(v2Payload(await buildWelcomePanelView(interaction.guildId!)))
      .catch(() => null);
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId === "welcome_panel_refresh"
  ) {
    if (!hasWelcomePanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            "Bu paneli kullanmak için Sunucuyu Yönet yetkisine ihtiyacın var.",
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await interaction
      .update(v2Payload(await buildWelcomePanelView(interaction.guildId!)))
      .catch(() => null);
    return;
  }

  // -------------------------------------------------------------------
  // -------------------------------------------------------------------
  // Log Category Sub-Menus
  // -------------------------------------------------------------------
  if (interaction.isButton() && interaction.customId.startsWith("panel_log_open_")) {
    if (
      !interaction.inGuild() ||
      (interaction.user.id !== OWNER_ID &&
        !isGuildOwner(interaction) &&
        (!isPanelOwner(interaction) || !interaction.memberPermissions?.has("ManageGuild")))
    ) {
      await interaction.reply(v2Payload({ content: MSG.error('Bu bölüm için "Sunucuyu Yönet" iznine sahip olman gerekiyor.'), ephemeral: true })).catch(() => null);
      return;
    }
    const categoryId = interaction.customId.replace("panel_log_open_", "");
    await interaction.update(v2Payload(await buildLogCategoryTab(interaction.guildId!, categoryId))).catch(() => null);
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel_log_back") {
    if (
      !interaction.inGuild() ||
      (interaction.user.id !== OWNER_ID &&
        !isGuildOwner(interaction) &&
        (!isPanelOwner(interaction) || !interaction.memberPermissions?.has("ManageGuild")))
    ) {
      await interaction.reply(v2Payload({ content: MSG.error('Yetkiniz yok.'), ephemeral: true })).catch(() => null);
      return;
    }
    await interaction.update(v2Payload(await buildLogTab(interaction.guildId!))).catch(() => null);
    return;
  }

  // !panel: sekme (tab) butonları — panel_tab_genel / panel_tab_mod / ...
  // -------------------------------------------------------------------
  if (interaction.isButton() && interaction.customId.startsWith("panel_tab_")) {
    if (!hasPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            'Paneli görüntülemek için "Üyeleri Yönet" iznine sahip olman gerekiyor.',
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      const tab = interaction.customId.replace("panel_tab_", "") as PanelTab;
      await interaction.update(v2Payload(
        buildPanelView(tab, {
          guild: interaction.guild,
          client: interaction.client,
        }),
      ));
    } catch (err) {
      console.error("panel sekmesi geçmedi la:", err);
    }
    return;
  }

  // -------------------------------------------------------------------
  // !panel: "Durum" sekmesindeki "Yenile" butonu — üye/kanal/rol sayısı ve
  // ping gibi anlık verileri günceller. panel_tab_info ile çakışmaması için
  // ayrı bir customId kullanıyor (aynı mesajda iki bileşen aynı customId'yi
  // paylaşamaz).
  // -------------------------------------------------------------------
  if (interaction.isButton() && interaction.customId === "panel_refresh_info") {
    if (!hasPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error("Paneli görüntüleme iznin yok."),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      await interaction.update(v2Payload(
        buildPanelView("info", {
          guild: interaction.guild,
          client: interaction.client,
        }),
      ));
    } catch (err) {
      console.error("durum yenilenemedi:", err);
    }
    return;
  }

  // -------------------------------------------------------------------
  // !panel: "Durum" sekmesindeki "Log Kanalları" butonu — modal değil,
  // doğrudan görünümü Log Kanalları alt-sekmesine günceller (interaction.update).
  // "panel_open_" öneki genel modal yönlendirmesine ayrıldığı için burada
  // kasıtlı olarak farklı bir önek ("panel_shortcut_") kullanılıyor.
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId === "panel_shortcut_logpanel"
  ) {
    if (
      !interaction.inGuild() ||
      (interaction.user.id !== OWNER_ID &&
        !isGuildOwner(interaction) &&
        (!isPanelOwner(interaction) ||
          !interaction.memberPermissions?.has("ManageGuild")))
    ) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            'Bu bölüm için "Sunucuyu Yönet" iznine sahip olman gerekiyor.',
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      await interaction.update(v2Payload(await buildLogTab(interaction.guildId!)));
    } catch (err) {
      console.error("log paneli açılmadı:", err);
    }
    return;
  }

  // !panel: "Durum" sekmesindeki "Diğer Kanallar" butonu — log kategorisi
  // sayılmayan tek-kanal ayarlarını (ceza logları vb.) gösterir.
  // "Log Kanalları" ile aynı desen: "panel_shortcut_" öneki + interaction.update.
  if (
    interaction.isButton() &&
    interaction.customId === "panel_shortcut_extrapanel"
  ) {
    if (
      !interaction.inGuild() ||
      (interaction.user.id !== OWNER_ID &&
        !isGuildOwner(interaction) &&
        (!isPanelOwner(interaction) ||
          !interaction.memberPermissions?.has("ManageGuild")))
    ) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            'Bu bölüm için "Sunucuyu Yönet" iznine sahip olman gerekiyor.',
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      await interaction.update(v2Payload(
        await buildExtraChannelsTab(interaction.guildId!),
      ));
    } catch (err) {
      console.error("diğer kanallar paneli açılmadı:", err);
    }
    return;
  }

  // Log Kanalları / Diğer Kanallar alt-sekmelerindeki "Geri" butonu — Durum sekmesine döner.
  if (
    interaction.isButton() &&
    interaction.customId === "panel_shortcut_infoback"
  ) {
    if (!hasPanelAccess(interaction)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error("Paneli görüntüleme iznin yok."),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      await interaction.update(v2Payload(
        buildPanelView("info", {
          guild: interaction.guild,
          client: interaction.client,
        }),
      ));
    } catch (err) {
      console.error("log paneline dönülemedi:", err);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Genel: Duyuru Gönder — 1. adım, kanal seçimi (panel_duyuru_open)
  // -------------------------------------------------------------------
  if (interaction.isButton() && interaction.customId === "panel_duyuru_open") {
    if (!hasActionPermission(interaction, "duyuru")) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Duyuru göndermek için ${permissionLabelFor("duyuru")} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId("panel_duyuru_channel")
      .setPlaceholder(resolveEmojis("📢 Duyurunun gönderileceği kanalı seç..."))
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1);
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      channelSelect,
    );
    await interaction
      .reply(v2Payload({
        content: "Duyurunun gönderileceği kanalı seç:",
        components: [row],
        ephemeral: true,
      }))
      .catch(() => null);
    return;
  }

  // -------------------------------------------------------------------
  // Genel: Duyuru Gönder — 2. adım, kanal seçildi, içerik modalı açılır
  // (panel_duyuru_channel). Kanal ID'si sonraki adıma modal customId'sinin
  // içine gömülerek taşınıyor (panel_submit_duyuru_<channelId>).
  // -------------------------------------------------------------------
  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId === "panel_duyuru_channel"
  ) {
    if (!hasActionPermission(interaction, "duyuru")) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Duyuru göndermek için ${permissionLabelFor("duyuru")} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const channelId = interaction.values[0];
    if (!channelId) {
      await interaction
        .reply(v2Payload({ content: MSG.error("Bir kanal seçmedin."), ephemeral: true }))
        .catch(() => null);
      return;
    }
    const modal = buildModal(
      `panel_submit_duyuru_${channelId}`,
      "Duyuru İçeriği",
      [
        textInput("baslik", "Başlık", {
          placeholder: "ör. Sunucu Güncellemesi",
          required: true,
          maxLength: 256,
        }),
        textInput("icerik", "İçerik", {
          long: true,
          required: true,
          maxLength: 4_000,
        }),
      ],
    );
    await interaction.showModal(modal).catch(() => null);
    return;
  }

  // -------------------------------------------------------------------
  // Genel: Duyuru Gönder — 3. adım, modal gönderimi
  // (panel_submit_duyuru_<channelId>). ÖNEMLİ: bu blok, aşağıdaki genel
  // "panel_submit_" işleyicisinden ÖNCE gelmeli — customId aynı önekle
  // başlıyor ("panel_submit_") ama sonuna kanal ID'si ekli.
  // -------------------------------------------------------------------
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("panel_submit_duyuru_")
  ) {
    if (!interaction.inGuild()) return;
    if (!hasActionPermission(interaction, "duyuru")) {
      await interaction
        .reply(v2Payload({
          content: `${EMOJIS.error} Duyuru göndermek için ${permissionLabelFor("duyuru")} iznine sahip olman gerekiyor.`,
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const channelId = interaction.customId.replace("panel_submit_duyuru_", "");
    try {
      await interaction.deferReply({ ephemeral: true });
      const channel = await interaction
        .guild!.channels.fetch(channelId)
        .catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply(v2Payload(
          MSG.error("Seçilen kanal bulunamadı veya bir metin kanalı değil."),
        ));
        return;
      }
      const baslik = interaction.fields.getTextInputValue("baslik");
      const icerik = interaction.fields.getTextInputValue("icerik");
      const announceEmbed = new V2CardBuilder()
        .setColor(0xd0a840)
        .setTitle(`📢 ${baslik}`)
        .setDescription(icerik)
        .setFooter({ text: `Gönderen: ${interaction.user.tag}` })
        .setTimestamp();
      await channel.send(v2Payload({
        components: [announceEmbed],
        allowedMentions: { parse: [] },
      }));
      await interaction.editReply(v2Payload(
        MSG.success(`Duyuru <#${channelId}> kanalına gönderildi.`),
      ));
    } catch (err) {
      console.error("duyuru gitmedi la:", err);
      await interaction
        .editReply(v2Payload(
          MSG.error(
            "Duyuru gönderilirken bir hata oluştu — kanala yazma iznim olmayabilir.",
          ),
        ))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Rol Filtresi butonu (panel_bulksilme_rolefilter)
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId === "panel_bulksilme_rolefilter"
  ) {
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const builder = MODAL_BUILDERS["bulksilme_rolefilter"];
    if (builder) {
      await interaction.showModal(builder()).catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Rol Filtresi Modal Submit (panel_submit_bulksilme_rolefilter)
  // -------------------------------------------------------------------
  if (
    interaction.isModalSubmit() &&
    interaction.customId === "panel_submit_bulksilme_rolefilter"
  ) {
    if (!interaction.inGuild()) return;
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });

      const filter = interaction.fields
        .getTextInputValue("filter")
        .trim()
        .toLowerCase();
      if (!filter) {
        await interaction.editReply(v2Payload(MSG.error("Filtre metni boş olamaz.")));
        return;
      }

      // Sunucudan tüm rolleri getir
      const roles = await interaction.guild!.roles.fetch().catch(() => null);
      if (!roles || roles.size === 0) {
        await interaction.editReply(v2Payload(MSG.error("Sunucuda hiç rol bulunamadı.")));
        return;
      }

      // Filtreleme: rol adında veya emojisinde filter string'ini içeren rolleri bul.
      // NOT: role.icon özel yüklenmiş rol ikonunun hash'idir (ör. "a1b2c3..."),
      // emoji karakteri değildir — unicode emoji için role.unicodeEmoji kullanılmalı,
      // yoksa 💎 gibi bir emoji hiçbir zaman eşleşmez.
      const matchedRoles = roles.filter((role) => {
        const name = role.name.toLowerCase();
        const emoji = role.unicodeEmoji || "";
        return name.includes(filter) || emoji.includes(filter);
      });

      if (matchedRoles.size === 0) {
        await interaction.editReply(v2Payload(
          MSG.error(`"${filter}" ile eşleşen rol bulunamadı.`),
        ));
        return;
      }

      // Eşleşen rolleri listele ve select menüsünde göster
      const roleList = matchedRoles.map((r) => `${r.name}`).join("\n");
      const listEmbed = new V2CardBuilder()
        .setColor(0xd0a840)
        .setTitle(MSG.info("Rol Filtresi Sonuçları"))
        .setDescription(
          `**Filtre:** \`${filter}\`\n\n**Bulunan Roller (${matchedRoles.size}):**\n${roleList.slice(0, 3_600)}${roleList.length > 3_600 ? "\n… (liste kısaltıldı)" : ""}`,
        )
        .setFooter({ text: "Aşağıdan bu rolleri seç (hepsi önceden işaretli)" })
        .setTimestamp();

      // Rol seçim menüsü (eşleşen rolleri setDefaultRoles ile önceden seçilmiş göster)
      const defaultRoleIds = matchedRoles.first(25).map((r) => r.id);
      const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId("panel_bulksilme_roles_filtered")
        .setPlaceholder(resolveEmojis("Seçili rolleri kişiselleştir..."))
        .setMinValues(0)
        .setMaxValues(Math.min(25, matchedRoles.size))
        .setDefaultRoles(...defaultRoleIds);

      const roleRow =
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

      const confirmButton = new ButtonBuilder()
        .setCustomId("panel_bulksilme_filtered_confirm")
        .setLabel(resolveEmojis("Seçimleri Kaydet"))
        .setEmoji(EMOJIS.success)
        .setStyle(ButtonStyle.Success);

      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        confirmButton,
      );

      await interaction.editReply(v2Payload({
        components: [listEmbed, roleRow, confirmRow],
      }));
    } catch (err) {
      console.error("rol filtresi patladı:", err);
      await interaction
        .editReply(v2Payload(MSG.error("Rol filtresi sırasında bir hata oluştu.")))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Tüm Roller butonu (panel_bulksilme_roledirect)
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId === "panel_bulksilme_roledirect"
  ) {
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      await interaction.deferReply({ ephemeral: true });

      const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId("panel_bulksilme_roles")
        .setPlaceholder(resolveEmojis("👤 Silinecek rolleri seç..."))
        .setMinValues(0)
        .setMaxValues(25);

      const roleRow =
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

      await interaction.editReply(v2Payload({
        content: "Silinecek rolleri seç:",
        components: [roleRow],
      }));
    } catch (err) {
      console.error("rol seçim patladı:", err);
      await interaction
        .editReply(v2Payload(MSG.error("Rol seçim menüsü açılırken bir hata oluştu.")))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Filtrelenmiş rolleri kaydet (panel_bulksilme_filtered_confirm)
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId === "panel_bulksilme_filtered_confirm"
  ) {
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    await interaction.update(v2Payload(buildPanelView("bulksilme"))).catch(() => null);
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Kanal seçimi (panel_bulksilme_channels)
  // -------------------------------------------------------------------
  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId === "panel_bulksilme_channels"
  ) {
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const selectionKey = bulkSelectionKey(interaction);
    const selection = getBulkSelection(selectionKey) || {
      channels: [],
      roles: [],
    };
    selection.channels = interaction.values;
    saveBulkSelection(selectionKey, selection);
    await interaction.deferUpdate().catch(() => null);
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Filtrelenmiş rol seçimi (panel_bulksilme_roles_filtered)
  // -------------------------------------------------------------------
  if (
    interaction.isRoleSelectMenu() &&
    interaction.customId === "panel_bulksilme_roles_filtered"
  ) {
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: `${EMOJIS.error} Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const selectionKey = bulkSelectionKey(interaction);
    const selection = getBulkSelection(selectionKey) || {
      channels: [],
      roles: [],
    };
    selection.roles = interaction.values;
    saveBulkSelection(selectionKey, selection);

    await interaction.update(v2Payload(buildPanelView("bulksilme"))).catch(() => null);
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Rol seçimi (panel_bulksilme_roles)
  // -------------------------------------------------------------------
  if (
    interaction.isRoleSelectMenu() &&
    interaction.customId === "panel_bulksilme_roles"
  ) {
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: `${EMOJIS.error} Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const selectionKey = bulkSelectionKey(interaction);
    const selection = getBulkSelection(selectionKey) || {
      channels: [],
      roles: [],
    };
    selection.roles = interaction.values;
    saveBulkSelection(selectionKey, selection);

    await interaction.update(v2Payload(buildPanelView("bulksilme"))).catch(() => null);
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: Silme işlemini onayla (panel_bulksilme_confirm)
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId === "panel_bulksilme_confirm"
  ) {
    if (!interaction.inGuild()) return;
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: `${EMOJIS.error} Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }

    try {
      const selectionKey = bulkSelectionKey(interaction);
      const selection = getBulkSelection(selectionKey);

      if (
        !selection ||
        (selection.channels.length === 0 && selection.roles.length === 0)
      ) {
        await interaction
          .reply(v2Payload({
            content: MSG.error(
              "Hiçbir kanal veya rol seçilmedi. Lütfen silmek istediğin kanalları ve/veya rolleri seç.",
            ),
            ephemeral: true,
          }))
          .catch(() => null);
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const guild = interaction.guild!;
      const deletedChannels: string[] = [];
      const failedChannels: string[] = [];
      const deletedRoles: string[] = [];
      const failedRoles: string[] = [];

      // Kanalları sil
      for (const channelId of selection.channels) {
        try {
          const channel = await guild.channels
            .fetch(channelId)
            .catch(() => null);
          if (channel) {
            await channel.delete(
              `${interaction.user.tag} (panel): Toplu silme`,
            );
            deletedChannels.push(`<#${channelId}>`);
          }
        } catch (err) {
          console.error(`kanal silinemedi (${channelId}):`, err);
          failedChannels.push(channelId);
        }
      }

      // Rolleri sil
      for (const roleId of selection.roles) {
        try {
          const role = await guild.roles.fetch(roleId).catch(() => null);
          if (role) {
            await role.delete(`${interaction.user.tag} (panel): Toplu silme`);
            deletedRoles.push(`<@&${roleId}>`);
          }
        } catch (err) {
          console.error(`rol silinemedi (${roleId}):`, err);
          failedRoles.push(roleId);
        }
      }

      // Sonuç embed'i
      const resultEmbed = new V2CardBuilder()
        .setColor(
          deletedChannels.length > 0 || deletedRoles.length > 0
            ? 0x57f287
            : 0xed4245,
        )
        .setTitle("🗑️ Toplu Silme İşlemi Tamamlandı")
        .setDescription(
          [
            deletedChannels.length > 0
              ? `${EMOJIS.success} **Silinen Kanallar (${deletedChannels.length}):**\n${deletedChannels.slice(0, 10).join(", ")}${deletedChannels.length > 10 ? `\n...+${deletedChannels.length - 10} kanal daha` : ""}`
              : "",
            deletedRoles.length > 0
              ? `${EMOJIS.success} **Silinen Roller (${deletedRoles.length}):**\n${deletedRoles.slice(0, 10).join(", ")}${deletedRoles.length > 10 ? `\n...+${deletedRoles.length - 10} rol daha` : ""}`
              : "",
            failedChannels.length > 0 || failedRoles.length > 0
              ? `${EMOJIS.alert} **Hata:**\n${failedChannels.length > 0 ? `${failedChannels.length} kanal silinemedi\n` : ""}${failedRoles.length > 0 ? `${failedRoles.length} rol silinemedi` : ""}`
              : "",
          ]
            .filter((x) => x)
            .join("\n\n") || "Hiçbir kanal veya rol silinmedi.",
        )
        .setFooter({ text: `İşlemi yapan: ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.editReply(v2Payload({ components: [resultEmbed] })).catch(() => null);

      // Seçimleri temizle
      deleteBulkSelection(selectionKey);
    } catch (err) {
      console.error("toplu silme patladı:", err);
      await interaction
        .editReply(v2Payload(MSG.error("Toplu silme işlemi sırasında bir hata oluştu.")))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Toplu silme: İptal et (panel_bulksilme_cancel)
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId === "panel_bulksilme_cancel"
  ) {
    if (!hasActionPermission(interaction, "bulksilme")) {
      await interaction
        .reply(v2Payload({
          content: `${EMOJIS.error} Toplu silme işlemi için ${permissionLabelFor("bulksilme")} iznine sahip olman gerekiyor.`,
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    try {
      deleteBulkSelection(bulkSelectionKey(interaction));
      await interaction.update(v2Payload(buildPanelView("mod")));
    } catch (err) {
      console.error("toplu silme iptali patladı:", err);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Panel: Modal açma butonları (panel_open_* kalıbı)
  // Panel_open_* butonları, sahip olduğu aksiyonun modali varsa, onu açar.
  // Aksiyonun izni yoksa hata verir.
  // -------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId.startsWith("panel_open_")
  ) {
    const action = interaction.customId.replace("panel_open_", "");
    if (!hasActionPermission(interaction, action)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Bu işlem için ${permissionLabelFor(action)} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }
    const builder = MODAL_BUILDERS[action];
    if (builder) {
      await interaction.showModal(builder()).catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Panel: Modal gönderimi işlemleri (panel_submit_* kalıbı)
  // Her modal form, panel_submit_<action> olarak geri döner.
  // -------------------------------------------------------------------
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("panel_submit_")
  ) {
    if (!interaction.inGuild()) return;

    const action = interaction.customId.replace("panel_submit_", "");
    if (!hasActionPermission(interaction, action)) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            `Bu işlem için ${permissionLabelFor(action)} iznine sahip olman gerekiyor.`,
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });

      // -----------------------------------------------------------------
      // Moderasyon (ban / kick / mute / unmute / unban / warn)
      // -----------------------------------------------------------------
      if (
        action === "ban" ||
        action === "kick" ||
        action === "mute" ||
        action === "unmute" ||
        action === "unban" ||
        action === "warn"
      ) {
        const rawUserId = safeGetField(interaction, "userId");
        const userId = parseUserId(rawUserId);
        if (!userId) {
          await interaction.editReply(v2Payload(MSG.error("Geçersiz kullanıcı ID'si.")));
          return;
        }

        const guild = interaction.guild!;

        if (action === "ban") {
          const identityError = panelTargetIdentityError(interaction, userId);
          if (identityError) {
            await interaction.editReply(v2Payload(MSG.error(identityError)));
            return;
          }
          const botMember = guild.members.me;
          if (
            interaction.user.id !== OWNER_ID &&
            !botMember?.permissions.has(PermissionFlagsBits.BanMembers)
          ) {
            await interaction.editReply(v2Payload(
              MSG.error(
                "Bu kullanıcıyı yasaklayamam. Botun Üyeleri Yasakla izni yok.",
              ),
            ));
            return;
          }
          const targetMember = await guild.members
            .fetch(userId)
            .catch(() => null);
          if (targetMember) {
            const botBlock = getBotModerationBlockReason(
              botMember,
              targetMember,
              PermissionFlagsBits.BanMembers,
              interaction.user.id,
            );
            if (botBlock) {
              await interaction.editReply(v2Payload(
                MSG.error(botModerationBlockMessage(botBlock, "yasaklayamam")),
              ));
              return;
            }
            const executor = await guild.members
              .fetch(interaction.user.id)
              .catch(() => null);
            if (!executor || !canModerate(executor, targetMember)) {
              await interaction.editReply(v2Payload(
                MSG.error(
                  "Bu kullanıcının rolü seninkiyle aynı ya da daha yüksek.",
                ),
              ));
              return;
            }
          }
          const reason = panelReason(interaction);
          await guild.members.ban(userId, {
            reason: `${interaction.user.tag} (panel): ${reason}`,
          });
          await interaction.editReply(v2Payload(
            MSG.success(`<@${userId}> banlandı.\n**Sebep:** ${reason}`),
          ));
          return;
        }

        if (action === "unban") {
          const identityError = panelTargetIdentityError(interaction, userId);
          if (identityError && userId !== interaction.user.id) {
            await interaction.editReply(v2Payload(MSG.error(identityError)));
            return;
          }
          const reason = panelReason(interaction);
          await guild.members.unban(
            userId,
            `${interaction.user.tag} (panel): ${reason}`,
          );
          await interaction.editReply(v2Payload(
            MSG.success(`<@${userId}> kişisinin banı kaldırıldı.`),
          ));
          return;
        }

        const permission =
          action === "kick"
            ? PermissionFlagsBits.KickMembers
            : PermissionFlagsBits.ModerateMembers;
        const validation = await validatePanelMember(
          interaction,
          userId,
          permission,
          action === "kick"
            ? "atamam"
            : action === "mute" || action === "unmute"
              ? "susturamam"
              : "uyaramam",
        );
        if (validation.error || !validation.member) {
          await interaction.editReply(v2Payload(
            MSG.error(validation.error ?? "Hedef kullanıcı doğrulanamadı."),
          ));
          return;
        }
        const member = validation.member;

        if (action === "kick") {
          const reason = panelReason(interaction);
          await member.kick(`${interaction.user.tag} (panel): ${reason}`);
          await interaction.editReply(v2Payload(
            MSG.success(`<@${userId}> sunucudan atıldı.\n**Sebep:** ${reason}`),
          ));
          return;
        }

        if (action === "mute") {
          const durationRaw = safeGetField(interaction, "duration").trim();
          const minutes = Number(durationRaw);
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40_320) {
            await interaction.editReply(v2Payload(
              MSG.error(
                "Süre 1 ile 40.320 dakika arasında tam sayı olmalı (ör. 60).",
              ),
            ));
            return;
          }
          const reason = panelReason(interaction);
          await member.timeout(
            minutes * 60_000,
            `${interaction.user.tag} (panel): ${reason}`,
          );
          await interaction.editReply(v2Payload(
            MSG.success(
              `<@${userId}> ${minutes} dakika susturuldu.\n**Sebep:** ${reason}`,
            ),
          ));
          return;
        }

        if (action === "unmute") {
          if (
            !member.communicationDisabledUntilTimestamp ||
            member.communicationDisabledUntilTimestamp <= Date.now()
          ) {
            await interaction.editReply(v2Payload(
              MSG.info(`<@${userId}> zaten susturulmuş değil.`),
            ));
            return;
          }
          const reason = panelReason(interaction);
          await member.timeout(
            null,
            `${interaction.user.tag} (panel): ${reason}`,
          );
          await interaction.editReply(v2Payload(
            MSG.success(`<@${userId}> kişisinin susturması kaldırıldı.`),
          ));
          return;
        }

        const warnReason = panelReason(interaction);
        await db.insert(warningsTable).values({
          guildId: guild.id,
          userId,
          moderatorId: interaction.user.id,
          reason: warnReason,
        });
        const totalWarnings = await db
          .select()
          .from(warningsTable)
          .where(
            and(
              eq(warningsTable.userId, userId),
              eq(warningsTable.guildId, guild.id),
            ),
          );
        await interaction.editReply(v2Payload(
          MSG.success(
            `<@${userId}> uyarıldı (toplam ${totalWarnings.length}. uyarı).\n**Sebep:** ${warnReason}`,
          ),
        ));
        return;
      }

      // -----------------------------------------------------------------
      // Üye yönetimi (bir kullanıcının kayıtlı uyarılarını görüntüle)
      // -----------------------------------------------------------------
      if (action === "uyarigor") {
        const rawUserId = interaction.fields.getTextInputValue("userId");
        const userId = parseUserId(rawUserId);
        if (!userId) {
          await interaction.editReply(v2Payload(MSG.error("Geçersiz kullanıcı ID'si.")));
          return;
        }
        const rows = await db
          .select()
          .from(warningsTable)
          .where(
            and(
              eq(warningsTable.userId, userId),
              eq(warningsTable.guildId, interaction.guild!.id),
            ),
          );
        if (rows.length === 0) {
          await interaction.editReply(v2Payload(
            MSG.info(
              `<@${userId}> kişisinin bu sunucuda kayıtlı bir uyarısı yok.`,
            ),
          ));
          return;
        }
        const gosterilecek = rows.slice(-10);
        const list = gosterilecek
          .map(
            (w: typeof warningsTable.$inferSelect, i: number) =>
              `**${i + 1}.** ${w.reason || "*(sebep belirtilmemiş)*"} — <@${w.moderatorId}>`,
          )
          .join("\n");
        const warnListEmbed = new V2CardBuilder()
          .setColor(0xfee75c)
          .setTitle(MSG.info(`<@${userId}> — Uyarılar (${rows.length})`))
          .setDescription(
            rows.length > gosterilecek.length
              ? `${list}\n\n...+${rows.length - gosterilecek.length} uyarı daha`
              : list,
          )
          .setTimestamp();
        await interaction.editReply(v2Payload({ components: [warnListEmbed] }));
        return;
      }

      // -----------------------------------------------------------------
      // Üye yönetimi (özel üye toggle)
      // -----------------------------------------------------------------
      if (action === "ozelde") {
        const rawUserId = interaction.fields.getTextInputValue("userId");
        const userId = parseUserId(rawUserId);
        if (!userId) {
          await interaction.editReply(v2Payload(MSG.error("Geçersiz kullanıcı ID'si.")));
          return;
        }
        const isNowVip = await toggleVipById(userId);
        await interaction.editReply(v2Payload(
          isNowVip
            ? MSG.success(`<@${userId}> artık özel üye!`)
            : MSG.info(`<@${userId}> kişisinin özel üyeliği geri çekildi.`),
        ));
        return;
      }

      await interaction.editReply(v2Payload(MSG.error("Bilinmeyen aksiyon.")));
    } catch (err) {
      console.error("panel modal patladı:", err);
      await interaction
        .editReply(v2Payload(
          MSG.error(
            "İşlem sırasında bir hata oldu — yetkim olmayabilir ya da kullanıcı bulunamadı.",
          ),
        ))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Log Kanalları menüleri (panel_log_* kalıbı)
  // -------------------------------------------------------------------
  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId.startsWith("panel_log_")
  ) {
    if (
      !interaction.inGuild() ||
      (interaction.user.id !== OWNER_ID &&
        !isGuildOwner(interaction) &&
        (!isPanelOwner(interaction) ||
          !interaction.memberPermissions?.has("ManageGuild")))
    ) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            'Bu bölüm için "Sunucuyu Yönet" iznine sahip olman gerekiyor.',
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }

    const categoryId = interaction.customId.replace(
      "panel_log_",
      "",
    ) as LogCategory;
    const channelId = interaction.values?.[0] ?? null;

    try {
      await setLogChannel(interaction.guildId!, categoryId, channelId);
      // deferUpdate() sadece etkileşimi onaylar, mesajı DEĞİŞTİRMEZ — bu yüzden
      // panel eskiden "ayarlanmamış" yazmaya devam ediyordu. Paneli güncel
      // ayarlarla yeniden çizip interaction.update(v2Payload()) ile göndermek gerekiyor.
      await interaction
        .update(v2Payload(await buildLogTab(interaction.guildId!)))
        .catch(() => null);
    } catch (err) {
      console.error("log kanalı ayarlanamadı:", err);
      await interaction
        .reply(v2Payload({
          content: MSG.error("Kanal ayarı yapılırken bir hata oldu."),
          ephemeral: true,
        }))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Diğer Kanallar menüleri (panel_chset_* kalıbı) — panel_log_* ile aynı desen.
  // -------------------------------------------------------------------
  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId.startsWith("panel_chset_")
  ) {
    if (
      !interaction.inGuild() ||
      (interaction.user.id !== OWNER_ID &&
        !isGuildOwner(interaction) &&
        (!isPanelOwner(interaction) ||
          !interaction.memberPermissions?.has("ManageGuild")))
    ) {
      await interaction
        .reply(v2Payload({
          content: MSG.error(
            'Bu bölüm için "Sunucuyu Yönet" iznine sahip olman gerekiyor.',
          ),
          ephemeral: true,
        }))
        .catch(() => null);
      return;
    }

    const settingId = interaction.customId.replace(
      "panel_chset_",
      "",
    ) as ChannelSettingId;
    const channelId = interaction.values?.[0] ?? null;

    try {
      await setChannelSetting(interaction.guildId!, settingId, channelId);
      await interaction
        .update(v2Payload(await buildExtraChannelsTab(interaction.guildId!)))
        .catch(() => null);
    } catch (err) {
      console.error("kanal ayarı yapılamadı:", err);
      await interaction
        .reply(v2Payload({
          content: MSG.error("Kanal ayarı yapılırken bir hata oldu."),
          ephemeral: true,
        }))
        .catch(() => null);
    }
    return;
  }

  // -------------------------------------------------------------------
  // Mevcut: slash komutları (değişmedi)
  // -------------------------------------------------------------------
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command?.slashExecute) {
    console.warn(
      `kayıtsız slash komut geldi: /${interaction.commandName}`,
    );
    await interaction
      .reply(v2Payload({
        content: MSG.error(
          "Bu slash komutu artık aktif değil. Komutlar yeniden senkronize ediliyor.",
        ),
        ephemeral: true,
      }))
      .catch(() => null);
    return;
  }

  // Genel komut rate-limit (slash). Owner muaf.
  {
    const { checkCommandRateLimit } = await import("../utils/rateLimit.js");
    if (
      !(await checkCommandRateLimit(
        interaction,
        interaction.user.id,
        interaction.commandName,
      ))
    ) {
      return;
    }
  }

  let success = true;
  try {
    await command.slashExecute(interaction);
  } catch (err) {
    success = false;
    console.error(`slash komut patladı (${interaction.commandName}):`, err);
    const embed = errorEmbed(
      "Bir Hata Oluştu",
      "Komut çalıştırılırken bir hata oluştu.",
    );
    if (interaction.replied || interaction.deferred) {
      await interaction
        .followUp(v2Payload({ components: [embed], ephemeral: true }))
        .catch(() => null);
    } else {
      await interaction
        .reply(v2Payload({ components: [embed], ephemeral: true }))
        .catch(() => null);
    }
  }
  void notifyOwnerCommandUsed(interaction.client, {
    commandName: interaction.commandName,
    user: interaction.user,
    guild: interaction.guild,
    success,
    source: "slash",
    detail: interaction.isChatInputCommand()
      ? interaction.options.data.map((o) => `${o.name}:${o.value ?? ""}`).join(" ")
      : undefined,
  });
}

/** Modalda olmayabilecek (opsiyonel) bir text input'u güvenle okur. */
function safeGetField(
  interaction: import("discord.js").ModalSubmitInteraction,
  customId: string,
): string {
  try {
    return interaction.fields.getTextInputValue(customId)?.trim() ?? "";
  } catch {
    return "";
  }
}
