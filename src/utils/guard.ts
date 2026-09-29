import { resolveEmojis, COMPONENTS_V2_FLAG, V2CardBuilder } from "./componentsV2.js";
import { v2Payload } from "./messages.js";
import {
  ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  ChannelType, Events, PermissionsBitField, RoleSelectMenuBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder,
  type Client, type Guild, type GuildBan, type GuildChannel, type GuildMember, type PartialGuildMember, type Role, type User,
} from "discord.js";
import { eq } from "../db/jsonOrm.js";
import { db } from "../db/index.js";
import { botSettingsTable, warningsTable } from "../db/schema.js";
import { OWNER_ID, BOT_NAME } from "../config.js";
import { EMOJIS } from "./emojis.js";
import { COLORS, brandBanner } from "./embeds.js";

const KEY_PREFIX = "guard:";
const AUDIT_MAX_AGE_MS = 15_000;
// Rol güncellemesinde bir kullanıcıya/role verilmesi tehlikeli sayılan yetkiler.
// Bunlardan biri sıfırdan eklenirse (önceden yokken) yetki yükseltme (privilege
// escalation) girişimi olarak değerlendirilir.
const DANGEROUS_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.MentionEveryone,
  // Eskiden eksikti: ModerateMembers ele geçirilirse moderatörler susturulup
  // etkisiz hale getirilebilir; ManageNicknames toplu/kötü niyetli takma ad
  // değişimi için, ManageEvents ise etkinlik üzerinden kitlesel bildirim/DM
  // spam'i için kötüye kullanılabilir. Üçü de "tehlikeli" sayılmalı.
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.ManageNicknames,
  PermissionsBitField.Flags.ManageEvents,
];
// Bir rolün pozisyonu, @everyone'ın çok üzerine taşınırsa (ör. hiyerarşi
// manipülasyonu ile) rol izinleri hiç değişmese bile fiilen daha güçlü hale
// gelebilir (rengi/mention'ı öne çıkar, bazı entegrasyon/bot mantıkları
// pozisyona güvenebilir). Küçük oynamaları alarma boğmamak için sadece
// belirgin sıçramaları (>= 3 basamak) izliyoruz.
const ROLE_POSITION_JUMP_THRESHOLD = 3;
const DEFAULT_CONFIG: GuardConfig = {
  enabled: false, antiRoleDelete: false, antiChannelDelete: false, antiBotAdd: false, antiRaid: false,
  antiMassBan: false, antiMassKick: false, antiPermissionEscalation: false, raidAutoKick: false,
  exemptUserIds: [], exemptRoleIds: [], exemptChannelIds: [], logChannelId: null,
  roleDeleteThreshold: 1, channelDeleteThreshold: 1, botAddThreshold: 1, actionWindowSeconds: 10, raidJoinThreshold: 5, raidWindowSeconds: 10,
  massBanThreshold: 3, massKickThreshold: 3,
  actionPunishment: "kick", restoreDeletedChannels: true,
};
const configCache = new Map<string, GuardConfig>();
const configUpdateQueues = new Map<string, Promise<GuardConfig>>();
const registeredClients = new WeakSet<Client>();
const recentActions = new Map<string, number[]>();
const recentJoins = new Map<string, { id: string; timestamp: number }[]>();
const recentAlerts = new Map<string, number>();
const ALERT_COOLDOWN_MS = 15_000;

export interface GuardConfig {
  enabled: boolean;
  antiRoleDelete: boolean;
  antiChannelDelete: boolean;
  antiBotAdd: boolean;
  antiRaid: boolean;
  antiMassBan: boolean;
  antiMassKick: boolean;
  antiPermissionEscalation: boolean;
  raidAutoKick: boolean;
  exemptUserIds: string[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  logChannelId: string | null;
  roleDeleteThreshold: number;
  channelDeleteThreshold: number;
  botAddThreshold: number;
  actionWindowSeconds: number;
  raidJoinThreshold: number;
  raidWindowSeconds: number;
  massBanThreshold: number;
  massKickThreshold: number;
  actionPunishment: "none" | "warn" | "kick" | "ban" | "timeout";
  restoreDeletedChannels: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function configKey(guildId: string): string { return `${KEY_PREFIX}${guildId}`; }
function thresholdReached(key: string, threshold: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const timestamps = (recentActions.get(key) ?? []).filter((timestamp) => now - timestamp <= windowMs);
  timestamps.push(now);
  if (timestamps.length > threshold) timestamps.splice(0, timestamps.length - threshold);
  const reached = timestamps.length >= threshold;
  if (reached) recentActions.delete(key);
  else recentActions.set(key, timestamps);
  return reached;
}

// Audit log her zaman 15sn içinde oluşmayabilir; aynı saldırganın olayları
// bazen executorId'ye, bazen "unknown" kovasına düşebiliyordu. Sayaç ikiye
// bölününce eşiğe hiç ulaşılamayabiliyordu — yani audit log gecikmesi
// korumayı sessizce zayıflatabiliyordu. Bunun yerine, executorId biliniyorsa
// hem kendi kovasını hem "unknown" kovasını birlikte değerlendiriyoruz: her
// ikisinin toplamı eşiği geçerse tetikleniyor. executorId bilinmiyorsa zaten
// tek kova ("unknown") kullanılıyor.
function guardThresholdReached(prefix: string, executorId: string | null, threshold: number, windowMs: number): boolean {
  const unknownKey = `${prefix}:unknown`;
  if (!executorId) return thresholdReached(unknownKey, threshold, windowMs);
  const knownKey = `${prefix}:${executorId}`;
  const knownHit = thresholdReached(knownKey, threshold, windowMs);
  const now = Date.now();
  const unknownCount = (recentActions.get(unknownKey) ?? []).filter((timestamp) => now - timestamp <= windowMs).length;
  const knownCount = (recentActions.get(knownKey) ?? []).length;
  return knownHit || knownCount + unknownCount >= threshold;
}
const actionCleanup = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, timestamps] of recentActions) {
    const active = timestamps.filter((timestamp) => timestamp > cutoff);
    if (active.length === 0) recentActions.delete(key);
    else recentActions.set(key, active);
  }
  for (const [key, joins] of recentJoins) {
    const active = joins.filter((join) => join.timestamp > cutoff);
    if (active.length === 0) recentJoins.delete(key);
    else recentJoins.set(key, active);
  }
  for (const [key, timestamp] of recentAlerts) {
    if (Date.now() - timestamp > 5 * 60_000) recentAlerts.delete(key);
  }
  for (const [key, entry] of auditLogCache) {
    if (Date.now() - entry.fetchedAt > AUDIT_CACHE_TTL_MS) auditLogCache.delete(key);
  }
}, 60_000);
actionCleanup.unref?.();
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export async function getGuardConfig(guildId: string): Promise<GuardConfig> {
  const cached = configCache.get(guildId);
  if (cached) return { ...cached, exemptUserIds: [...cached.exemptUserIds], exemptRoleIds: [...cached.exemptRoleIds], exemptChannelIds: [...cached.exemptChannelIds] };
  const rows = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, configKey(guildId)));
  let parsed: unknown;
  try { parsed = rows[0]?.value ? JSON.parse(rows[0].value) : undefined; } catch { parsed = undefined; }
  const config: GuardConfig = {
    enabled: isRecord(parsed) && parsed.enabled === true,
    antiRoleDelete: isRecord(parsed) && parsed.antiRoleDelete === true,
    antiChannelDelete: isRecord(parsed) && parsed.antiChannelDelete === true,
    antiBotAdd: isRecord(parsed) && parsed.antiBotAdd === true,
    antiRaid: isRecord(parsed) && parsed.antiRaid === true,
    antiMassBan: isRecord(parsed) && parsed.antiMassBan === true,
    antiMassKick: isRecord(parsed) && parsed.antiMassKick === true,
    antiPermissionEscalation: isRecord(parsed) && parsed.antiPermissionEscalation === true,
    raidAutoKick: isRecord(parsed) && parsed.raidAutoKick === true,
    exemptUserIds: isRecord(parsed) ? stringArray(parsed.exemptUserIds) : [],
    exemptRoleIds: isRecord(parsed) ? stringArray(parsed.exemptRoleIds) : [],
    exemptChannelIds: isRecord(parsed) ? stringArray(parsed.exemptChannelIds) : [],
    logChannelId: isRecord(parsed) && typeof parsed.logChannelId === "string" ? parsed.logChannelId : null,
    roleDeleteThreshold: isRecord(parsed) ? boundedInteger(parsed.roleDeleteThreshold, 1, 1, 25) : 1,
    channelDeleteThreshold: isRecord(parsed) ? boundedInteger(parsed.channelDeleteThreshold, 1, 1, 25) : 1,
    botAddThreshold: isRecord(parsed) ? boundedInteger(parsed.botAddThreshold, 1, 1, 10) : 1,
    actionWindowSeconds: isRecord(parsed) ? boundedInteger(parsed.actionWindowSeconds, 10, 1, 60) : 10,
    raidJoinThreshold: isRecord(parsed) ? boundedInteger(parsed.raidJoinThreshold, 5, 2, 100) : 5,
    raidWindowSeconds: isRecord(parsed) ? boundedInteger(parsed.raidWindowSeconds, 10, 5, 60) : 10,
    massBanThreshold: isRecord(parsed) ? boundedInteger(parsed.massBanThreshold, 3, 1, 25) : 3,
    massKickThreshold: isRecord(parsed) ? boundedInteger(parsed.massKickThreshold, 3, 1, 25) : 3,
    actionPunishment: isRecord(parsed) && ["none", "warn", "kick", "ban", "timeout"].includes(parsed.actionPunishment as string) ? parsed.actionPunishment as GuardConfig["actionPunishment"] : "kick",
    restoreDeletedChannels: !isRecord(parsed) || parsed.restoreDeletedChannels !== false,
  };
  configCache.set(guildId, config);
  return { ...config };
}

export async function warmGuardConfigCache(): Promise<void> {
  const rows = await db.select().from(botSettingsTable);
  for (const row of rows) {
    if (!row.key.startsWith(KEY_PREFIX) || !row.value) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value); } catch { continue; }
    if (!isRecord(parsed)) continue;
    const config: GuardConfig = {
      ...DEFAULT_CONFIG,
      enabled: parsed.enabled === true,
      antiRoleDelete: parsed.antiRoleDelete === true,
      antiChannelDelete: parsed.antiChannelDelete === true,
      antiBotAdd: parsed.antiBotAdd === true,
      antiRaid: parsed.antiRaid === true,
      antiMassBan: parsed.antiMassBan === true,
      antiMassKick: parsed.antiMassKick === true,
      antiPermissionEscalation: parsed.antiPermissionEscalation === true,
      raidAutoKick: parsed.raidAutoKick === true,
      exemptUserIds: stringArray(parsed.exemptUserIds),
      exemptRoleIds: stringArray(parsed.exemptRoleIds),
      exemptChannelIds: stringArray(parsed.exemptChannelIds),
      logChannelId: typeof parsed.logChannelId === "string" ? parsed.logChannelId : null,
      roleDeleteThreshold: boundedInteger(parsed.roleDeleteThreshold, 1, 1, 25),
      channelDeleteThreshold: boundedInteger(parsed.channelDeleteThreshold, 1, 1, 25),
      botAddThreshold: boundedInteger(parsed.botAddThreshold, 1, 1, 10),
      actionWindowSeconds: boundedInteger(parsed.actionWindowSeconds, 10, 1, 60),
      raidJoinThreshold: boundedInteger(parsed.raidJoinThreshold, 5, 2, 100),
      raidWindowSeconds: boundedInteger(parsed.raidWindowSeconds, 10, 5, 60),
      massBanThreshold: boundedInteger(parsed.massBanThreshold, 3, 1, 25),
      massKickThreshold: boundedInteger(parsed.massKickThreshold, 3, 1, 25),
      actionPunishment: typeof parsed.actionPunishment === "string" && ["none", "warn", "kick", "ban", "timeout"].includes(parsed.actionPunishment) ? parsed.actionPunishment as GuardConfig["actionPunishment"] : "kick",
      restoreDeletedChannels: parsed.restoreDeletedChannels !== false,
    };
    configCache.set(row.key.slice(KEY_PREFIX.length), config);
  }
}

export async function updateGuardConfig(guildId: string, patch: Partial<GuardConfig>): Promise<GuardConfig> {
  const previous = configUpdateQueues.get(guildId);
  const base = previous ? previous.catch(() => getGuardConfig(guildId)) : getGuardConfig(guildId);
  const update = base.then(async (current) => {
    const config: GuardConfig = { ...current, ...patch };
    const value = JSON.stringify(config);
    await db.insert(botSettingsTable).values({ key: configKey(guildId), value }).onConflictDoUpdate({ target: botSettingsTable.key, set: { value, updatedAt: new Date() } });
    configCache.set(guildId, config);
    return { ...config };
  });
  configUpdateQueues.set(guildId, update);
  void update.then(
    () => { if (configUpdateQueues.get(guildId) === update) configUpdateQueues.delete(guildId); },
    () => { if (configUpdateQueues.get(guildId) === update) configUpdateQueues.delete(guildId); },
  );
  return update;
}

function isTrusted(guild: Guild, userId: string | null, config: GuardConfig): boolean {
  if (!userId) return false;
  // Sunucu sahibi, bot sahibi ve bot daima güvenilirdir. Panelde açıkça
  // seçilen kullanıcı veya role sahip kullanıcılar da muaf tutulur; yönetici
  // yetkisi tek başına muafiyet sağlamaz.
  if (userId === guild.ownerId || userId === guild.client.user?.id || userId === OWNER_ID || config.exemptUserIds.includes(userId)) return true;
  const member = guild.members.cache.get(userId);
  return Boolean(member && config.exemptRoleIds.some((roleId) => member.roles.cache.has(roleId)));
}

// Aynı olay tipi için kısa bir pencerede art arda çok sayıda event gelirse
// (ör. yoğun bir sunucuda üyelerin normal ayrılmaları, ya da gerçek bir
// nuke/raid patlaması) eskiden HER tekil olay için ayrı bir fetchAuditLogs
// isteği atılıyordu. Bu hem gereksiz Discord API trafiği hem de tam da
// guard'ın hızlı tepki vermesi gerektiği anda rate limit'e takılıp
// tespiti geciktirme riski taşıyordu (kendi kendine DoS). Aynı
// guild+tip için kısa süreli (2sn) bir sonuç önbelleği kullanarak art
// arda gelen olayları tek bir audit-log çekimiyle karşılıyoruz.
type AuditLogEntries = Awaited<ReturnType<Guild["fetchAuditLogs"]>>["entries"];
const auditLogCache = new Map<string, { entries: AuditLogEntries; fetchedAt: number }>();
const auditLogInflight = new Map<string, Promise<AuditLogEntries>>();
const AUDIT_CACHE_TTL_MS = 2_000;

async function fetchAuditLogEntries(guild: Guild, type: AuditLogEvent): Promise<AuditLogEntries> {
  const cacheKey = `${guild.id}:${type}`;
  const cached = auditLogCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt <= AUDIT_CACHE_TTL_MS) return cached.entries;
  // Aynı anda birden çok event aynı tipte executor arıyorsa (ör. bir raid
  // sırasında art arda gelen kick/ban'ler), ilk istek henüz dönmeden
  // ikincisi de "cache boş" görüp ayrı bir istek atmasın diye bekleyen
  // isteği de paylaşıyoruz.
  const inflight = auditLogInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = guild.fetchAuditLogs({ type, limit: 15 }).then((logs) => {
    auditLogCache.set(cacheKey, { entries: logs.entries, fetchedAt: Date.now() });
    return logs.entries;
  }).finally(() => {
    if (auditLogInflight.get(cacheKey) === promise) auditLogInflight.delete(cacheKey);
  });
  auditLogInflight.set(cacheKey, promise);
  return promise;
}

async function findExecutor(guild: Guild, type: AuditLogEvent, targetId: string): Promise<string | null> {
  try {
    const entries = await fetchAuditLogEntries(guild, type);
    const entry = entries.find((item) => item.target && "id" in item.target && item.target.id === targetId && Date.now() - item.createdTimestamp <= AUDIT_MAX_AGE_MS);
    return entry?.executor?.id ?? null;
  } catch { return null; }
}

async function sendGuardAlert(guild: Guild, config: GuardConfig, title: string, description: string, cooldownKey?: string): Promise<void> {
  if (cooldownKey) {
    const last = recentAlerts.get(cooldownKey);
    if (last && Date.now() - last < ALERT_COOLDOWN_MS) return;
    recentAlerts.set(cooldownKey, Date.now());
  }
  const channel = config.logChannelId ? await guild.channels.fetch(config.logChannelId).catch(() => null) : guild.systemChannel;
  if (!channel?.isTextBased()) return;
  const embed = new V2CardBuilder()
    .setColor(COLORS.error)
    .setAuthor({ name: "Guard Uyarısı" })
    .setTitle(`${EMOJIS.alert} ${title}`)
    .setDescription(description)
    .setFooter({ text: `${BOT_NAME} • Guard` })
    .setTimestamp();
  await channel.send(v2Payload({ components: [embed] })).catch(() => null);
}

async function punishExecutor(guild: Guild, config: GuardConfig, executorId: string | null, reason: string): Promise<void> {
  if (!executorId || isTrusted(guild, executorId, config) || config.actionPunishment === "none") return;
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return;

  let applied = false;
  try {
    if (config.actionPunishment === "warn") {
      await db.insert(warningsTable).values({ userId: member.id, guildId: guild.id, reason, moderatorId: guild.client.user.id });
      applied = true;
    } else if (member.id !== guild.ownerId && config.actionPunishment === "kick") {
      if (member.kickable) {
        await member.kick(reason);
        applied = true;
      }
    } else if (member.id !== guild.ownerId && config.actionPunishment === "ban") {
      if (member.bannable) {
        await member.ban({ reason, deleteMessageSeconds: 0 });
        applied = true;
      }
    } else if (member.id !== guild.ownerId && config.actionPunishment === "timeout") {
      if (member.moderatable) {
        await member.timeout(10 * 60_000, reason);
        applied = true;
      }
    }
  } catch (error) {
    console.error(`[guard] ceza işlemedi (${member.id}):`, error);
  }

  await sendGuardAlert(
    guild,
    config,
    applied ? "Guard cezası uygulandı" : "Guard cezası uygulanamadı",
    `${member.user.tag} için **${config.actionPunishment}** ${applied ? "uygulandı" : "uygulanamadı (bot yetkisi veya rol hiyerarşisini kontrol et)"}. Sebep: ${reason}`,
  );
}

async function restoreDeletedChannel(channel: GuildChannel, config: GuardConfig): Promise<void> {
  if (!config.restoreDeletedChannels) return;
  // Eskiden sadece name/type/parent kopyalanıyordu. İzin override'ları
  // (permission overwrites) hiç taşınmadığı için "geri getirilen" kanal
  // aslında farklı bir kanaldı: özel/gizli bir kanal herkese açık halde geri
  // gelebiliyordu (güvenlik açığı), topic/nsfw/slowmode gibi ayarlar da
  // sessizce kayboluyordu. Silinme anındaki kanal nesnesi (cache'ten geliyor)
  // henüz bu bilgileri taşıyor, o yüzden burada okuyup yeni kanala aktarıyoruz.
  const extra = channel as unknown as {
    permissionOverwrites?: { cache: Iterable<{ id: string; allow: bigint | { bitfield: bigint }; deny: bigint | { bitfield: bigint }; type: number }> };
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number;
    bitrate?: number;
    userLimit?: number;
    rawPosition?: number;
  };
  const permissionOverwrites = extra.permissionOverwrites
    ? [...extra.permissionOverwrites.cache].map((ow) => ({
        id: ow.id,
        allow: typeof ow.allow === "bigint" ? ow.allow : ow.allow.bitfield,
        deny: typeof ow.deny === "bigint" ? ow.deny : ow.deny.bitfield,
        type: ow.type,
      }))
    : undefined;
  await channel.guild.channels
    .create({
      name: channel.name,
      type: channel.type,
      parent: channel.parentId ?? undefined,
      position: extra.rawPosition,
      topic: extra.topic ?? undefined,
      nsfw: extra.nsfw,
      rateLimitPerUser: extra.rateLimitPerUser,
      bitrate: extra.bitrate,
      userLimit: extra.userLimit,
      permissionOverwrites,
      reason: "Guard: silinen kanal geri oluşturuldu",
    })
    .catch(() => null);
}

async function handleRoleDelete(role: Role): Promise<void> {
  const config = await getGuardConfig(role.guild.id);
  if (!config.enabled || !config.antiRoleDelete) return;
  const executorId = await findExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  if (isTrusted(role.guild, executorId, config)) return;
  if (!guardThresholdReached(`${role.guild.id}:role`, executorId, config.roleDeleteThreshold, config.actionWindowSeconds * 1_000)) return;
  await sendGuardAlert(role.guild, config, "Yetkisiz rol silme", `**${role.name}** rolü silindi. İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}.`);
  await punishExecutor(role.guild, config, executorId, `${config.roleDeleteThreshold} rol silme / ${config.actionWindowSeconds} saniye`);
}

async function handleChannelDelete(channel: GuildChannel): Promise<void> {
  const config = await getGuardConfig(channel.guild.id);
  if (!config.enabled || !config.antiChannelDelete || config.exemptChannelIds.includes(channel.id)) return;
  const executorId = await findExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  if (isTrusted(channel.guild, executorId, config)) return;
  await restoreDeletedChannel(channel, config);
  if (!guardThresholdReached(`${channel.guild.id}:channel`, executorId, config.channelDeleteThreshold, config.actionWindowSeconds * 1_000)) return;
  await sendGuardAlert(channel.guild, config, "Yetkisiz kanal silme", `**${channel.name}** kanalı silindi. İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}.`);
  await punishExecutor(channel.guild, config, executorId, `${config.channelDeleteThreshold} kanal silme / ${config.actionWindowSeconds} saniye`);
}

async function handleBotAdd(member: GuildMember): Promise<void> {
  if (!member.user.bot) return;
  const config = await getGuardConfig(member.guild.id);
  if (!config.enabled || !config.antiBotAdd) return;
  // Botun kendisi panelde açıkça muaf tutulmuşsa (ID exemptUserIds içindeyse)
  // dokunma — bu, belirli bir uygulamayı bilinçli olarak güvenilir saymanın
  // doğru yolu.
  if (config.exemptUserIds.includes(member.id)) return;
  const executorId = await findExecutor(member.guild, AuditLogEvent.BotAdd, member.id);
  // NOT: Eskiden burada isTrusted(guild, executorId, config) kontrolü vardı ve
  // eğer botu ekleyen kişi (owner/exempt) güvenilir sayılıyorsa bot HİÇ
  // engellenmiyordu. Bu ciddi bir açıktı: "ekleyen kişi güvenilir" ile
  // "eklenen bot güvenli" aynı şey değil — güvenilir bir hesap ele geçirilmiş
  // olabilir, yanlışlıkla zararlı bir bota izin vermiş olabilir, ya da audit
  // log henüz oluşmadığı için executor hiç bulunamayabilir. Artık kim
  // eklerse eklesin (veya kimliği belirlenemese bile) rolsüz/izinsiz bot
  // eşik aşıldığında çıkarılır; ekleyen kişinin ayrıca cezalandırılıp
  // cezalandırılmayacağına punishExecutor kendi içinde isTrusted ile zaten
  // ayrıca karar veriyor.
  if (!guardThresholdReached(`${member.guild.id}:bot`, executorId, config.botAddThreshold, config.actionWindowSeconds * 1_000)) return;
  let removed = false;
  try {
    if (member.kickable) {
      await member.kick("Guard: yetkisiz bot ekleme");
      removed = true;
    }
  } catch (error) {
    console.error(`[guard] bot atılamadı (${member.id}):`, error);
  }
  await sendGuardAlert(member.guild, config, removed ? "Yetkisiz bot engellendi" : "Yetkisiz bot engellenemedi", `${member.user.tag} ${removed ? "sunucudan çıkarıldı" : "çıkarılamadı (bot yetkisi veya rol hiyerarşisini kontrol et)"}. İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}.`);
  await punishExecutor(member.guild, config, executorId, `${config.botAddThreshold} bot ekleme / ${config.actionWindowSeconds} saniye`);
}

// Bir uygulama sadece "applications.commands" izniyle (bot scope'u olmadan)
// eklenirse, hiçbir zaman gerçek bir üye olarak sunucuya katılmaz — yani
// GuildMemberAdd hiç tetiklenmez ve handleBotAdd bunu asla göremez. Buna
// rağmen slash komutları sunucuda hemen kullanılabilir hale gelir. Discord
// bunun için ayrı bir gateway olayı sağlamaz; sadece "entegrasyonlar
// güncellendi" (GuildIntegrationsUpdate) bildirimi gelir ve neyin değiştiğini
// öğrenmek için audit log'a bakmak gerekir (AuditLogEvent.IntegrationCreate).
// ÖNEMLİ SINIRLAMA: bot API'sinde başka bir uygulamanın entegrasyonunu
// kaldıracak bir uç nokta yok — bunu sadece bir yönetici, Discord
// istemcisinden "Sunucu Ayarları → Entegrasyonlar" üzerinden elle
// kaldırabilir. O yüzden burada kick yerine sadece net bir uyarı (ve
// isteğe bağlı olarak ekleyen kişiye ceza) uyguluyoruz.
async function handleIntegrationAdd(guild: Guild): Promise<void> {
  const config = await getGuardConfig(guild.id);
  if (!config.enabled || !config.antiBotAdd) return;

  let entry;
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.IntegrationCreate, limit: 15 });
    entry = logs.entries.find((item) => Date.now() - item.createdTimestamp <= AUDIT_MAX_AGE_MS);
  } catch {
    return;
  }
  if (!entry) return;

  // discord.js'in Integration audit log hedefi için tam tip desteği tutarsız
  // olduğundan (bazı sürümlerde ham veri, bazılarında yapılandırılmış nesne
  // gelir) alanlara savunmacı biçimde erişiyoruz.
  const target = entry.target as unknown as {
    id?: string;
    name?: string;
    application?: { id?: string; name?: string; bot?: { id?: string } };
  } | null;
  const appId = target?.application?.id ?? target?.application?.bot?.id ?? target?.id ?? null;
  const appName = target?.application?.name ?? target?.name ?? "Bilinmeyen uygulama";
  if (appId && config.exemptUserIds.includes(appId)) return;

  const executorId = entry.executor?.id ?? null;
  if (!guardThresholdReached(`${guild.id}:integration`, executorId, config.botAddThreshold, config.actionWindowSeconds * 1_000)) return;

  await sendGuardAlert(
    guild,
    config,
    "Yetkisiz uygulama/entegrasyon eklendi",
    `**${appName}** adlı bir uygulama sunucuya yalnızca slash komut (applications.commands) izniyle eklendi. Bu tür eklemeler gerçek bir üye olarak görünmediği için bot tarafından otomatik olarak çıkarılamıyor.\n` +
      `${EMOJIS.alert} Kaldırmak için: **Sunucu Ayarları → Entegrasyonlar** kısmından elle kaldırman gerekiyor.\n` +
      `İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}.`,
    `${guild.id}:integration-alert:${appId ?? "unknown"}`,
  );
  await punishExecutor(guild, config, executorId, "Yetkisiz uygulama/entegrasyon eklendi (applications.commands)");
}

async function handleRaidJoin(member: GuildMember): Promise<void> {
  const config = await getGuardConfig(member.guild.id);
  if (!config.enabled || !config.antiRaid) return;
  const now = Date.now();
  const joins = (recentJoins.get(member.guild.id) ?? []).filter((join) => now - join.timestamp <= config.raidWindowSeconds * 1_000);
  joins.push({ id: member.id, timestamp: now });
  recentJoins.set(member.guild.id, joins);
  // Not: burada `!==` yerine `<` kullanılmalı. Eşik panelden düşürüldüğünde
  // (veya eşzamanlı katılımlarda pencere zaten eşiği geçmişse) liste artık
  // eşik değerine hiç "eşit" olmayabilir ve raid asla tetiklenmezdi — bu,
  // gerçek bir raid sırasında korumanın sessizce devre dışı kalmasına yol
  // açan ciddi bir tespit hatasıydı.
  if (joins.length < config.raidJoinThreshold) return;

  await sendGuardAlert(
    member.guild,
    config,
    "Olası raid tespit edildi",
    `${config.raidWindowSeconds} saniyede ${joins.length} üye katıldı.${config.raidAutoKick ? " Katılan üyeler otomatik olarak atılıyor." : ""}`,
    // Cooldown olmadan, oto-kick kapalıyken raid penceresi süresince katılan
    // HER yeni üye için ayrı bir uyarı embed'i gönderiliyordu — gerçek bir
    // raid sırasında log kanalını saniyeler içinde onlarca mesajla dolduran
    // bir spam kaynağıydı. Diğer guard alarmlarıyla (massban/masskick) aynı
    // ALERT_COOLDOWN_MS mantığı burada da uygulanıyor.
    `${member.guild.id}:raid-alert`,
  );

  if (!config.raidAutoKick) return;
  const targets = joins.filter((join) => !isTrusted(member.guild, join.id, config));
  recentJoins.delete(member.guild.id);
  // Önceden bu liste TEK TEK, sırayla (await ... for) işleniyordu. Küçük
  // raid'lerde (varsayılan eşik 5) sorun olmuyordu, ama eşik yükseltilip
  // (max 100) gerçek büyük bir raid yaşandığında yüzlerce ardışık
  // fetch+kick isteği Discord'un rate limitine takılıp işlemi yavaşlatabilir
  // ve bir kısmı zaman aşımına uğrayabilirdi. Küçük gruplar halinde paralel
  // işleyerek aynı sonucu (tüm hedefler atılır) daha hızlı ve rate-limit
  // dostu şekilde elde ediyoruz — kullanıcı tarafında davranış değişmiyor.
  const RAID_KICK_BATCH_SIZE = 5;
  for (let i = 0; i < targets.length; i += RAID_KICK_BATCH_SIZE) {
    const batch = targets.slice(i, i + RAID_KICK_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (target) => {
        const targetMember = await member.guild.members.fetch(target.id).catch(() => null);
        if (targetMember?.kickable) {
          await targetMember.kick("Guard: raid tespiti — şüpheli toplu katılım").catch(() => null);
        }
      }),
    );
  }
}

async function handleMassBan(ban: GuildBan): Promise<void> {
  const config = await getGuardConfig(ban.guild.id);
  if (!config.enabled || !config.antiMassBan) return;
  const executorId = await findExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (isTrusted(ban.guild, executorId, config)) return;
  if (!guardThresholdReached(`${ban.guild.id}:massban`, executorId, config.massBanThreshold, config.actionWindowSeconds * 1_000)) return;
  await sendGuardAlert(ban.guild, config, "Olası toplu yasaklama (nuke) girişimi", `${config.actionWindowSeconds} saniyede ${config.massBanThreshold}+ yasaklama işlemi tespit edildi. İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}.`, `${ban.guild.id}:massban-alert`);
  await punishExecutor(ban.guild, config, executorId, `${config.massBanThreshold} yasaklama / ${config.actionWindowSeconds} saniye (toplu yasaklama koruması)`);
}

async function handleMassKick(member: GuildMember, user: User): Promise<void> {
  const config = await getGuardConfig(member.guild.id);
  if (!config.enabled || !config.antiMassKick) return;
  const executorId = await findExecutor(member.guild, AuditLogEvent.MemberKick, user.id);
  if (!executorId) return; // Audit logunda kick kaydı yoksa muhtemelen kullanıcı kendi ayrıldı.
  if (isTrusted(member.guild, executorId, config)) return;
  if (!guardThresholdReached(`${member.guild.id}:masskick`, executorId, config.massKickThreshold, config.actionWindowSeconds * 1_000)) return;
  await sendGuardAlert(member.guild, config, "Olası toplu atma (nuke) girişimi", `${config.actionWindowSeconds} saniyede ${config.massKickThreshold}+ kick işlemi tespit edildi. İşlemi yapan: <@${executorId}>.`, `${member.guild.id}:masskick-alert`);
  await punishExecutor(member.guild, config, executorId, `${config.massKickThreshold} kick / ${config.actionWindowSeconds} saniye (toplu atma koruması)`);
}

async function handlePermissionEscalation(oldRole: Role, newRole: Role): Promise<void> {
  const config = await getGuardConfig(newRole.guild.id);
  if (!config.enabled || !config.antiPermissionEscalation || config.exemptRoleIds.includes(newRole.id)) return;
  const gained = DANGEROUS_PERMISSIONS.filter((perm) => !oldRole.permissions.has(perm) && newRole.permissions.has(perm));

  // İzinler değişmese bile, tehlikeli yetkileri olan bir rol hiyerarşide
  // belirgin biçimde yukarı taşınırsa (ör. @everyone'ın çok üstüne veya
  // botun rolüne yaklaştırılırsa) bu da bir yetki genişletme girişimi
  // olabilir — pozisyonu otomatik geri almıyoruz (sıralama karmaşık ve
  // yanlışlıkla başka rolleri de kaydırabilir), ama en azından uyarıyoruz.
  const positionJump = newRole.position - oldRole.position;
  const hasDangerousPerm = DANGEROUS_PERMISSIONS.some((perm) => newRole.permissions.has(perm));
  if (positionJump >= ROLE_POSITION_JUMP_THRESHOLD && hasDangerousPerm) {
    const executorId = await findExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    if (!isTrusted(newRole.guild, executorId, config)) {
      await sendGuardAlert(
        newRole.guild,
        config,
        "Şüpheli rol hiyerarşisi değişikliği",
        `Tehlikeli yetkilere sahip **${newRole.name}** rolü hiyerarşide ${positionJump} basamak yukarı taşındı. İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}. Bu bilinçli bir yönetim kararı değilse rol sıralamasını kontrol et.`,
        `${newRole.guild.id}:role-position-alert:${newRole.id}`,
      );
      await punishExecutor(newRole.guild, config, executorId, `Şüpheli rol hiyerarşisi değişikliği: ${positionJump} basamak`);
    }
  }

  if (gained.length === 0) return;
  const executorId = await findExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
  if (isTrusted(newRole.guild, executorId, config)) return;

  let reverted = false;
  try {
    await newRole.setPermissions(oldRole.permissions, "Guard: yetkisiz yetki yükseltme girişimi geri alındı");
    reverted = true;
  } catch (error) {
    console.error(`[guard] rol yetkisi alınamadı (${newRole.id}):`, error);
  }

  const permNames = gained.map((perm) => Object.entries(PermissionsBitField.Flags).find(([, value]) => value === perm)?.[0] ?? "Bilinmeyen").join(", ");
  await sendGuardAlert(
    newRole.guild,
    config,
    reverted ? "Yetki yükseltme engellendi" : "Yetki yükseltme engellenemedi",
    `**${newRole.name}** rolüne tehlikeli yetkiler eklendi: **${permNames}**. ${reverted ? "Değişiklik geri alındı." : "Değişiklik geri alınamadı (bot yetkisini kontrol et)."} İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}.`,
  );
  await punishExecutor(newRole.guild, config, executorId, `Yetkisiz yetki yükseltme: ${permNames}`);
}

// Yalnızca rolün kendi yetkileri değiştirildiğinde değil, bir üyeye
// zaten var olan tehlikeli yetkili bir rol *atandığında* da yetki
// yükseltmesi olur (ör. ManageRoles yetkisi olan biri kendine/başkasına
// mevcut bir admin rolünü verebilir). handlePermissionEscalation bunu
// yakalamaz çünkü o yalnızca GuildRoleUpdate'i (rolün izinlerinin
// değişimini) dinler — bu yüzden ayrı bir kontrol gerekiyordu.
async function handleMemberRoleGrant(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): Promise<void> {
  const config = await getGuardConfig(newMember.guild.id);
  if (!config.enabled || !config.antiPermissionEscalation) return;
  // oldMember partial (önbellekte tam veri yoksa) gelirse rol farkı
  // güvenilir hesaplanamaz — yanlışlıkla üyenin ZATEN sahip olduğu tüm
  // tehlikeli rolleri "yeni eklenmiş" sanıp geri almak, gerçek bir
  // koruma yerine yanlış alarm/hasar üretirdi. Böyle durumda pas geç.
  if (oldMember.partial) return;
  const gained = DANGEROUS_PERMISSIONS.filter((perm) => !oldMember.permissions.has(perm) && newMember.permissions.has(perm));
  if (gained.length === 0) return;
  if (isTrusted(newMember.guild, newMember.id, config)) return;

  const addedRoles = newMember.roles.cache.filter((role) => !oldMember.roles.cache.has(role.id));
  // Panelde açıkça muaf sayılan bir rol atanıyorsa (ör. güvenilir bir
  // yardımcı-yönetici rolü), bu bilinçli bir yönetim kararıdır — guard
  // bunu "saldırı" sanıp geri almamalı.
  const dangerousRoles = addedRoles.filter((role) => !config.exemptRoleIds.includes(role.id) && DANGEROUS_PERMISSIONS.some((perm) => role.permissions.has(perm)));
  if (dangerousRoles.size === 0) return;

  const executorId = await findExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
  if (isTrusted(newMember.guild, executorId, config)) return;

  let reverted = false;
  try {
    await newMember.roles.remove(dangerousRoles, "Guard: yetkisiz yetki yükseltme (rol atama) girişimi geri alındı");
    reverted = true;
  } catch (error) {
    console.error(`[guard] tehlikeli rol alınamadı (${newMember.id}):`, error);
  }

  const permNames = gained.map((perm) => Object.entries(PermissionsBitField.Flags).find(([, value]) => value === perm)?.[0] ?? "Bilinmeyen").join(", ");
  const roleNames = dangerousRoles.map((role) => role.name).join(", ");
  await sendGuardAlert(
    newMember.guild,
    config,
    reverted ? "Yetki yükseltme (rol atama) engellendi" : "Yetki yükseltme (rol atama) engellenemedi",
    `${newMember.user.tag} kullanıcısına tehlikeli yetkiler taşıyan **${roleNames}** rolü verildi (**${permNames}**). ${reverted ? "Rol geri alındı." : "Rol geri alınamadı (bot yetkisini ve rol hiyerarşisini kontrol et)."} İşlemi yapan: ${executorId ? `<@${executorId}>` : "belirlenemedi"}.`,
  );
  await punishExecutor(newMember.guild, config, executorId, `Yetkisiz yetki yükseltme (rol atama): ${permNames}`);
}

// Sunucu sahipliği tüm izin kontrollerinin üzerindedir (owner her zaman
// "yetkili" sayılır) — bu yüzden sahiplik devri, olabilecek en büyük
// yetki yükseltmesidir. Guard bunu geri alamaz (yalnızca mevcut sahip
// devredebilir) ama sessizce geçmemeli; her zaman anında ve muafiyet
// gözetmeksizin uyarı gönderir.
async function handleOwnerTransfer(oldGuild: Guild, newGuild: Guild): Promise<void> {
  if (oldGuild.ownerId === newGuild.ownerId) return;
  const config = await getGuardConfig(newGuild.id);
  if (!config.enabled || !config.antiPermissionEscalation) return;
  await sendGuardAlert(
    newGuild,
    config,
    "Sunucu sahipliği değişti",
    `Sunucu sahipliği <@${oldGuild.ownerId}> kullanıcısından <@${newGuild.ownerId}> kullanıcısına devredildi. Bu işlemi sen yapmadıysan hesap güvenliğini derhal kontrol et — sahiplik tüm guard korumalarını atlatabilir.`,
  );
}

function toButtonEmoji(markup: string): { id: string; name?: string; animated?: boolean } | undefined {
  const match = markup.match(/^<a?:([^:>]+):(\d+)>$/);
  return match ? { id: match[2], name: match[1], animated: markup.startsWith("<a:") } : undefined;
}
const PROFILE_BUTTON_EMOJIS: Record<string, string> = { off: EMOJIS.error, low: EMOJIS.alert, medium: EMOJIS.info, high: EMOJIS.active };
function profileButton(id: string, label: string, style: ButtonStyle, active: boolean): ButtonBuilder {
  const emoji = active ? EMOJIS.success : PROFILE_BUTTON_EMOJIS[id] ?? EMOJIS.info;
  return new ButtonBuilder().setCustomId(`guard_profile_${id}`).setLabel(resolveEmojis(`${active ? "✓ " : ""}${label}`)).setStyle(active ? ButtonStyle.Success : style).setEmoji(toButtonEmoji(emoji) ?? emoji);
}

const GUARD_MODULE_KEYS = ["antiRoleDelete", "antiChannelDelete", "antiBotAdd", "antiRaid", "antiMassBan", "antiMassKick", "antiPermissionEscalation"] as const;
const CORE_MODULES: { key: "antiRoleDelete" | "antiChannelDelete" | "antiBotAdd" | "antiRaid" | "raidAutoKick"; label: string }[] = [
  { key: "antiRoleDelete", label: "Rol silme" },
  { key: "antiChannelDelete", label: "Kanal silme" },
  { key: "antiBotAdd", label: "Bot ekleme" },
  { key: "antiRaid", label: "Raid" },
  { key: "raidAutoKick", label: "Raid oto-kick" },
];
const NUKE_MODULES: { key: "antiMassBan" | "antiMassKick" | "antiPermissionEscalation"; label: string }[] = [
  { key: "antiMassBan", label: "Toplu ban" },
  { key: "antiMassKick", label: "Toplu kick" },
  { key: "antiPermissionEscalation", label: "Yetki koruması" },
];
export const GUARD_CORE_SELECT_KEYS = CORE_MODULES.map((module) => module.key);
export const GUARD_NUKE_SELECT_KEYS = NUKE_MODULES.map((module) => module.key);
function guardScoreBar(active: number, total: number): string {
  const filled = Math.round((active / total) * 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

export async function buildGuardPanel(guildId: string) {
  const config = await getGuardConfig(guildId);
  const on = (value: boolean): string => value ? "Açık" : "Kapalı";
  const allOn = config.antiRoleDelete && config.antiChannelDelete && config.antiBotAdd && config.antiRaid && config.antiMassBan && config.antiMassKick && config.antiPermissionEscalation;
  const coreOn = config.antiRoleDelete && config.antiBotAdd && config.antiRaid && config.antiMassBan && config.antiMassKick;
  const profile = !config.enabled ? "Kapalı" : allOn ? "Yüksek" : coreOn ? "Orta" : config.antiBotAdd && !config.antiRoleDelete && !config.antiChannelDelete && !config.antiRaid ? "Düşük" : "Özel";
  const profileEmoji = profile === "Yüksek" ? EMOJIS.active : profile === "Orta" ? EMOJIS.info : profile === "Düşük" ? EMOJIS.alert : profile === "Kapalı" ? EMOJIS.error : EMOJIS.prm1;
  const activeModules = GUARD_MODULE_KEYS.filter((key) => config[key]).length;
  const scoreLine = config.enabled
    ? `${guardScoreBar(activeModules, GUARD_MODULE_KEYS.length)}  **${activeModules}/${GUARD_MODULE_KEYS.length}** modül aktif`
    : `${guardScoreBar(0, GUARD_MODULE_KEYS.length)}  koruma devre dışı`;
  const embed = brandBanner(
    new V2CardBuilder()
      .setColor(config.enabled ? COLORS.success : COLORS.brand)
      .setAuthor({ name: BOT_NAME })
      .setTitle(`${EMOJIS.admin} Guard Güvenlik Merkezi`)
      .setDescription(
        `Sunucunu koruyan event tabanlı güvenlik sistemi.\n` +
        `${config.enabled ? EMOJIS.success : EMOJIS.error} **Genel Durum:** ${on(config.enabled)}   •   ${profileEmoji} **Profil:** ${profile}\n` +
        `${scoreLine}` +
        (config.enabled ? "" : `\n\n${EMOJIS.alert} Guard **varsayılan olarak kapalıdır**. Sunucunu korumaya almak için aşağıdan bir profil seç.`),
      )
      .addFields(
        { name: `${EMOJIS.general} Temel Koruma`, value: [`${config.antiRoleDelete ? EMOJIS.success : EMOJIS.error} Rol silme — **${on(config.antiRoleDelete)}**`, `${config.antiChannelDelete ? EMOJIS.success : EMOJIS.error} Kanal silme — **${on(config.antiChannelDelete)}**`, `${config.antiBotAdd ? EMOJIS.success : EMOJIS.error} Bot ekleme — **${on(config.antiBotAdd)}**`, `${config.antiRaid ? EMOJIS.success : EMOJIS.error} Raid — **${on(config.antiRaid)}**${config.antiRaid && config.raidAutoKick ? " *(oto-kick)*" : ""}`].join("\n"), inline: true },
        { name: `${EMOJIS.alert} Anti-Nuke`, value: [`${config.antiMassBan ? EMOJIS.success : EMOJIS.error} Toplu yasaklama — **${on(config.antiMassBan)}**`, `${config.antiMassKick ? EMOJIS.success : EMOJIS.error} Toplu atma — **${on(config.antiMassKick)}**`, `${config.antiPermissionEscalation ? EMOJIS.success : EMOJIS.error} Yetki yükseltme — **${on(config.antiPermissionEscalation)}**`, "*(rol izni değişimi + tehlikeli rol ataması dahil)*"].join("\n"), inline: true },
        { name: "\u200b", value: "\u200b", inline: true },
        { name: `${EMOJIS.suite} Eşikler`, value: `Rol **${config.roleDeleteThreshold}**/${config.actionWindowSeconds}sn　Kanal **${config.channelDeleteThreshold}**/${config.actionWindowSeconds}sn\nBot **${config.botAddThreshold}**/${config.actionWindowSeconds}sn　Raid **${config.raidJoinThreshold}**/${config.raidWindowSeconds}sn\nBan **${config.massBanThreshold}**/${config.actionWindowSeconds}sn　Kick **${config.massKickThreshold}**/${config.actionWindowSeconds}sn`, inline: false },
        { name: `${EMOJIS.mod} Müdahale`, value: `Ceza: **${config.actionPunishment === "none" ? "Yok" : config.actionPunishment}**\nKanal kurtarma: **${on(config.restoreDeletedChannels)}**\nLog: ${config.logChannelId ? `<#${config.logChannelId}>` : "Sistem kanalı"}`, inline: true },
        { name: `${EMOJIS.role} Muafiyet Özeti`, value: `Kullanıcı: **${config.exemptUserIds.length}**\nRol: **${config.exemptRoleIds.length}**\nKanal: **${config.exemptChannelIds.length}**`, inline: true },
      )
      .setFooter({ text: "Guard • Profil seç veya modülleri tek tek yönet" })
      .setTimestamp(),
  );
  const profiles = new ActionRowBuilder<ButtonBuilder>().addComponents(
    profileButton("off", "Guard Kapalı", ButtonStyle.Danger, profile === "Kapalı"), profileButton("low", "Düşük", ButtonStyle.Secondary, profile === "Düşük"), profileButton("medium", "Orta", ButtonStyle.Primary, profile === "Orta"), profileButton("high", "Yüksek", ButtonStyle.Success, profile === "Yüksek"), new ButtonBuilder().setCustomId("guard_refresh").setLabel(resolveEmojis("Yenile")).setEmoji(toButtonEmoji(EMOJIS.loading) ?? EMOJIS.loading).setStyle(ButtonStyle.Secondary),
  );
  const coreSelect = new StringSelectMenuBuilder()
    .setCustomId("guard_select_core")
    .setPlaceholder(resolveEmojis("🛡️ Temel Koruma — modülleri seç"))
    .setMinValues(0)
    .setMaxValues(CORE_MODULES.length)
    .addOptions(CORE_MODULES.map(({ key, label }) => ({
      label: resolveEmojis(label), value: key, default: config[key], emoji: config[key] ? EMOJIS.active : EMOJIS.error,
    })));
  const nukeSelect = new StringSelectMenuBuilder()
    .setCustomId("guard_select_nuke")
    .setPlaceholder(resolveEmojis("⚔️ Anti-Nuke — modülleri seç"))
    .setMinValues(0)
    .setMaxValues(NUKE_MODULES.length)
    .addOptions(NUKE_MODULES.map(({ key, label }) => ({
      label: resolveEmojis(label), value: key, default: config[key], emoji: config[key] ? EMOJIS.active : EMOJIS.error,
    })));
  const core = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(coreSelect);
  const nuke = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(nukeSelect);
  const advanced = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("guard_open_advanced").setLabel(resolveEmojis("Muafiyet & log ayarları")).setStyle(ButtonStyle.Secondary));
  return { flags: COMPONENTS_V2_FLAG, components: [embed, profiles, core, nuke, advanced] };
}

export async function buildGuardAdvancedPanel(guildId: string) {
  const config = await getGuardConfig(guildId);
  const embed = new V2CardBuilder().setColor(COLORS.brand).setAuthor({ name: BOT_NAME }).setTitle(`${EMOJIS.admin} Guard — Gelişmiş Ayarlar`).addFields(
    { name: `${EMOJIS.roly} Log Kanalı`, value: config.logChannelId ? `<#${config.logChannelId}>` : "Sistem kanalı", inline: true },
    { name: `${EMOJIS.mod} Eşik Sonrası Ceza`, value: config.actionPunishment === "none" ? "Yok" : config.actionPunishment, inline: true },
    { name: `${EMOJIS.active} Kanal Geri Yükleme`, value: config.restoreDeletedChannels ? "Açık" : "Kapalı", inline: true },
    { name: `${EMOJIS.role} Muafiyetler`, value: `Kullanıcı **${config.exemptUserIds.length}**　Rol **${config.exemptRoleIds.length}**　Kanal **${config.exemptChannelIds.length}**`, inline: false },
  ).setDescription(`Aşağıdaki menülerden seçim yapmak öğeyi ekler; aynı öğeyi tekrar seçersen kaldırır.\n\n${EMOJIS.suite} **Temel Eşikler** ve **Anti-Nuke Eşikleri** butonlarından tüm zaman pencerelerini/eşik sayılarını değiştirebilirsin.`).setFooter({ text: "Guard • Gelişmiş Ayarlar" }).setTimestamp();
  const logSelect = new ChannelSelectMenuBuilder().setCustomId("guard_select_log_channel").setPlaceholder(resolveEmojis("Guard log kanalı seç")).setChannelTypes(ChannelType.GuildText);
  if (config.logChannelId) logSelect.setDefaultChannels(config.logChannelId);
  const channel = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(logSelect);
  const role = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("guard_select_exempt_role").setPlaceholder(resolveEmojis("Muaf rol seç (ekle veya kaldır)")));
  const user = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId("guard_select_exempt_user").setPlaceholder(resolveEmojis("Muaf kullanıcı seç (ekle veya kaldır)")));
  const exemptChannel = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId("guard_select_exempt_channel").setPlaceholder(resolveEmojis("Muaf kanal seç (ekle veya kaldır)")).setChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory));
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("guard_open_thresholds").setLabel(resolveEmojis("Temel Eşikler")).setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId("guard_open_nuke_thresholds").setLabel(resolveEmojis("Anti-Nuke Eşikleri")).setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId("guard_open_penalty").setLabel(resolveEmojis("Ceza & Kurtarma")).setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId("guard_clear_lists").setLabel(resolveEmojis("Muafları Temizle")).setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId("guard_back_panel").setLabel(resolveEmojis("Panele Dön")).setStyle(ButtonStyle.Secondary));
  return { flags: COMPONENTS_V2_FLAG, components: [embed, role, user, exemptChannel, channel, actions] };
}

export function registerGuardEvents(client: Client): void {
  if (registeredClients.has(client)) return;
  registeredClients.add(client);
  client.on(Events.GuildRoleDelete, (role) => void handleRoleDelete(role).catch((error: unknown) => console.error("guard rol patladı:", error)));
  client.on(Events.ChannelDelete, (channel) => { if (!channel.isDMBased()) void handleChannelDelete(channel).catch((error: unknown) => console.error("guard kanal patladı:", error)); });
  client.on(Events.GuildMemberAdd, (member) => void handleBotAdd(member).catch((error: unknown) => console.error("guard bot patladı:", error)));
  client.on(Events.GuildIntegrationsUpdate, (guild) => void handleIntegrationAdd(guild).catch((error: unknown) => console.error("guard entegrasyon patladı:", error)));
  client.on(Events.GuildMemberAdd, (member) => void handleRaidJoin(member).catch((error: unknown) => console.error("guard raid patladı:", error)));
  client.on(Events.GuildBanAdd, (ban) => void handleMassBan(ban).catch((error: unknown) => console.error("guard toplu ban patladı:", error)));
  client.on(Events.GuildMemberRemove, (member) => void handleMassKick(member as GuildMember, member.user).catch((error: unknown) => console.error("guard toplu kick patladı:", error)));
  client.on(Events.GuildRoleUpdate, (oldRole, newRole) => void handlePermissionEscalation(oldRole, newRole).catch((error: unknown) => console.error("guard yetki patladı:", error)));
  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => void handleMemberRoleGrant(oldMember, newMember).catch((error: unknown) => console.error("guard rol atama patladı:", error)));
  client.on(Events.GuildUpdate, (oldGuild, newGuild) => void handleOwnerTransfer(oldGuild, newGuild).catch((error: unknown) => console.error("guard sahiplik devri patladı:", error)));
}

export function getDefaultGuardConfig(): GuardConfig { return { ...DEFAULT_CONFIG, exemptUserIds: [], exemptRoleIds: [], exemptChannelIds: [] }; }
