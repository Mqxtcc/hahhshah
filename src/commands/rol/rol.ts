import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ContainerBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
  type Guild,
  type Role,
} from "discord.js";
import { V2CardBuilder } from "../../utils/componentsV2.js";
import type { Command } from "../../types.js";
import { successEmbed, errorEmbed, infoEmbed, COLORS } from "../../utils/embeds.js";
import { parseMention } from "../../utils/parse.js";
import { OWNER_ID } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { EMOJIS } from "../../utils/emojis.js";

// ---------------------------------------------------------------------------
// Yardımcı: string'den rol bul (mention, ID veya isim)
// ---------------------------------------------------------------------------
function findRole(guild: Guild, input: string): Role | undefined {
  const mentionId = input.match(/^<@&(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(input) ? input : null);
  if (mentionId) return guild.roles.cache.get(mentionId);
  return guild.roles.cache.find((r) => r.name.toLowerCase() === input.toLowerCase());
}

function getBotMember(guild: Guild) {
  return guild.members.me ?? null;
}

// ---------------------------------------------------------------------------
// Ortak işlem fonksiyonları
// ---------------------------------------------------------------------------
async function doEkle(
  guild: Guild,
  actorTag: string,
  targetId: string,
  role: Role,
): Promise<ContainerBuilder> {
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return errorEmbed("Kullanıcı Bulunamadı", "Bu kullanıcı sunucuda değil.");
  if (role.managed || role.id === guild.id) {
    return errorEmbed("Rol Yönetilemiyor", "Entegrasyon rolleri ve @everyone rolü elle yönetilemez.");
  }
  if (member.roles.cache.has(role.id))
    return errorEmbed("Zaten Var", `${member.user.tag} zaten **${role.name}** rolüne sahip.`);

  const me = getBotMember(guild);
  if (!me) return errorEmbed("Hata", "Bot üyesi bulunamadı.");
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
    return errorEmbed("Yetki Hatası", "Botun `Rolleri Yönet` yetkisi yok. Lütfen bot rolüne bu yetkiyi ver.");
  if (me.roles.highest.position <= role.position)
    return errorEmbed("Yetki Hatası", `**${role.name}** rolü botun en yüksek rolünden üstte veya eşit. Botun en yüksek rolü: **${me.roles.highest.name}** (pozisyon: ${me.roles.highest.position}), hedef rolün pozisyonu: ${role.position}`);

  try {
    await member.roles.add(role, `${actorTag} tarafından eklendi`);
    return successEmbed("Rol Eklendi", `**${role.name}** rolü ${member.user.tag} kullanıcısına eklendi.`);
  } catch (err: unknown) {
    const hasAdmin = me.permissions.has(PermissionFlagsBits.Administrator);
    const hasManage = me.permissions.has(PermissionFlagsBits.ManageRoles);
    const diag = [
      `Hata: ${err instanceof Error ? err.message : "Bilinmeyen hata"}`,
      `Botun en yüksek rolü: **${me.roles.highest.name}** (pos: ${me.roles.highest.position})`,
      `Hedef rol: **${role.name}** (pos: ${role.position}, managed: ${role.managed})`,
      `Yönetici: ${hasAdmin ? EMOJIS.success : EMOJIS.error} | Rolleri Yönet: ${hasManage ? EMOJIS.success : EMOJIS.error}`,
    ].join("\n");
    return errorEmbed("Discord Hatası", diag);
  }
}

async function doSil(
  guild: Guild,
  actorTag: string,
  targetId: string,
  role: Role,
): Promise<ContainerBuilder> {
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return errorEmbed("Kullanıcı Bulunamadı", "Bu kullanıcı sunucuda değil.");
  if (role.managed || role.id === guild.id) {
    return errorEmbed("Rol Yönetilemiyor", "Entegrasyon rolleri ve @everyone rolü elle yönetilemez.");
  }
  if (!member.roles.cache.has(role.id))
    return errorEmbed("Rol Yok", `${member.user.tag} zaten **${role.name}** rolüne sahip değil.`);

  const me = getBotMember(guild);
  if (!me) return errorEmbed("Hata", "Bot üyesi bulunamadı.");
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
    return errorEmbed("Yetki Hatası", "Botun `Rolleri Yönet` yetkisi yok. Lütfen bot rolüne bu yetkiyi ver.");
  if (me.roles.highest.position <= role.position)
    return errorEmbed("Yetki Hatası", `**${role.name}** rolü botun en yüksek rolünden üstte veya eşit. Botu daha üste taşı.`);

  try {
    await member.roles.remove(role, `${actorTag} tarafından kaldırıldı`);
    return successEmbed("Rol Kaldırıldı", `**${role.name}** rolü ${member.user.tag} kullanıcısından kaldırıldı.`);
  } catch (err: unknown) {
    return errorEmbed("Discord Hatası", `Rol kaldırılamadı: ${err instanceof Error ? err.message : "Bilinmeyen hata"}`);
  }
}

async function doOlustur(
  guild: Guild,
  actorTag: string,
  name: string,
  color?: string,
  hoist?: boolean,
): Promise<ContainerBuilder> {
  const me = getBotMember(guild);
  if (!me) return errorEmbed("Hata", "Bot üyesi bulunamadı.");
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
    return errorEmbed("Yetki Hatası", "Botun `Rolleri Yönet` yetkisi yok.");

  name = name.trim();
  if (!name || name.length > 100) {
    return errorEmbed("Geçersiz Rol Adı", "Rol adı 1–100 karakter arasında olmalı.");
  }

  // Renk doğrulama
  let resolvedColor: number | undefined;
  if (color) {
    const hex = color.startsWith("#") ? color : `#${color}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex))
      return errorEmbed("Geçersiz Renk", "Rengi `#ff0000` formatında yaz. Örnek: `!rol oluştur Moderatör #ff0000`");
    resolvedColor = parseInt(hex.slice(1), 16);
  }

  try {
    const role = await guild.roles.create({
      name,
      color: resolvedColor,
      hoist: hoist ?? false,
      reason: `${actorTag} tarafından oluşturuldu`,
    });
    return successEmbed(
      "Rol Oluşturuldu",
      `**${role.name}** rolü oluşturuldu.\nID: \`${role.id}\`\nRenk: ${role.hexColor}\nAyrı Gösterim: ${role.hoist ? "Evet" : "Hayır"}`,
    );
  } catch (err: unknown) {
    return errorEmbed("Discord Hatası", `Rol oluşturulamadı: ${err instanceof Error ? err.message : "Bilinmeyen hata"}`);
  }
}

function doBilgi(role: Role): ContainerBuilder {
  return new V2CardBuilder()
    .setColor((role.color || COLORS.info) as number)
    .setTitle(`${EMOJIS.role} Rol Bilgisi — ${role.name}`)
    .addFields(
      { name: "ID", value: role.id, inline: true },
      { name: "Renk", value: role.hexColor, inline: true },
      { name: "Üye Sayısı", value: `${role.members.size}`, inline: true },
      { name: "Sıra", value: `${role.position}`, inline: true },
      { name: "Mentionlanabilir", value: role.mentionable ? `Evet ${EMOJIS.success}` : `Hayır ${EMOJIS.error}`, inline: true },
      { name: "Ayrı Gösterim", value: role.hoist ? `Evet ${EMOJIS.success}` : `Hayır ${EMOJIS.error}`, inline: true },
      { name: "Oluşturulma", value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`, inline: true },
    );
}

function doListe(guild: Guild): ContainerBuilder {
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id) // @everyone hariç
    .sort((a, b) => b.position - a.position)
    .map((r) => `${r} — \`${r.id}\``)
    .slice(0, 30);

  return new V2CardBuilder()
    .setColor(COLORS.info)
    .setTitle(`${EMOJIS.role} ${guild.name} — Rol Listesi`)
    .setDescription(roles.join("\n") || "Rol bulunamadı.")
    .setFooter({ text: `${guild.roles.cache.size - 1} rol • En fazla 30 gösterilir` });
}

// ---------------------------------------------------------------------------
// Komut tanımı
// ---------------------------------------------------------------------------
const command: Command = {
  name: "rol",
  aliases: ["role"],
  description: "Rol yönetimi komutları",
  usage: "!rol <ekle|sil|bilgi|liste|oluştur> [kullanıcı] [rol]",
  category: "rol",

  // ── Slash komut yapısı ──────────────────────────────────────────────────
  slashData: new SlashCommandBuilder()
    .setName("rol")
    .setDescription("Rol yönetimi komutları")
    .addSubcommand((s) =>
      s
        .setName("ekle")
        .setDescription("Bir kullanıcıya rol ekle")
        .addUserOption((o) =>
          o.setName("kullanici").setDescription("Rol eklenecek kullanıcı").setRequired(true),
        )
        .addRoleOption((o) =>
          o.setName("rol").setDescription("Eklenecek rol").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("sil")
        .setDescription("Bir kullanıcıdan rol kaldır")
        .addUserOption((o) =>
          o.setName("kullanici").setDescription("Rolü alınacak kullanıcı").setRequired(true),
        )
        .addRoleOption((o) =>
          o.setName("rol").setDescription("Kaldırılacak rol").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("bilgi")
        .setDescription("Bir rolün bilgilerini göster")
        .addRoleOption((o) =>
          o.setName("rol").setDescription("Bilgisi gösterilecek rol").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName("liste").setDescription("Sunucudaki rolleri listele"),
    )
    .addSubcommand((s) =>
      s
        .setName("olustur")
        .setDescription("Yeni bir rol oluştur")
        .addStringOption((o) =>
          o.setName("isim").setDescription("Rolün adı").setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("renk").setDescription("Rol rengi (örn: #ff0000)").setRequired(false),
        )
        .addBooleanOption((o) =>
          o.setName("hoist").setDescription("Üye listesinde ayrı göster").setRequired(false),
        ),
    ),

  // ── Slash execute ───────────────────────────────────────────────────────
  async slashExecute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || (interaction.user.id !== OWNER_ID && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles))) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Yetersiz Yetki", "Bu komutu kullanmak için `Rolleri Yönet` yetkisi gerekiyor.")],
        ephemeral: true,
      });
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();

    if (sub === "ekle") {
      const target = interaction.options.getUser("kullanici", true);
      const role = interaction.options.getRole("rol", true) as Role;
      const embed = await doEkle(interaction.guild, interaction.user.tag, target.id, role);
      return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [embed] });
    }

    if (sub === "sil") {
      const target = interaction.options.getUser("kullanici", true);
      const role = interaction.options.getRole("rol", true) as Role;
      const embed = await doSil(interaction.guild, interaction.user.tag, target.id, role);
      return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [embed] });
    }

    if (sub === "bilgi") {
      const role = interaction.options.getRole("rol", true) as Role;
      return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [doBilgi(role)] });
    }

    if (sub === "liste") {
      return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [doListe(interaction.guild)] });
    }

    if (sub === "olustur") {
      const isim = interaction.options.getString("isim", true);
      const renk = interaction.options.getString("renk") ?? undefined;
      const hoist = interaction.options.getBoolean("hoist") ?? undefined;
      const embed = await doOlustur(interaction.guild, interaction.user.tag, isim, renk, hoist);
      return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [embed] });
    }

    return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Bilinmeyen Alt Komut", "Geçerli seçenekler: `ekle`, `sil`, `bilgi`, `liste`, `oluştur`")] });
  },

  // ── Prefix execute ──────────────────────────────────────────────────────
  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;
    const sub = args[0]?.toLocaleLowerCase("tr-TR");
    const prefix = getGuildPrefix(message.guild.id);

    const USAGE = `Kullanım:\n\`${prefix}rol ekle @kullanıcı @rol\`\n\`${prefix}rol sil @kullanıcı @rol\`\n\`${prefix}rol bilgi @rol\`\n\`${prefix}rol liste\`\n\`${prefix}rol oluştur <isim> [#renk]\``;

    if (!sub) {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [infoEmbed("Rol Komutları", USAGE)] });
    }

    // ekle / sil — ManageRoles gerekli
    if (sub === "ekle" || sub === "sil") {
      if (message.author.id !== OWNER_ID && !message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply({ flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Yetersiz Yetki", "Bu komutu kullanmak için `Rolleri Yönet` yetkisine sahip olman gerekiyor.")],
        });
      }

      const targetId = parseMention(args[1] ?? "");
      const roleInput = args.slice(2).join(" ");
      if (!targetId || !roleInput) {
        return message.reply({ flags: MessageFlags.IsComponentsV2,
          components: [
            errorEmbed(
              "Hatalı Kullanım",
              sub === "ekle"
                ? `\`${prefix}rol ekle @kullanıcı @rol\``
                : `\`${prefix}rol sil @kullanıcı @rol\``,
            ),
          ],
        });
      }

      const role = findRole(message.guild, roleInput);
      if (!role) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Rol Bulunamadı", `"${roleInput}" adında veya ID'sinde bir rol bulunamadı.`)] });
      }

      const embed =
        sub === "ekle"
          ? await doEkle(message.guild, message.author.tag, targetId, role)
          : await doSil(message.guild, message.author.tag, targetId, role);
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [embed] });
    }

    // bilgi
    if (sub === "bilgi") {
      const roleInput = args.slice(1).join(" ");
      if (!roleInput) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hatalı Kullanım", `\`${prefix}rol bilgi @rol\``)] });
      }
      const role = findRole(message.guild, roleInput);
      if (!role) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Rol Bulunamadı", `"${roleInput}" adında veya ID'sinde bir rol bulunamadı.`)] });
      }
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [doBilgi(role)] });
    }

    // liste
    if (sub === "liste") {
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [doListe(message.guild)] });
    }

    // oluştur
    if (sub === "oluştur" || sub === "olustur") {
      if (message.author.id !== OWNER_ID && !message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply({ flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Yetersiz Yetki", "Bu komutu kullanmak için `Rolleri Yönet` yetkisine sahip olman gerekiyor.")],
        });
      }
      const isim = args.slice(1).join(" ").split("#")[0].trim();
      const renkMatch = args.slice(1).join(" ").match(/#[0-9a-fA-F]{6}/i);
      const renk = renkMatch?.[0];
      if (!isim) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hatalı Kullanım", "`!rol oluştur <isim> [#renk]`\nÖrnek: `!rol oluştur Moderatör #ff0000`")] });
      }
      const embed = await doOlustur(message.guild, message.author.tag, isim, renk);
      return message.reply({ flags: MessageFlags.IsComponentsV2, components: [embed] });
    }

    return message.reply({ flags: MessageFlags.IsComponentsV2, components: [infoEmbed("Rol Komutları", USAGE)] });
  },
};

export default command;
