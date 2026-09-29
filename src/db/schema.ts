// Not: Neon/PostgreSQL (drizzle-orm) kaldırıldı. Tablolar artık data/db/<tablo>.json
// dosyalarında tutuluyor — bkz. ./jsonOrm.ts. Tablo/kolon adları ve tipleri
// eski PostgreSQL şemasıyla BİREBİR aynıdır (Neon dökümü bu adlarla içe aktarılır).
import { jsonTable as pgTable, text, timestamp, serial, integer, boolean, jsonb } from "./jsonOrm.js";

export const warningsTable = pgTable("discord_warnings", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  guildId: text("guild_id").notNull(),
  reason: text("reason").notNull(),
  moderatorId: text("moderator_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Warning = typeof warningsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Özel üye (VIP) listesi. Eskiden sadece bellekte (Set) tutuluyordu — artık
// kalıcı.
// ---------------------------------------------------------------------------
export const vipUsersTable = pgTable("discord_vip_users", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export type VipUser = typeof vipUsersTable.$inferSelect;

// ---------------------------------------------------------------------------
// Genel amaçlı key-value ayar tablosu. Son aktiflik zamanı, otomatik cevaplar
// ve sunucu prefix'leri gibi runtime ayarları için kullanılır.
// ---------------------------------------------------------------------------
export const botSettingsTable = pgTable("discord_bot_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BotSetting = typeof botSettingsTable.$inferSelect;
// 📋 Yetkilendirme Sistemi
export const userPermissionsTable = pgTable("discord_user_permissions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  targetId: text("target_id").notNull(),
  targetType: text("target_type").notNull(), // "user" veya "role"
  permission: text("permission").notNull(), // "ban", "kick", "mute", "unban", "warn", "uyarilar"
  grantedBy: text("granted_by").notNull(),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
}, {
  // Eski PostgreSQL tablosundaki UNIQUE(guild_id, target_id, target_type, permission)
  unique: [["guildId", "targetId", "targetType", "permission"]],
});

// ---------------------------------------------------------------------------
// 🛡️ Otomod: sunucu bazlı ayarlar. Kelime/rol/kanal listeleri JSON dizi
// olarak text kolonda tutulur (ör: '["kelime1","kelime2"]') — ekstra tabloya
// gerek kalmadan basit tutmak için. Muafiyet: sunucu sahibi, bot sahibi
// (owner) ve exemptRoleIds'teki roller — Administrator yetkisi TEK BAŞINA
// muafiyet sağlamaz (bilinçli tercih). Bkz. automod/automod.ts isExempt().
// ---------------------------------------------------------------------------
export const automodConfigTable = pgTable("discord_automod_config", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  bannedWords: boolean("banned_words").notNull().default(false),
  inviteLinks: boolean("invite_links").notNull().default(false),
  spamFlood: boolean("spam_flood").notNull().default(false),
  capsLock: boolean("caps_lock").notNull().default(false),
  wordList: text("word_list").notNull().default("[]"),
  removedDefaults: text("removed_defaults").notNull().default("[]"),
  inviteAllowedChannelIds: text("invite_allowed_channel_ids").notNull().default("[]"),
  exemptRoleIds: text("exempt_role_ids").notNull().default("[]"),
  logChannelId: text("log_channel_id"),
  strikesBeforeTimeout: integer("strikes_before_timeout").notNull().default(3),
  baseTimeoutMinutes: integer("base_timeout_minutes").notNull().default(1),
  maxTimeoutMinutes: integer("max_timeout_minutes").notNull().default(60),
  strikeResetMinutes: integer("strike_reset_minutes").notNull().default(30),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AutomodConfigRow = typeof automodConfigTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🛡️ Otomod: kullanıcı başına ihlal (strike) sayacı. `key` = "guildId:userId"
// — tekil satır garantisi ve hızlı upsert için.
// ---------------------------------------------------------------------------
export const automodStrikesTable = pgTable("discord_automod_strikes", {
  key: text("key").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  count: integer("count").notNull().default(0),
  lastViolation: timestamp("last_violation").notNull().defaultNow(),
});

export type AutomodStrikeRow = typeof automodStrikesTable.$inferSelect;

// ---------------------------------------------------------------------------
// 💤 AFK sistemi: kullanıcı başına tek satır (sunucular arası ortak — bir
// kullanıcı tek AFK durumuna sahip olabilir, diğer bot komutlarındaki
// desenle aynı: `key` yerine burada zaten tekil olan userId birincil anahtar).
// ---------------------------------------------------------------------------
export const afkTable = pgTable("discord_afk", {
  userId: text("user_id").primaryKey(),
  reason: text("reason").notNull(),
  since: timestamp("since").notNull().defaultNow(),
});

export type AfkRow = typeof afkTable.$inferSelect;

// ---------------------------------------------------------------------------
// 👋 Hoşgeldin sistemi: sunucu bazlı tek satır. `message` içinde {n}, {kullanici},
// {isim}, {sunucu} gibi placeholder'lar barınabilir (bkz. welcome/render.ts) —
// düz metin olarak saklanır, Discord tarafında zaten markdown/kod bloğu
// desteklenir, ekstra bir işleme gerek yok.
// ---------------------------------------------------------------------------
export const welcomeConfigTable = pgTable("discord_welcome_config", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  channelId: text("channel_id"),
  message: text("message"),
  // 👋 Ayrılış (görüşürüz) mesajı: aynı kanala, üye sunucudan ayrıldığında
  // gönderilir. null ise görüşürüz mesajı gönderilmez (opsiyonel).
  leaveMessage: text("leave_message"),
  // 🖼️ Giriş/çıkış görseli: mesajın altına eklenen bir resim URL'si (opsiyonel).
  // Bkz. welcome/panel.ts — "Giriş Görseli"/"Çıkış Görseli" butonları.
  welcomeImage: text("welcome_image"),
  leaveImage: text("leave_image"),
  // 🌐 Hoşgeldin mesajının altına web paneli tanıtım satırı eklenir mi?
  // Bkz. events/welcome.ts — cfg.panelPromo açıkken mesaja eklenir.
  panelPromo: boolean("panel_promo").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WelcomeConfigRow = typeof welcomeConfigTable.$inferSelect;

// NOT: Custom Event sistemi (!customevent) artık DB'de DEĞİL, düz bir JSON
// dosyasında (data/custom-events.json) saklanıyor — bkz. src/customEvents/store.ts.
// db/index.ts'deki `discord_custom_commands` tablosu kullanılmıyor (dokunulmadı,
// zararsız/boş duruyor).

// ---------------------------------------------------------------------------
// 💎 Premium sistem: Gemini destekli komutlar (kod-yaz, ozetle, sor, vb.)
// sadece premium kullanıcılara açık. Premium KALICIDIR (süresi yok, sadece
// !premium-kaldir ile geri alınır) ve SADECE bot sahibi tarafından `!premium`
// ile verilebilir — bkz. commands/owner/premium.ts.
// ---------------------------------------------------------------------------
export const premiumUsersTable = pgTable("discord_premium_users", {
  userId: text("user_id").primaryKey(),
  grantedBy: text("granted_by").notNull(),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
});

export type PremiumUserRow = typeof premiumUsersTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🎟️ Günlük AI deneme hakkı (2026-09-28): premium olmayan kullanıcılar AI
// komutlarını günde toplam 3 kez kullanabilir. `key` = "userId:YYYY-MM-DD"
// (gün Europe/Istanbul'a göre) — tüm AI komutları ortak havuzdan yer.
// Gece yarısı otomatik yenilenir, eski günlerin satırları zararsız durur.
// ---------------------------------------------------------------------------
export const dailyTrialsTable = pgTable("discord_daily_trials", {
  key: text("key").primaryKey(),
  userId: text("user_id").notNull(),
  day: text("day").notNull(),
  uses: integer("uses").notNull().default(0),
});

export type DailyTrialRow = typeof dailyTrialsTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🪪 Yarı-yetkili (half-owner) listesi: bot sahibinin SADECE premium VERME
// yetkisini devrettiği kullanıcılar — bkz. premium/halfOwners.ts. Half-owner
// olmak owner olmak DEĞİLDİR: restart/eval gibi tehlikeli owner
// komutları bu tabloya hiç bakmaz, her zaman doğrudan OWNER_ID kontrolü yapar.
// ---------------------------------------------------------------------------
export const halfOwnersTable = pgTable("discord_half_owners", {
  userId: text("user_id").primaryKey(),
  addedBy: text("added_by").notNull(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export type HalfOwnerRow = typeof halfOwnersTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🧠 Bilgi Yarışması (!bilgiyarismasi): sunucu bazlı skor tablosu. `key` =
// "guildId:userId" (bkz. automodStrikesTable'daki aynı desen) — tekil satır
// garantisi ve hızlı upsert (ON CONFLICT) için.
// ---------------------------------------------------------------------------
export const quizScoresTable = pgTable("discord_quiz_scores", {
  key: text("key").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  wins: integer("wins").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type QuizScoreRow = typeof quizScoresTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🔤 Kelime Zinciri: artık geçici bir "etkinlik" değil, sunucuya kalıcı olarak
// bağlanan bir kanal sistemi. `guild_id` PK'dır — bir sunucuda tek bir kelime
// zinciri kanalı olabilir. Aktif zincirin durumu (son kelime, gereken harf,
// kullanılan kelimeler, mevcut seri) VE tüm zamanların rekoru aynı satırda
// tutulur, böylece bot yeniden başlasa da (restart, deploy, çökme) oyun
// kaldığı yerden devam eder — bkz. utils/wordchain.ts.
// ---------------------------------------------------------------------------
export const wordChainChannelsTable = pgTable("discord_wordchain_channels", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  lastWord: text("last_word"),
  requiredLetter: text("required_letter"),
  usedWords: text("used_words").notNull().default("[]"), // JSON string[]
  streak: integer("streak").notNull().default(0),
  lastPlayerId: text("last_player_id"),
  bestStreak: integer("best_streak").notNull().default(0),
  bestHolderId: text("best_holder_id"),
  setBy: text("set_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WordChainChannelRow = typeof wordChainChannelsTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🔤 Kelime Zinciri: kullanılmış kelimeler — eskiden `wordChainChannelsTable`
// içinde tek bir büyüyen JSON string kolonundaydı (her yeni kelimede TÜM
// liste yeniden yazılıyordu, bu da hem yer hem I/O israfıydı). Artık her
// kelime kendi satırı — tekrar kontrolü PK üzerinden index'li, yeni kelime
// eklemek tek satırlık bir INSERT.
// ---------------------------------------------------------------------------
export const wordChainUsedWordsTable = pgTable(
  "discord_wordchain_used_words",
  {
    channelId: text("channel_id").notNull(),
    word: text("word").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  { primaryKey: ["channelId", "word"] },
);

export type WordChainUsedWordRow = typeof wordChainUsedWordsTable.$inferSelect;

// 🔤 Kelime Zinciri: sunucu bazında oyuncuların kabul edilen kelime sayısı.
// `!kelime skor` bu tabloyu kullanır; zincirin anlık/re­kor serisinden ayrıdır.
export const wordChainScoresTable = pgTable(
  "discord_wordchain_scores",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    words: integer("words").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  { primaryKey: ["guildId", "userId"] },
);

export type WordChainScoreRow = typeof wordChainScoresTable.$inferSelect;

// ---------------------------------------------------------------------------
// Custom Event (!customevent) kayıtları. Eskiden ham SQL ile
// `discord_custom_commands` tablosunda tutuluyordu; artık diğer tablolar gibi
// data/db/discord_custom_commands.json içinde. `config` = { code, enabled,
// restrictions } nesnesi. UNIQUE(guild_id, name).
// ---------------------------------------------------------------------------
export const customCommandsTable = pgTable(
  "discord_custom_commands",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    type: text("type").notNull(),
    config: jsonb("config").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  { unique: [["guildId", "name"]] },
);

export type CustomCommandRow = typeof customCommandsTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🎁 Davet Ödül Sistemi: botu yeni sunuculara davet eden kullanıcılar.
// `invites` = hak kazanılmış (7 gün + min. üye şartını geçmiş) davet sayısı.
// `pendingInvites` = bekleyenler: [{ guildId, guildName, joinedAt, source }]
// `countedGuilds` = sayılmış sunucu ID'leri (aynı sunucu iki kez sayılmaz).
// `badges` = kazanılmış rozet anahtarları (["elci", "elit", ...]).
// ---------------------------------------------------------------------------
export const inviteRewardsTable = pgTable("discord_invite_rewards", {
  userId: text("user_id").primaryKey(),
  invites: integer("invites").notNull().default(0),
  pendingInvites: jsonb("pending_invites"),
  countedGuilds: jsonb("counted_guilds"),
  badges: jsonb("badges"),
  /** 👑 Efsane Elçi'nin son premium hediye tarihi (!hediye 30 gün bekleme için). */
  lastGiftAt: timestamp("last_gift_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type InviteRewardRow = typeof inviteRewardsTable.$inferSelect;

// Hediye premium (süreli): !hediye komutuyla verilir, süresi dolunca düşer.
// Kalıcı premium listesinden ayrı tutulur (bkz. premium/store.ts).
export const premiumGiftsTable = pgTable("discord_premium_gifts", {
  userId: text("user_id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  grantedBy: text("granted_by").notNull(),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
});

export type PremiumGiftRow = typeof premiumGiftsTable.$inferSelect;

// Kalıcı hatırlatıcılar (!hatirlat): DB'de tutulur, bot restart atsa bile
// kaybolmaz. Açılışta yüklenip zamanlanır (bkz. utils/reminders.ts).
export const remindersTable = pgTable("discord_reminders", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  guildId: text("guild_id"),
  channelId: text("channel_id").notNull(),
  note: text("note").notNull(),
  dueAt: timestamp("due_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ReminderRow = typeof remindersTable.$inferSelect;

// Kullanıcının seçtiği embed vurgu rengi (!renk komutu, premium özelliği).
export const userColorsTable = pgTable("discord_user_colors", {
  userId: text("user_id").primaryKey(),
  color: integer("color").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UserColorRow = typeof userColorsTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🎭 Rol menüleri (!butonrol / !emojirol / !kategorirol): restart-proof.
// Menü tanımı DB'de durur; buton customId'leri `rm:<menuId>:<roleId>`,
// select menü `rms:<menuId>` — interactionCreate DB'den çözümler. Açılışta
// reconcileRoleMenus() silinmiş mesajları yeniden gönderir.
// ---------------------------------------------------------------------------
export const roleMenusTable = pgTable("discord_role_menus", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  type: text("type").notNull(), // "button" | "select" | "reaction"
  title: text("title").notNull(),
  config: text("config").notNull(), // JSON: { items: [{ roleId, label?, emoji? }] }
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type RoleMenuRow = typeof roleMenusTable.$inferSelect;
export interface RoleMenuItem {
  roleId: string;
  label?: string;
  emoji?: string;
}
export interface RoleMenuConfig {
  items: RoleMenuItem[];
}

// ---------------------------------------------------------------------------
// ⏳ Süreli roller (!sürelirol): satır durdukça rolün vadesi bellidir.
// Açılışta reconcileTimedRoles() vadesi gelenleri düşürür, kalanları
// zamanlar. Dakikalık süpürme kaçanları yakalar.
// ---------------------------------------------------------------------------
export const timedRolesTable = pgTable("discord_timed_roles", {
  key: text("key").primaryKey(), // "guildId:userId:roleId"
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  roleId: text("role_id").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  grantedBy: text("granted_by").notNull(),
});

export type TimedRoleRow = typeof timedRolesTable.$inferSelect;

// ---------------------------------------------------------------------------
// 👋 Tekrar hoşgeldin (!tekrarhoşgeldin): sunucu bazında açma/kapama + süre
// ve kullanıcı son aktiflik zamanları. Eskiden data/welcome-back-*.json
// dosyalarındaydı; 2026-09-27'de SQLite'a taşındı (tek seferlik taşıma
// welcomeback/store.ts'te, eski JSON'lar yedek olarak durur).
// ---------------------------------------------------------------------------
export const welcomebackSettingsTable = pgTable("discord_welcomeback_settings", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  durationMinutes: integer("duration_minutes").notNull().default(120),
});

export type WelcomebackSettingsRow = typeof welcomebackSettingsTable.$inferSelect;

export const welcomebackActivityTable = pgTable("discord_welcomeback_activity", {
  key: text("key").primaryKey(), // "guildId:userId"
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  lastActiveAt: timestamp("last_active_at").notNull(),
});

export type WelcomebackActivityRow = typeof welcomebackActivityTable.$inferSelect;

// ---------------------------------------------------------------------------
// 💍 Evlilik (!evlen/!boşan/!eş): iki taraf da kendi satırıyla eşine işaret
// eder; tek taraflı sorgu yeterli olur.
// ---------------------------------------------------------------------------
export const marriageTable = pgTable("discord_marriages", {
  userId: text("user_id").primaryKey(),
  partnerId: text("partner_id").notNull(),
  marriedAt: timestamp("married_at").notNull().defaultNow(),
});

export type MarriageRow = typeof marriageTable.$inferSelect;

// ---------------------------------------------------------------------------
// 📝 Kişisel notlar (!not/!notlar): kullanıcı başına en fazla 25 not.
// ---------------------------------------------------------------------------
export const noteTable = pgTable("discord_notes", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type NoteRow = typeof noteTable.$inferSelect;

// ---------------------------------------------------------------------------
// ⭐ İtibar (!rep): skor + veren başına 24 saat bekleme.
// ---------------------------------------------------------------------------
export const repTable = pgTable("discord_rep", {
  userId: text("user_id").primaryKey(),
  score: integer("score").notNull().default(0),
});

export type RepRow = typeof repTable.$inferSelect;

export const repCooldownTable = pgTable("discord_rep_cooldown", {
  giverId: text("giver_id").primaryKey(),
  lastGivenAt: timestamp("last_given_at").notNull().defaultNow(),
});

export type RepCooldownRow = typeof repCooldownTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🎂 Doğum günleri (!doğumgünü/!doğumgünleri): gün+ay, yıl tutulmaz.
// ---------------------------------------------------------------------------
export const birthdayTable = pgTable("discord_birthdays", {
  userId: text("user_id").primaryKey(),
  day: integer("day").notNull(),
  month: integer("month").notNull(),
});

export type BirthdayRow = typeof birthdayTable.$inferSelect;

// ---------------------------------------------------------------------------
// 📊 Sayaç (!sayaç): sunucu başına tek sayaç kanalı + hedef.
// ---------------------------------------------------------------------------
export const counterTable = pgTable("discord_counters", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  target: integer("target").notNull(),
});

export type CounterRow = typeof counterTable.$inferSelect;

// ---------------------------------------------------------------------------
// 🎨 Components V2 metinleri için owner tarafından tanımlanan emoji eşleşmeleri.
// ---------------------------------------------------------------------------
export const emojiOverridesTable = pgTable("discord_emoji_overrides", {
  unicode: text("unicode").primaryKey(),
  custom: text("custom").notNull(),
});

export type EmojiOverrideRow = typeof emojiOverridesTable.$inferSelect;
