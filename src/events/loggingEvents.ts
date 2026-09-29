import {
  AttachmentBuilder,
  AuditLogEvent,
  ChannelType,
  Client,
  Events,
  type AnyThreadChannel,
  type GuildChannel,
  type GuildEmoji,
  type GuildMember,
  type Invite,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type Role,
  type Sticker,
  type VoiceState,
} from "discord.js";
import {
  baseLogEmbed,
  classifyMemberRemoval,
  findAuditExecutor,
  LOG_COLORS,
  sendLog,
  truncate,
} from "../utils/logger.js";
import { EMOJIS } from "../utils/emojis.js";
import type { V2CardBuilder } from "../utils/componentsV2.js";

// ---------------------------------------------------------------------------
// SUNUCU LOG SİSTEMİ — OLAY DİNLEYİCİLERİ
// ---------------------------------------------------------------------------
// Bu dosya index.ts'te (client oluşturulup login olmadan önce/sonra fark
// etmez, sadece bir kere) şöyle çağrılmalı:
//
//   import { registerLoggingEvents } from "./events/loggingEvents.js";
//   registerLoggingEvents(client);
//
// GEREKLİ INTENT'LER (client oluşturulurken GatewayIntentBits içine eklenmeli):
//   Guilds, GuildMessages, MessageContent, GuildMembers, GuildModeration
//   (ban/unban için — eski adıyla GuildBans), GuildVoiceStates
//
// GEREKLİ PARTIALS (mesaj sil/düzenle olayları cache'te olmayan eski
// mesajlarda da tetiklensin diye):
//   Partials.Message, Partials.Channel, Partials.Reaction
//
// Örnek:
//   new Client({
//     intents: [
//       GatewayIntentBits.Guilds,
//       GatewayIntentBits.GuildMessages,
//       GatewayIntentBits.MessageContent,
//       GatewayIntentBits.GuildMembers,
//       GatewayIntentBits.GuildModeration,
//       GatewayIntentBits.GuildVoiceStates,
//     ],
//     partials: [Partials.Message, Partials.Channel, Partials.Reaction],
//   });
//
// Bu intent'lerden biri (özellikle GuildMembers ve MessageContent, ikisi de
// "privileged") Discord Developer Portal'da bot sayfasında açık olmalı,
// yoksa bot login sırasında hata verir.
// ---------------------------------------------------------------------------

function authorTag(entity: { id: string; tag?: string; username?: string } | null | undefined): string {
  if (!entity) return "Bilinmiyor";
  return entity.tag ?? entity.username ?? entity.id;
}

function setThumbnailIfAvailable(card: V2CardBuilder, url: string | null | undefined): V2CardBuilder {
  if (url) card.setThumbnail(url);
  return card;
}

async function findMessageDeleteExecutor(message: Message | PartialMessage): Promise<string | null> {
  const guild = message.guild;
  const authorId = message.author?.id;
  const channelId = message.channelId;
  if (!guild || !authorId || !channelId) return null;

  // Discord audit log kaydı messageDelete event'inden biraz sonra düşebiliyor.
  // Kısa aralıklarla tekrar deneyip yazar ve kanal eşleşmesini de doğrula.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 10 });
      const entry = logs.entries.find((candidate) => {
        if (!candidate.target || !("id" in candidate.target) || candidate.target.id !== authorId) return false;
        const age = Date.now() - candidate.createdTimestamp;
        if (age < 0 || age > 15_000) return false;
        const extra = candidate.extra;
        if (!extra || !("channel" in extra) || !extra.channel || !("id" in extra.channel)) return false;
        return extra.channel.id === channelId;
      });
      if (entry?.executor) return `<@${entry.executor.id}> (\`${entry.executor.tag}\`)`;
    } catch {
      // İzin/ağ hatasında yine de mesaj logunu göndermeye devam et.
      return null;
    }
  }
  return null;
}


/** Event handler'ları güvenli sarmalar: handler içinde fırlayan herhangi bir
 *  hata yakalanıp loglanır; unhandled rejection olup process'i düşürmez. */
function safeHandler<Args extends unknown[]>(
  eventName: string,
  fn: (...args: Args) => Promise<unknown> | unknown,
): (...args: Args) => void {
  return (...args: Args) => {
    void Promise.resolve()
      .then(() => fn(...args))
      .catch((error) => console.error(`[log] ${eventName} patladı:`, error));
  };
}

export function registerLoggingEvents(client: Client): void {
  // ---------------------------------------------------------------------
  // MESAJ LOGLARI
  // ---------------------------------------------------------------------

  client.on(Events.MessageDelete, safeHandler("MessageDelete", async (message: Message | PartialMessage) => {
    if (!message.guild || message.author?.bot) return;
    const executor = message.id ? await findMessageDeleteExecutor(message) : null;

    const embed = setThumbnailIfAvailable(
      baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Mesaj Silindi")
        .setDescription(message.partial ? "*(Mesaj cache'te yoktu, içerik yakalanamadı)*" : truncate(message.content ?? "")),
      message.author?.displayAvatarURL?.(),
    )
      .addFields(
        { name: "Yazar", value: message.author ? `<@${message.author.id}> (\`${authorTag(message.author)}\`)` : "Bilinmiyor", inline: true },
        { name: "Kanal", value: message.channel ? `<#${message.channel.id}>` : "Bilinmiyor", inline: true },
      );
    embed.addFields({
      name: "Silen",
      value: executor ?? "Tespit edilemedi (audit log kaydı/izni yok)",
      inline: true,
    });

    if (message.attachments?.size) {
      const tumEkler = [...message.attachments.values()];
      // Resim/gif olan ekleri ayır: bunlar embed içine görsel olarak gömülecek,
      // diğerleri (video, ses, dosya vb.) eskisi gibi link listesi olarak kalacak.
      const gorseller = tumEkler.filter(
        (a) => a.contentType?.startsWith("image/") ?? /\.(png|jpe?g|gif|webp)$/i.test(a.name ?? a.url),
      );
      const digerEkler = tumEkler.filter((a) => !gorseller.includes(a));

      if (gorseller.length > 0) {
        // Discord embed'i tek görsel gösterebiliyor; ilkini büyük gösteriyoruz.
        embed.setImage(gorseller[0].url);
        if (gorseller.length > 1) {
          embed.addFields({
            name: `Diğer Görseller (${gorseller.length - 1})`,
            value: gorseller.slice(1).map((a) => a.url).join("\n").slice(0, 1000),
          });
        }
      }

      if (digerEkler.length > 0) {
        embed.addFields({ name: "Ekler", value: digerEkler.map((a) => a.url).join("\n").slice(0, 1000) });
      }
    }

    embed.addFields({ name: "Mesaj ID", value: `\`${message.id}\``, inline: true });

    await sendLog(message.guild, "mesaj", embed);
  }));

  client.on(Events.MessageBulkDelete, safeHandler("MessageBulkDelete", async (messages, channel) => {
    const guild = channel.guild;
    if (!guild) return;

    // Silen kişiyi/botu audit log'dan bulmayı dene. Bu hem kendi !purge
    // komutumuzla hem de başka bir moderasyon botuyla yapılan toplu silmeleri
    // kapsar — Discord, bot token'ıyla yapılan bulk delete'leri de audit
    // log'a "executor: <bot>" olarak yazar.
    const executor = await findAuditExecutor(guild, AuditLogEvent.MessageBulkDelete, channel.id, 15_000);

    // Silinen mesajları eskiden yeniye doğru sırala ve okunabilir bir .txt
    // dosyasına dök (embed'e sığmayacak kadar çok mesaj olabilir, ör. 100).
    const sirali = [...messages.values()].sort(
      (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0),
    );

    const satirlar = sirali.map((m) => {
      const zaman = m.createdAt
        ? m.createdAt.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })
        : "Bilinmiyor";
      const yazar = m.author ? `${authorTag(m.author)} (${m.author.id})` : "Bilinmiyor";

      let icerik: string;
      if (m.partial) {
        icerik = "*(mesaj cache'te yoktu, içerik yakalanamadı)*";
      } else if (m.content) {
        icerik = m.content;
      } else if (m.embeds?.length) {
        icerik = "*(metin içeriği yok — embed içeriyor)*";
      } else {
        icerik = "*(içerik yok)*";
      }

      const ekler = m.attachments?.size
        ? `\n    Ekler: ${[...m.attachments.values()].map((a) => a.url).join(", ")}`
        : "";

      return `[${zaman}] ${yazar} (ID: ${m.id}): ${icerik}${ekler}`;
    });

    const txtIcerik =
      satirlar.length > 0 ? satirlar.join("\n") : "(Hiçbir mesajın içeriği cache'te yoktu.)";

    const dosya = new AttachmentBuilder(Buffer.from(txtIcerik, "utf-8"), {
      name: `silinen-mesajlar-${channel.id}-${Date.now()}.txt`,
    });

    const embed = baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Toplu Mesaj Silme")
      .setDescription(`**${messages.size}** mesaj toplu silindi.`)
      .addFields(
        { name: "Kanal", value: `<#${channel.id}>`, inline: true },
        { name: "Silen", value: executor ?? "Tespit edilemedi (audit log kaydı/izni yok)", inline: true },
      );
    embed.addFields({ name: "Not", value: "📄 Silinen mesajların tamamı ekteki `.txt` dosyasında." });

    await sendLog(guild, "mesaj", embed, [dosya]);
  }));

  client.on(Events.MessageUpdate, safeHandler("MessageUpdate", async (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => {
    if (!newMessage.guild || newMessage.author?.bot) return;

    // Sabitleme (pin) durumu değiştiyse ayrı ve kısa bir log bas.
    if (oldMessage.pinned !== newMessage.pinned) {
      const pinEmbed = baseLogEmbed(
        LOG_COLORS.mesajDuzenle,
        newMessage.pinned ? "📌 Mesaj Sabitlendi" : "📌 Mesaj Sabitlemesi Kaldırıldı",
      )
        .setDescription(truncate(newMessage.content ?? "", 500))
        .addFields(
          { name: "Yazar", value: newMessage.author ? `<@${newMessage.author.id}> (\`${authorTag(newMessage.author)}\`)` : "Bilinmiyor", inline: true },
          { name: "Kanal", value: `<#${newMessage.channel.id}>`, inline: true },
        )
        .addFields({ name: "Mesaj ID", value: `\`${newMessage.id}\``, inline: true });
      if ("url" in newMessage && newMessage.url) {
        pinEmbed.addFields({ name: "Bağlantı", value: `[Mesaja git](${newMessage.url})` });
      }
      await sendLog(newMessage.guild, "mesaj", pinEmbed);
    }

    // İçerik gerçekten değişmediyse (embed önizlemesi vb. de bu olayı
    // tetikler) düzenleme logu basmaya gerek yok.
    if (oldMessage.content === newMessage.content) return;

    const embed = setThumbnailIfAvailable(
      baseLogEmbed(LOG_COLORS.mesajDuzenle, "✏️ Mesaj Düzenlendi"),
      newMessage.author?.displayAvatarURL?.(),
    )
      .addFields(
        { name: "Yazar", value: newMessage.author ? `<@${newMessage.author.id}> (\`${authorTag(newMessage.author)}\`)` : "Bilinmiyor", inline: true },
        { name: "Kanal", value: `<#${newMessage.channel.id}>`, inline: true },
        { name: "Öncesi", value: truncate(oldMessage.content ?? "*(cache'te yoktu)*", 500) },
        { name: "Sonrası", value: truncate(newMessage.content ?? "", 500) },
      )
      .addFields({ name: "Mesaj ID", value: `\`${newMessage.id}\``, inline: true });

    if ("url" in newMessage && newMessage.url) {
      embed.addFields({ name: "Bağlantı", value: `[Mesaja git](${newMessage.url})` });
    }

    await sendLog(newMessage.guild, "mesaj", embed);
  }));

  // ---------------------------------------------------------------------
  // ÜYE LOGLARI (giriş / çıkış / ban / unban / kick / timeout)
  // ---------------------------------------------------------------------

  client.on(Events.GuildMemberAdd, safeHandler("GuildMemberAdd", async (member: GuildMember) => {
    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    const accountAgeDays = Math.floor(accountAgeMs / 86_400_000);
    const embed = baseLogEmbed(LOG_COLORS.uyeGiris, "📥 Üye Katıldı")
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "Kullanıcı", value: `<@${member.id}> (\`${authorTag(member.user)}\`)`, inline: true },
        { name: "Hesap yaşı", value: `${accountAgeDays} gün`, inline: true },
        { name: "Sunucu üye sayısı", value: `${member.guild.memberCount}`, inline: true },
      )
      .addFields({ name: "Kullanıcı ID", value: `\`${member.id}\``, inline: true });

    if (accountAgeDays < 7) {
      embed.addFields({ name: `${EMOJIS.alert} Dikkat`, value: "Hesap 7 günden yeni, olası alt hesap/spam olabilir." });
    }

    await sendLog(member.guild, "giris-cikis", embed);
  }));

  client.on(Events.GuildMemberRemove, safeHandler("GuildMemberRemove", async (member: GuildMember | PartialGuildMember) => {
    const { type, executor } = await classifyMemberRemoval(member.guild, member.id);
    // Ban ile ayrılanlar zaten ayrı GuildBanAdd olayında loglanıyor;
    // burada tekrar basmayalım, mükerrer log kirliliği olmasın.
    if (type === "ban") return;

    const title = type === "kick" ? "👢 Üye Atıldı (Kick)" : "📤 Üye Ayrıldı";
    const color = type === "kick" ? LOG_COLORS.kick : LOG_COLORS.uyeCikis;
    const roles = "roles" in member && member.roles && "cache" in member.roles
      ? [...member.roles.cache.values()].filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`).join(", ") || "—"
      : "—";

    const embed = baseLogEmbed(color, title)
      .setThumbnail(member.user?.displayAvatarURL() ?? null)
      .addFields(
        { name: "Kullanıcı", value: `<@${member.id}> (\`${authorTag(member.user)}\`)`, inline: true },
        { name: "Rolleri", value: truncate(roles, 500) },
      )
      .addFields({ name: "Kullanıcı ID", value: `\`${member.id}\``, inline: true });
    if (type === "kick" && executor) embed.addFields({ name: "Atan", value: executor, inline: true });

    await sendLog(member.guild, type === "kick" ? "uyari" : "giris-cikis", embed);
  }));

  client.on(Events.GuildBanAdd, safeHandler("GuildBanAdd", async (ban) => {
    const executor = await findAuditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    const embed = baseLogEmbed(LOG_COLORS.ban, "🔨 Üye Banlandı")
      .setThumbnail(ban.user.displayAvatarURL())
      .addFields({ name: "Kullanıcı", value: `<@${ban.user.id}> (\`${authorTag(ban.user)}\`)`, inline: true })
      .addFields({ name: "Kullanıcı ID", value: `\`${ban.user.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Banlayan", value: executor, inline: true });
    if (ban.reason) embed.addFields({ name: "Sebep", value: truncate(ban.reason, 500) });

    await sendLog(ban.guild, "uyari", embed);
  }));

  client.on(Events.GuildBanRemove, safeHandler("GuildBanRemove", async (ban) => {
    const executor = await findAuditExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    const embed = baseLogEmbed(LOG_COLORS.unban, "🔓 Ban Kaldırıldı")
      .setThumbnail(ban.user.displayAvatarURL())
      .addFields({ name: "Kullanıcı", value: `<@${ban.user.id}> (\`${authorTag(ban.user)}\`)`, inline: true })
      .addFields({ name: "Kullanıcı ID", value: `\`${ban.user.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Kaldıran", value: executor, inline: true });

    await sendLog(ban.guild, "uyari", embed);
  }));

  client.on(Events.GuildMemberUpdate, safeHandler("GuildMemberUpdate", async (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
    // Timeout (iletişimi engelleme) değişikliği
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp ?? null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp ?? null;
    if (oldTimeout !== newTimeout) {
      const executor = await findAuditExecutor(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
      if (newTimeout && newTimeout > Date.now()) {
        const embed = baseLogEmbed(LOG_COLORS.timeout, "🔇 Üyeye Zaman Aşımı (Timeout) Verildi")
          .setThumbnail(newMember.user.displayAvatarURL())
          .addFields(
            { name: "Kullanıcı", value: `<@${newMember.id}> (\`${authorTag(newMember.user)}\`)`, inline: true },
            { name: "Süre bitişi", value: `<t:${Math.floor(newTimeout / 1000)}:R>`, inline: true },
          )
          .addFields({ name: "Kullanıcı ID", value: `\`${newMember.id}\``, inline: true });
        if (executor) embed.addFields({ name: "Uygulayan", value: executor, inline: true });
        await sendLog(newMember.guild, "giris-cikis", embed);
      } else if (oldTimeout) {
        const embed = baseLogEmbed(LOG_COLORS.unban, "🔊 Üyenin Zaman Aşımı Kaldırıldı")
          .addFields({ name: "Kullanıcı", value: `<@${newMember.id}> (\`${authorTag(newMember.user)}\`)`, inline: true })
          .addFields({ name: "Kullanıcı ID", value: `\`${newMember.id}\``, inline: true });
        if (executor) embed.addFields({ name: "Kaldıran", value: executor, inline: true });
        await sendLog(newMember.guild, "giris-cikis", embed);
      }
    }

    // Rol değişikliği
    const oldRoles = new Set(oldMember.roles?.cache?.keys() ?? []);
    const newRoles = new Set(newMember.roles.cache.keys());
    const added = [...newRoles].filter((r) => !oldRoles.has(r));
    const removed = [...oldRoles].filter((r) => !newRoles.has(r));
    if (added.length || removed.length) {
      const embed = baseLogEmbed(LOG_COLORS.rolKanal, "🎭 Üye Rolleri Değişti")
        .setThumbnail(newMember.user.displayAvatarURL())
        .addFields({ name: "Kullanıcı", value: `<@${newMember.id}> (\`${authorTag(newMember.user)}\`)`, inline: true })
        .addFields({ name: "Kullanıcı ID", value: `\`${newMember.id}\``, inline: true });
      if (added.length) embed.addFields({ name: "Eklenen", value: added.map((r) => `<@&${r}>`).join(", ") });
      if (removed.length) embed.addFields({ name: "Kaldırılan", value: removed.map((r) => `<@&${r}>`).join(", ") });
      await sendLog(newMember.guild, "giris-cikis", embed);
    }

    // Takma ad değişikliği
    if (oldMember.nickname !== newMember.nickname) {
      const embed = baseLogEmbed(LOG_COLORS.uyeCikis, "✏️ Takma Ad Değişti")
        .setThumbnail(newMember.user.displayAvatarURL())
        .addFields(
          { name: "Kullanıcı", value: `<@${newMember.id}> (\`${authorTag(newMember.user)}\`)`, inline: true },
          { name: "Öncesi", value: oldMember.nickname ?? "*(yoktu)*", inline: true },
          { name: "Sonrası", value: newMember.nickname ?? "*(kaldırıldı)*", inline: true },
        )
        .addFields({ name: "Kullanıcı ID", value: `\`${newMember.id}\``, inline: true });
      await sendLog(newMember.guild, "giris-cikis", embed);
    }
  }));

  // ---------------------------------------------------------------------
  // ROL & KANAL LOGLARI
  // ---------------------------------------------------------------------

  client.on(Events.ChannelCreate, safeHandler("ChannelCreate", async (channel: GuildChannel) => {
    const executor = await findAuditExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "📁 Kanal Oluşturuldu")
      .addFields(
        { name: "Kanal", value: `${channel} (\`${channel.name}\`)`, inline: true },
        { name: "Tip", value: ChannelType[channel.type], inline: true },
      )
      .addFields({ name: "Kanal ID", value: `\`${channel.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Oluşturan", value: executor, inline: true });
    await sendLog(channel.guild, "kanal", embed);
  }));

  client.on(Events.ChannelDelete, safeHandler("ChannelDelete", async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    const executor = await findAuditExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    const embed = baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Kanal Silindi")
      .addFields(
        { name: "Kanal", value: `\`#${channel.name}\``, inline: true },
        { name: "Tip", value: ChannelType[channel.type], inline: true },
      )
      .addFields({ name: "Kanal ID", value: `\`${channel.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Silen", value: executor, inline: true });
    await sendLog(channel.guild, "kanal", embed);
  }));

  client.on(Events.ChannelUpdate, safeHandler("ChannelUpdate", async (oldChannel, newChannel) => {
    if (!("guild" in newChannel) || !newChannel.guild) return;
    const changes: string[] = [];
    if ("name" in oldChannel && "name" in newChannel && oldChannel.name !== newChannel.name) {
      changes.push(`**İsim:** \`${oldChannel.name}\` → \`${newChannel.name}\``);
    }
    if ("topic" in oldChannel && "topic" in newChannel && oldChannel.topic !== newChannel.topic) {
      changes.push(`**Konu:** \`${oldChannel.topic ?? "—"}\` → \`${newChannel.topic ?? "—"}\``);
    }
    if ("nsfw" in oldChannel && "nsfw" in newChannel && oldChannel.nsfw !== newChannel.nsfw) {
      changes.push(`**NSFW:** \`${oldChannel.nsfw}\` → \`${newChannel.nsfw}\``);
    }
    if (changes.length === 0) return; // izin/permission overwrite değişiklikleri gürültü yaratmasın diye burada takip edilmiyor

    const executor = await findAuditExecutor(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "🛠️ Kanal Güncellendi")
      .addFields({ name: "Kanal", value: `${newChannel}`, inline: true })
      .setDescription(changes.join("\n"))
      .addFields({ name: "Kanal ID", value: `\`${newChannel.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Değiştiren", value: executor, inline: true });
    await sendLog(newChannel.guild, "kanal", embed);
  }));

  client.on(Events.GuildRoleCreate, safeHandler("GuildRoleCreate", async (role: Role) => {
    const executor = await findAuditExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "🎭 Rol Oluşturuldu")
      .setColor(role.color || LOG_COLORS.rolKanal)
      .addFields(
        { name: "Rol", value: `${role} (\`${role.name}\`)`, inline: true },
        { name: "Renk", value: `\`${role.hexColor}\``, inline: true },
      )
      .addFields({ name: "Rol ID", value: `\`${role.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Oluşturan", value: executor, inline: true });
    await sendLog(role.guild, "rol", embed);
  }));

  client.on(Events.GuildRoleDelete, safeHandler("GuildRoleDelete", async (role: Role) => {
    const executor = await findAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    const embed = baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Rol Silindi")
      .addFields({ name: "Rol", value: `\`@${role.name}\``, inline: true })
      .addFields({ name: "Rol ID", value: `\`${role.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Silen", value: executor, inline: true });
    await sendLog(role.guild, "rol", embed);
  }));

  client.on(Events.GuildRoleUpdate, safeHandler("GuildRoleUpdate", async (oldRole: Role, newRole: Role) => {
    const changes: string[] = [];
    if (oldRole.name !== newRole.name) changes.push(`**İsim:** \`${oldRole.name}\` → \`${newRole.name}\``);
    if (oldRole.hexColor !== newRole.hexColor) changes.push(`**Renk:** \`${oldRole.hexColor}\` → \`${newRole.hexColor}\``);
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push("**İzinler değişti**");
    if (changes.length === 0) return;

    const executor = await findAuditExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "🛠️ Rol Güncellendi")
      .setDescription(changes.join("\n"))
      .addFields({ name: "Rol", value: `${newRole}`, inline: true })
      .addFields({ name: "Rol ID", value: `\`${newRole.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Değiştiren", value: executor, inline: true });
    await sendLog(newRole.guild, "rol", embed);
  }));

  // ---------------------------------------------------------------------
  // SES KANALI LOGLARI
  // ---------------------------------------------------------------------

  client.on(Events.VoiceStateUpdate, safeHandler("VoiceStateUpdate", async (oldState: VoiceState, newState: VoiceState) => {
    const guild = newState.guild;
    const member = newState.member ?? oldState.member;
    if (!member) return;

    if (!oldState.channelId && newState.channelId) {
      // Kanala katıldı
      const embed = baseLogEmbed(LOG_COLORS.ses, "🔊 Ses Kanalına Katıldı")
        .addFields(
          { name: "Kullanıcı", value: `<@${member.id}>`, inline: true },
          { name: "Kanal", value: `${newState.channel}`, inline: true },
        )
        .addFields({ name: "Kullanıcı ID", value: `\`${member.id}\``, inline: true });
      await sendLog(guild, "ses", embed);
    } else if (oldState.channelId && !newState.channelId) {
      // Kanaldan ayrıldı
      const embed = baseLogEmbed(LOG_COLORS.ses, "🔇 Ses Kanalından Ayrıldı")
        .addFields(
          { name: "Kullanıcı", value: `<@${member.id}>`, inline: true },
          { name: "Kanal", value: `${oldState.channel}`, inline: true },
        )
        .addFields({ name: "Kullanıcı ID", value: `\`${member.id}\``, inline: true });
      await sendLog(guild, "ses", embed);
    } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      // Kanal değiştirdi
      const embed = baseLogEmbed(LOG_COLORS.ses, "🔀 Ses Kanalı Değiştirdi")
        .addFields(
          { name: "Kullanıcı", value: `<@${member.id}>`, inline: true },
          { name: "Önceki kanal", value: `${oldState.channel}`, inline: true },
          { name: "Yeni kanal", value: `${newState.channel}`, inline: true },
        )
        .addFields({ name: "Kullanıcı ID", value: `\`${member.id}\``, inline: true });
      await sendLog(guild, "ses", embed);
    }

    // Sunucu tarafından susturma/sağırlaştırma (self mute/deaf değil, mod eylemi)
    if (oldState.channelId && newState.channelId && oldState.serverMute !== newState.serverMute) {
      const embed = baseLogEmbed(LOG_COLORS.ses, newState.serverMute ? "🔇 Sunucu Tarafından Susturuldu" : "🔊 Susturma Kaldırıldı")
        .addFields(
          { name: "Kullanıcı", value: `<@${member.id}>`, inline: true },
          { name: "Kanal", value: `${newState.channel}`, inline: true },
        )
        .addFields({ name: "Kullanıcı ID", value: `\`${member.id}\``, inline: true });
      await sendLog(guild, "ses", embed);
    }
    if (oldState.channelId && newState.channelId && oldState.serverDeaf !== newState.serverDeaf) {
      const embed = baseLogEmbed(LOG_COLORS.ses, newState.serverDeaf ? "🔇 Sunucu Tarafından Sağırlaştırıldı" : "🔊 Sağırlaştırma Kaldırıldı")
        .addFields(
          { name: "Kullanıcı", value: `<@${member.id}>`, inline: true },
          { name: "Kanal", value: `${newState.channel}`, inline: true },
        )
        .addFields({ name: "Kullanıcı ID", value: `\`${member.id}\``, inline: true });
      await sendLog(guild, "ses", embed);
    }
  }));

  // ---------------------------------------------------------------------
  // EMOJİ / ÇIKARTMA LOGLARI
  // ---------------------------------------------------------------------

  client.on(Events.GuildEmojiCreate, safeHandler("GuildEmojiCreate", async (emoji: GuildEmoji) => {
    const executor = await findAuditExecutor(emoji.guild, AuditLogEvent.EmojiCreate, emoji.id);
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "😀 Emoji Eklendi")
      .setThumbnail(emoji.imageURL())
      .addFields({ name: "Emoji", value: `\`:${emoji.name}:\``, inline: true })
      .addFields({ name: "Emoji ID", value: `\`${emoji.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Ekleyen", value: executor, inline: true });
    await sendLog(emoji.guild, "kanal", embed);
  }));

  client.on(Events.GuildEmojiDelete, safeHandler("GuildEmojiDelete", async (emoji: GuildEmoji) => {
    const executor = await findAuditExecutor(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id);
    const embed = baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Emoji Silindi")
      .addFields({ name: "Emoji", value: `\`:${emoji.name}:\``, inline: true })
      .addFields({ name: "Emoji ID", value: `\`${emoji.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Silen", value: executor, inline: true });
    await sendLog(emoji.guild, "kanal", embed);
  }));

  client.on(Events.GuildStickerCreate, safeHandler("GuildStickerCreate", async (sticker: Sticker) => {
    if (!sticker.guild) return;
    const executor = await findAuditExecutor(sticker.guild, AuditLogEvent.StickerCreate, sticker.id);
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "🏷️ Çıkartma Eklendi")
      .addFields({ name: "Çıkartma", value: `\`${sticker.name}\``, inline: true })
      .addFields({ name: "Çıkartma ID", value: `\`${sticker.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Ekleyen", value: executor, inline: true });
    await sendLog(sticker.guild, "kanal", embed);
  }));

  client.on(Events.GuildStickerDelete, safeHandler("GuildStickerDelete", async (sticker: Sticker) => {
    if (!sticker.guild) return;
    const executor = await findAuditExecutor(sticker.guild, AuditLogEvent.StickerDelete, sticker.id);
    const embed = baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Çıkartma Silindi")
      .addFields({ name: "Çıkartma", value: `\`${sticker.name}\``, inline: true })
      .addFields({ name: "Çıkartma ID", value: `\`${sticker.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Silen", value: executor, inline: true });
    await sendLog(sticker.guild, "kanal", embed);
  }));

  // ---------------------------------------------------------------------
  // DAVET (INVITE) LOGLARI
  // ---------------------------------------------------------------------

  client.on(Events.InviteCreate, safeHandler("InviteCreate", async (invite: Invite) => {
    if (!invite.guild) return;
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "📨 Davet Oluşturuldu")
      .addFields(
        { name: "Kod", value: `\`${invite.code}\``, inline: true },
        { name: "Kanal", value: invite.channel ? `<#${invite.channel.id}>` : "Bilinmiyor", inline: true },
        { name: "Oluşturan", value: invite.inviter ? `<@${invite.inviter.id}> (\`${authorTag(invite.inviter)}\`)` : "Bilinmiyor", inline: true },
        { name: "Maks. kullanım", value: invite.maxUses ? `${invite.maxUses}` : "Sınırsız", inline: true },
        { name: "Süre", value: invite.maxAge ? `${invite.maxAge} saniye` : "Süresiz", inline: true },
      );
    const guild = client.guilds.cache.get(invite.guild.id);
    if (guild) await sendLog(guild, "kanal", embed);
  }));

  client.on(Events.InviteDelete, safeHandler("InviteDelete", async (invite) => {
    if (!invite.guild) return;
    const embed = baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Davet Silindi/Süresi Doldu")
      .addFields(
        { name: "Kod", value: `\`${invite.code}\``, inline: true },
        { name: "Kanal", value: invite.channel ? `<#${invite.channel.id}>` : "Bilinmiyor", inline: true },
      );
    const guild = client.guilds.cache.get(invite.guild.id);
    if (guild) await sendLog(guild, "kanal", embed);
  }));

  // ---------------------------------------------------------------------
  // THREAD (KONU) LOGLARI
  // ---------------------------------------------------------------------

  client.on(Events.ThreadCreate, safeHandler("ThreadCreate", async (thread: AnyThreadChannel) => {
    if (!thread.guild) return;
    const executor = await findAuditExecutor(thread.guild, AuditLogEvent.ThreadCreate, thread.id);
    const embed = baseLogEmbed(LOG_COLORS.rolKanal, "🧵 Konu (Thread) Oluşturuldu")
      .addFields(
        { name: "Konu", value: `${thread} (\`${thread.name}\`)`, inline: true },
        { name: "Üst Kanal", value: thread.parentId ? `<#${thread.parentId}>` : "Bilinmiyor", inline: true },
      )
      .addFields({ name: "Konu ID", value: `\`${thread.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Oluşturan", value: executor, inline: true });
    await sendLog(thread.guild, "kanal", embed);
  }));

  client.on(Events.ThreadDelete, safeHandler("ThreadDelete", async (thread: AnyThreadChannel) => {
    if (!thread.guild) return;
    const executor = await findAuditExecutor(thread.guild, AuditLogEvent.ThreadDelete, thread.id);
    const embed = baseLogEmbed(LOG_COLORS.mesajSil, "🗑️ Konu (Thread) Silindi")
      .addFields({ name: "Konu", value: `\`${thread.name}\``, inline: true })
      .addFields({ name: "Konu ID", value: `\`${thread.id}\``, inline: true });
    if (executor) embed.addFields({ name: "Silen", value: executor, inline: true });
    await sendLog(thread.guild, "kanal", embed);
  }));

  // ---------------------------------------------------------------------
  // SUNUCU AYARLARI LOGU (isim / ikon / banner değişimi)
  // ---------------------------------------------------------------------

  client.on(Events.GuildUpdate, safeHandler("GuildUpdate", async (oldGuild, newGuild) => {
    const changes: string[] = [];
    if (oldGuild.name !== newGuild.name) changes.push(`**İsim:** \`${oldGuild.name}\` → \`${newGuild.name}\``);
    if (oldGuild.iconURL() !== newGuild.iconURL()) changes.push("**Sunucu ikonu değişti**");
    if (oldGuild.bannerURL() !== newGuild.bannerURL()) changes.push("**Sunucu banner'ı değişti**");
    if (changes.length === 0) return;

    const executor = await findAuditExecutor(newGuild, AuditLogEvent.GuildUpdate, newGuild.id);
    const embed = setThumbnailIfAvailable(
      baseLogEmbed(LOG_COLORS.rolKanal, "⚙️ Sunucu Ayarları Güncellendi").setDescription(changes.join("\n")),
      newGuild.iconURL(),
    );
    if (executor) embed.addFields({ name: "Değiştiren", value: executor, inline: true });
    await sendLog(newGuild, "kanal", embed);
  }));

  console.log(
    "[log] sunucu log dinleyicileri açıldı",
  );
}
