import { loadEnv } from "./utils/env.js";

loadEnv();

// Botun sahibi (tüm owner-only komutlar ve yetki kontrolleri buradan okur).
// Artık SADECE ortam değişkeninden okunur — kaynak kodda sabit ID yok.
// OWNER_ID tanımlı değilse bot bilerek açılmaz (güvenlik kontrolü sessiz
// geçilemez).
const configuredOwnerId = process.env.OWNER_ID?.trim();
if (!configuredOwnerId) {
  throw new Error("OWNER_ID yok la, env'e ekle — bot açılmıyor.");
}
if (!/^\d{15,25}$/.test(configuredOwnerId)) {
  throw new Error("OWNER_ID geçerli bir Discord kullanıcı ID'si olmalı (15-25 rakam).");
}
export const OWNER_ID = configuredOwnerId;

// ---------------------------------------------------------------------------
// Prefix artık GLOBAL değil, SUNUCU BAZLI (bkz. events/messageCreate.ts —
// getGuildPrefix / setGuildPrefix, DB'de kalıcı). Buradaki DEFAULT_PREFIX
// sadece şu durumlarda kullanılan varsayılan/geri düşülecek değerdir:
//   1) Bir sunucu henüz kendine özel bir prefix ayarlamamışsa,
//   2) Sunucu dışı bağlamlarda.
// .env'de DEFAULT_PREFIX tanımlıysa o kullanılır, yoksa "!" kullanılır.
// ---------------------------------------------------------------------------
export const DEFAULT_PREFIX = process.env.DEFAULT_PREFIX?.trim() || "!";

// Embed footer'ları gibi görsel/marka öğelerinde kullanılan bot adı.
// .env'de BOT_NAME tanımlıysa o kullanılır (ör. sunucu markanıza göre
// özelleştirmek için), yoksa aşağıdaki varsayılana düşülür.
export const BOT_NAME = process.env.BOT_NAME?.trim() || "Tatlış Muhafız";

// Embed'lerde author ikonu + büyük panellerde alt banner görseli olarak
// kullanılan görsel (ör. Marin Kitagawa temalı bir resim linki).
// .env'de BOT_BANNER tanımlı değilse hiçbir görsel eklenmez (opsiyonel).
export const BOT_BANNER = process.env.BOT_BANNER?.trim() || null;

// Geliştirme/test sırasında slash komutlarının anında görünmesi için
// SLASH_GUILD_ID (veya mevcut kurulumlarda GUILD_ID) ortam değişkenine sunucu
// ID'si verilebilir. Boş bırakılırsa komutlar global kaydedilir ve Discord'un
// yayılma süresine tabi olur.
// Web dashboard'un (tatlis-muhafiz-panel) herkese açık adresi. Help menüsündeki
// "Web Paneli" butonu buraya yönlendirir. .env'de DASHBOARD_URL tanımlıysa o
// kullanılır, yoksa aşağıdaki varsayılana düşülür.
export const DASHBOARD_URL =
  process.env.DASHBOARD_URL?.trim() || "https://tatlis-muhafiz-panel.vercel.app";

// Botun Discord uygulama (client) ID'si — davet linki buradan üretilir.
// .env'de CLIENT_ID tanımlıysa o kullanılır.
export const CLIENT_ID = process.env.CLIENT_ID?.trim() || "1528358579898155019";

// Botu sunucuya ekleme linki (davet ödül sistemi ve !davet komutu kullanır).
export const INVITE_URL =
  `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&integration_type=0&scope=bot`;
