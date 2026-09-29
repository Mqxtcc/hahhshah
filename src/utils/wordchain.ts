import { and, desc, eq, lt, sql } from "../db/jsonOrm.js";
import { db } from "../db/index.js";
import { wordChainChannelsTable, wordChainScoresTable, wordChainUsedWordsTable } from "../db/schema.js";
import { isRealTurkishWord } from "./tdk.js";

// ---------------------------------------------------------------------------
// Kelime Zinciri — bir kullanıcının yazdığı kelimenin SON harfi, bir sonraki
// kullanıcının yazacağı kelimenin İLK harfi olmak zorunda ("elma" -> "at" ->
// "top" -> ...).
//
// Bu artık geçici bir "etkinlik" (!kelime baslat / !kelime durdur) DEĞİL —
// bir yönetici bir kanalı kalıcı olarak "Kelime Zinciri kanalı" yapar
// (!kelime kanal #kanal) ve sistem sunucu kapanana/kanal kaldırılana kadar
// o kanalda sürekli çalışır. Tüm oyun durumu (mevcut zincir, son kelime,
// gereken harf, kullanılan kelimeler, mevcut seri VE tüm zamanların rekoru)
// veritabanına yazılır — bot yeniden başlatılsa (deploy, çökme, restart)
// bile zincir kaldığı yerden devam eder, hiçbir şey sıfırlanmaz.
//
// Bellekte tutulan `sessions` haritası sadece bir PERFORMANS ÖNBELLEĞİdir:
// her mesajda veritabanına gitmemek için. Kaynak gerçeklik (source of
// truth) her zaman veritabanıdır; süreç açılışında `loadWordChainChannels()`
// ile önbellek veritabanından doldurulur.
//
// NOT: Zincir kuralları (harf uyumu, tekrar etmeme, sadece harflerden
// oluşma) senkron/ucuz kontrollerle en başta elenir. Ardından, gerçek bir
// kelime olma ihtimali olan denemeler için TDK'nin (sozluk.gov.tr) genel
// sözlük API'sine sorulur — bkz. isRealTurkishWord() (./tdk.ts). TDK'ye
// ulaşılamazsa (zaman aşımı/ağ hatası) oyunu tıkamamak için kelime kabul
// edilir; bu tek istisna dışında kelimenin TDK'de gerçekten var olması
// zorunludur.
// ---------------------------------------------------------------------------

interface WordChainSession {
  guildId: string;
  channelId: string;
  lastWord: string | null;
  requiredLetter: string | null; // null = zincir sıfır, herhangi bir harfle başlanabilir
  usedWords: Set<string>;
  wordCooldownTimers: Map<string, ReturnType<typeof setTimeout>>;
  streak: number;
  lastPlayerId: string | null;
  bestStreak: number;
  bestHolderId: string | null;
  setBy: string;
}

// channelId -> oturum (aktif/kalıcı kanal başına tek oturum)
const sessions = new Map<string, WordChainSession>();
// guildId -> channelId (bir sunucunun kelime zinciri kanalını hızlıca bulmak için)
const guildChannelIndex = new Map<string, string>();
const WORD_REUSE_COOLDOWN_MS = 4 * 60 * 60 * 1_000;
// Kullanılmış kelimeler yalnızca tekrar kullanım cooldown'ı boyunca gereklidir.
// Süresiz saklamak data/db/discord_wordchain_used_words.json dosyasını sürekli büyütür.
const USED_WORD_RETENTION_MS = WORD_REUSE_COOLDOWN_MS;
const submissionLocks = new Map<string, Promise<void>>();
const persistenceQueues = new Map<string, Promise<void>>();

function clearWordCooldowns(session: WordChainSession): void {
  for (const timer of session.wordCooldownTimers.values()) clearTimeout(timer);
  session.wordCooldownTimers.clear();
}

// Bot sahibine özel muafiyet anahtarı: açıkken bot sahibi Kelime Zinciri
// kanalına normal mesaj (duyuru vb.) atabilir, mesajı silinmez ve kelime
// denemesi olarak sayılmaz. Kapalıyken bot sahibi de herkes gibi oyuna
// dahildir. Süreç bazlı (bellekte), kalıcı değil — bot yeniden başlarsa
// varsayılan olarak kapalı gelir.
let ownerBypassEnabled = false;

export function setOwnerBypass(enabled: boolean): void {
  ownerBypassEnabled = enabled;
}

export function isOwnerBypassEnabled(): boolean {
  return ownerBypassEnabled;
}

export type WordChainResult =
  | { ok: true; streak: number; isNewRecord: boolean }
  | { ok: false; reason: "consecutive" | "used" | "wrong-letter" | "invalid-format" | "not-a-word" | "too-short" };

// 1, 2 ve 3 harfli kelimeler oyunda sayılmaz — geçerli bir deneme için
// en az 4 harf gerekir.
const MIN_WORD_LENGTH = 4;

const TR_LOWER_MAP: Record<string, string> = { I: "ı", İ: "i" };

/** Türkçe'ye duyarlı küçük harfe çevirme (İ -> i, I -> ı — JS'in varsayılan .toLowerCase()'i bunu YANLIŞ yapar). */
function trLower(s: string): string {
  return s.replace(/[Iİ]/g, (ch) => TR_LOWER_MAP[ch] ?? ch.toLowerCase()).toLowerCase();
}

// TDK'de kullanılan düzeltme işaretli Türkçe harfler de geçerlidir:
// hâl, kâğıt, îman, sûret gibi kelimeler ön kontrolde silinmemelidir.
const TR_WORD_RE = /^[a-zçğıöşüâîû]+$/;

/** "ğ" ile biten kelimelerde bir sonraki kelimenin başlaması gereken harf, ğ'den ÖNCEKİ sesli/ünsüzdür (yaygın oyun kuralı) — ör. "kolağ" yazılmaz ama "sağ" gibi kelimelerde bir sonraki "a" ile başlar. */
function requiredLetterAfter(word: string): string {
  if (word.endsWith("ğ") && word.length >= 2) {
    return word[word.length - 2];
  }
  return word[word.length - 1];
}

function rowToSession(
  row: {
    guildId: string;
    channelId: string;
    lastWord: string | null;
    requiredLetter: string | null;
    streak: number;
    lastPlayerId: string | null;
    bestStreak: number;
    bestHolderId: string | null;
    setBy: string;
  },
  usedWords: Set<string>,
): WordChainSession {
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    lastWord: row.lastWord,
    requiredLetter: row.requiredLetter,
    usedWords,
    wordCooldownTimers: new Map(),
    streak: row.streak,
    lastPlayerId: row.lastPlayerId,
    bestStreak: row.bestStreak,
    bestHolderId: row.bestHolderId,
    setBy: row.setBy,
  };
}

/** Süreç açılışında (Discord'a bağlanmadan önce) çağrılır — tüm kalıcı Kelime Zinciri kanallarını veritabanından belleğe yükler. */
export async function loadWordChainChannels(): Promise<void> {
  try {
    const rows = await db.select().from(wordChainChannelsTable);
    const usedWordRows = await db.select().from(wordChainUsedWordsTable);
    const cutoff = new Date(Date.now() - USED_WORD_RETENTION_MS);

    // Eski sürümde kanal satırındaki `used_words` JSON dizisi her kelimede
    // yeniden yazılıp süresiz büyüyordu. Kullanılmış kelimelerin güncel kaynağı
    // artık ayrı tablodur; eski kolonun içeriği bu yüzden güvenle kompaktlanır.
    for (const row of rows) {
      if (row.usedWords !== "[]") {
        await db
          .update(wordChainChannelsTable)
          .set({ usedWords: "[]" })
          .where(eq(wordChainChannelsTable.guildId, row.guildId));
      }
    }

    // Restart beklemeden önceki oyunlardan kalan ve artık hiçbir işlevi olmayan
    // kayıtları kanal bazında tek sorguyla temizle. Böylece eski 90 KB+ dosyalar
    // bot açıldığında kendiliğinden küçülür.
    for (const channelId of new Set(usedWordRows.map((row) => row.channelId))) {
      await db
        .delete(wordChainUsedWordsTable)
        .where(and(eq(wordChainUsedWordsTable.channelId, channelId), lt(wordChainUsedWordsTable.createdAt, cutoff)));
    }

    const usedWordsByChannel = new Map<string, Set<string>>();
    const usedWordTimesByChannel = new Map<string, Map<string, number>>();
    for (const row of usedWordRows) {
      let set = usedWordsByChannel.get(row.channelId);
      if (!set) {
        set = new Set();
        usedWordsByChannel.set(row.channelId, set);
      }
      // Eski kayıtlar DB'de tutulmaya devam eder; yalnızca son 4 saatte
      // kullanılan kelimeler aktif cooldown olarak belleğe alınır.
      if (row.createdAt >= cutoff) {
        set.add(row.word);
        let times = usedWordTimesByChannel.get(row.channelId);
        if (!times) {
          times = new Map();
          usedWordTimesByChannel.set(row.channelId, times);
        }
        times.set(row.word, row.createdAt.getTime());
      }
    }

    sessions.clear();
    guildChannelIndex.clear();
    for (const row of rows) {
      const session = rowToSession(row, usedWordsByChannel.get(row.channelId) ?? new Set());
      sessions.set(session.channelId, session);
      guildChannelIndex.set(session.guildId, session.channelId);
      for (const [word, createdAt] of usedWordTimesByChannel.get(session.channelId) ?? []) {
        const remainingMs = Math.max(1, WORD_REUSE_COOLDOWN_MS - (Date.now() - createdAt));
        const timer = setTimeout(() => {
          session.usedWords.delete(word);
          session.wordCooldownTimers.delete(word);
        }, remainingMs);
        timer.unref?.();
        session.wordCooldownTimers.set(word, timer);
      }
    }
    if (rows.length > 0) {
      console.log(`[kelime] ${rows.length} kanal yüklendi`);
    }
  } catch (err) {
    console.error("[kelime] kanallar yüklenemedi:", err);
  } finally {
    scheduleUsedWordsCleanup();
  }
}

const USED_WORDS_CLEANUP_INTERVAL_MS = 30 * 60 * 1_000; // 30 dakikada bir
let usedWordsCleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Süresi dolmuş (cooldown penceresi dışına çıkmış) used_words satırlarını
 * TÜM kanallar için tek bir DELETE ile temizler. Eskiden her kelime kabulünde
 * kanal bazında ayrı ayrı çalışıyordu — bu da used_words tablosunu (tüm
 * kanallar birlikte) her kelimede baştan sona taratıyordu (O(n) per kelime).
 * Artık sadece periyodik olarak, tek geçişte çalışır. Doğruluk için kritik
 * değildir: aktif cooldown zaten bellekte (session.usedWords + setTimeout)
 * tutuluyor, bu sadece disk üzerindeki dosyayı küçük tutmak içindir.
 */
export function scheduleUsedWordsCleanup(): void {
  if (usedWordsCleanupTimer) return;
  usedWordsCleanupTimer = setInterval(() => {
    db.delete(wordChainUsedWordsTable)
      .where(lt(wordChainUsedWordsTable.createdAt, new Date(Date.now() - USED_WORD_RETENTION_MS)))
      .catch((err: unknown) => console.error("[kelime] used_words temizliği patladı:", err));
  }, USED_WORDS_CLEANUP_INTERVAL_MS);
  usedWordsCleanupTimer.unref?.();
}

function enqueuePersistence(channelId: string, task: () => Promise<void>): Promise<void> {
  const previous = persistenceQueues.get(channelId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (persistenceQueues.get(channelId) === current) persistenceQueues.delete(channelId);
    });
  persistenceQueues.set(channelId, current);
  return current;
}

/** Oyun durumu ve kullanılan kelimeyi aynı kanal kuyruğunda, kabul sırasıyla yazar. */
async function persistAcceptedWord(session: WordChainSession, word: string): Promise<void> {
  await enqueuePersistence(session.channelId, async () => {
    const value = {
      channelId: session.channelId,
      lastWord: session.lastWord,
      requiredLetter: session.requiredLetter,
      streak: session.streak,
      lastPlayerId: session.lastPlayerId,
      bestStreak: session.bestStreak,
      bestHolderId: session.bestHolderId,
      updatedAt: new Date(),
    };
    try {
      await db
        .update(wordChainChannelsTable)
        .set(value)
        .where(eq(wordChainChannelsTable.guildId, session.guildId));
      // TTL temizliği artık her kelime kabulünde DEĞİL, periyodik olarak
      // (bkz. scheduleUsedWordsCleanup) tüm kanallar için tek seferde yapılır.
      // Doğruluk zaten bellekteki setTimeout tabanlı cooldown (session.usedWords)
      // ile sağlanıyor; DB'deki satır sadece restart sonrası önbelleği doldurmak
      // için var — birkaç dakika gecikmeli silinmesi oyunu etkilemez. Bu, her
      // kabulde tüm used_words tablosunu tarayan bir DELETE'i ortadan kaldırır.
      await db
        .insert(wordChainUsedWordsTable)
        .values({ channelId: session.channelId, word })
        .onConflictDoUpdate({
          target: [wordChainUsedWordsTable.channelId, wordChainUsedWordsTable.word],
          set: { createdAt: new Date() },
        });
      await db
        .insert(wordChainScoresTable)
        .values({ guildId: session.guildId, userId: session.lastPlayerId!, words: 1 })
        .onConflictDoUpdate({
          target: [wordChainScoresTable.guildId, wordChainScoresTable.userId],
          set: { words: sql`${wordChainScoresTable.words} + 1`, updatedAt: new Date() },
        });
    } catch (err) {
      console.error("[kelime] oyun durumu kaydolmadı:", err);
    }
  });
}

export function isGameActive(channelId: string): boolean {
  return sessions.has(channelId);
}

/** Bu sunucuda kalıcı olarak ayarlanmış Kelime Zinciri kanalının ID'si (yoksa null). */
export function getConfiguredChannelId(guildId: string): string | null {
  return guildChannelIndex.get(guildId) ?? null;
}

/** Bir sonraki kelimenin başlaması gereken harf (kanal ayarlı değilse veya zincir sıfırsa null). */
export function getRequiredLetter(channelId: string): string | null {
  return sessions.get(channelId)?.requiredLetter ?? null;
}

export function getSession(channelId: string): WordChainSession | undefined {
  return sessions.get(channelId);
}

export type SetChannelResult =
  | { ok: true; replacedChannelId: string | null }
  | { ok: false; reason: "already-this-channel" };

/**
 * Bir kanalı bu sunucunun KALICI Kelime Zinciri kanalı yapar. Sunucuda daha
 * önce başka bir kanal ayarlıysa o kanaldaki eski durum silinir ve yeni
 * kanalda sıfırdan (rekor hariç, rekor sunucuya ait olduğu için korunur)
 * başlanır.
 */
export async function setWordChainChannel(guildId: string, channelId: string, setBy: string): Promise<SetChannelResult> {
  const existingChannelId = guildChannelIndex.get(guildId) ?? null;
  if (existingChannelId === channelId) {
    return { ok: false, reason: "already-this-channel" };
  }

  // Sunucunun mevcut rekoru varsa (kanal değişse bile) koru.
  const existing = existingChannelId ? sessions.get(existingChannelId) : undefined;

  const session: WordChainSession = {
    guildId,
    channelId,
    lastWord: null,
    requiredLetter: null,
    usedWords: new Set(),
    wordCooldownTimers: new Map(),
    streak: 0,
    lastPlayerId: null,
    bestStreak: existing?.bestStreak ?? 0,
    bestHolderId: existing?.bestHolderId ?? null,
    setBy,
  };

  await db
    .insert(wordChainChannelsTable)
    .values({
      guildId,
      channelId,
      lastWord: null,
      requiredLetter: null,
      usedWords: "[]",
      streak: 0,
      lastPlayerId: null,
      bestStreak: session.bestStreak,
      bestHolderId: session.bestHolderId,
      setBy,
    })
    .onConflictDoUpdate({
      target: wordChainChannelsTable.guildId,
      set: {
        channelId,
        lastWord: null,
        requiredLetter: null,
        usedWords: "[]",
        streak: 0,
        lastPlayerId: null,
        setBy,
        updatedAt: new Date(),
      },
    });

  // Yeni (veya sıfırdan başlayan) kanal için taze başlangıç — bu kanalda
  // önceden kalmış kelime kayıtları varsa (eski oturumdan) temizle.
  await db.delete(wordChainUsedWordsTable).where(eq(wordChainUsedWordsTable.channelId, channelId));
  if (existingChannelId && existingChannelId !== channelId) {
    await db.delete(wordChainUsedWordsTable).where(eq(wordChainUsedWordsTable.channelId, existingChannelId));
  }

  if (existingChannelId) {
    const oldSession = sessions.get(existingChannelId);
    if (oldSession) clearWordCooldowns(oldSession);
    sessions.delete(existingChannelId);
  }
  sessions.set(channelId, session);
  guildChannelIndex.set(guildId, channelId);

  return { ok: true, replacedChannelId: existingChannelId && existingChannelId !== channelId ? existingChannelId : null };
}

/** Kalıcı Kelime Zinciri kanalını sunucudan tamamen kaldırır (rekor dahil). Kaldırılan kanalın ID'sini döner (yoksa null). */
export async function removeWordChainChannel(guildId: string): Promise<string | null> {
  const channelId = guildChannelIndex.get(guildId);
  if (!channelId) return null;

  try {
    await db.delete(wordChainChannelsTable).where(eq(wordChainChannelsTable.guildId, guildId));
    await db.delete(wordChainUsedWordsTable).where(eq(wordChainUsedWordsTable.channelId, channelId));
  } catch (err) {
    // DB silinemediyse bellekte silmek, yeniden başlatmada kanalın geri
    // gelmesine ve kullanıcıların mevcut durumunu beklenmedik biçimde
    // kaybetmesine yol açar. Bu nedenle başarısızlığı üst kata bildiriyoruz.
    console.error("[kelime] kanal kaldırılamadı:", err);
    return null;
  }

  const session = sessions.get(channelId);
  if (session) clearWordCooldowns(session);
  sessions.delete(channelId);
  guildChannelIndex.delete(guildId);
  return channelId;
}

/**
 * Gelen mesajın geçerli bir "kelime denemesi" olup olmadığını hızlıca
 * eler (boşluk içeriyorsa, çok uzunsa vb.) — messageCreate.ts'in her mesajda
 * gereksiz yere ağır işlem yapmaması için ucuz bir ön filtre.
 */
export function looksLikeWordAttempt(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.includes(" ") || trimmed.length > 32) return false;
  return TR_WORD_RE.test(trLower(trimmed));
}

/**
 * Bir kelime denemesini işler. Bu kanal kalıcı Kelime Zinciri kanalı değilse
 * null döner (çağıran taraf bu durumda mesajı görmezden gelmeli).
 *
 * TDK sözlük kontrolü EN SON yapılır — önce ucuz/senkron kurallar (format,
 * tekrar, art arda oynama, harf uyumu) elenir, gerçek bir kelime olma
 * ihtimali olan denemeler için ağ isteği atılır. Böylece geçersiz formatlı
 * mesajlarda (boşluklu, çok uzun vb.) gereksiz TDK isteği yapılmaz.
 */
async function submitWordUnsafe(channelId: string, playerId: string, rawWord: string): Promise<WordChainResult | null> {
  const session = sessions.get(channelId);
  if (!session) return null;

  const word = trLower(rawWord.trim());
  if (!TR_WORD_RE.test(word)) {
    return { ok: false, reason: "invalid-format" };
  }
  if (word.length < MIN_WORD_LENGTH) {
    return { ok: false, reason: "too-short" };
  }

  // Aynı kişi art arda iki kez oynayamaz — en az iki farklı kişi katılmalı
  // (tek kişi kendi kendine zincir kurup "seri"yi anlamsızlaştırmasın diye).
  if (session.lastPlayerId === playerId) {
    return { ok: false, reason: "consecutive" };
  }

  if (session.usedWords.has(word)) return { ok: false, reason: "used" };

  if (session.requiredLetter && word[0] !== session.requiredLetter) {
    return { ok: false, reason: "wrong-letter" };
  }

  // TDK'ye göre gerçek bir kelime mi? API'ye ulaşılamazsa (null) oyunu
  // tıkamamak için kelimeyi kabul ediyoruz — sözlük kontrolü bir katkı,
  // tek hata noktası olmamalı.
  const isReal = await isRealTurkishWord(word);
  if (isReal === false) {
    return { ok: false, reason: "not-a-word" };
  }

  // Bu kontrol sırasında aynı kanalda başka bir kelime kabul edilmiş
  // olabilir (await sırasında oturum değişmiş olabilir) — session hâlâ
  // güncel mi diye tekrar bakıyoruz.
  const current = sessions.get(channelId);
  if (!current || current !== session) return null;
  if (current.lastPlayerId === playerId) {
    return { ok: false, reason: "consecutive" };
  }
  if (current.usedWords.has(word)) return { ok: false, reason: "used" };
  if (current.requiredLetter && word[0] !== current.requiredLetter) {
    return { ok: false, reason: "wrong-letter" };
  }

  session.usedWords.add(word);
  const previousCooldown = session.wordCooldownTimers.get(word);
  if (previousCooldown) clearTimeout(previousCooldown);
  const cooldownTimer = setTimeout(() => {
    session.usedWords.delete(word);
    session.wordCooldownTimers.delete(word);
  }, WORD_REUSE_COOLDOWN_MS);
  cooldownTimer.unref?.();
  session.wordCooldownTimers.set(word, cooldownTimer);
  session.lastWord = word;
  session.requiredLetter = requiredLetterAfter(word);
  session.streak += 1;
  session.lastPlayerId = playerId;

  let isNewRecord = false;
  if (session.streak > session.bestStreak) {
    session.bestStreak = session.streak;
    session.bestHolderId = playerId;
    isNewRecord = true;
  }

  await persistAcceptedWord(session, word);

  return { ok: true, streak: session.streak, isNewRecord };
}

/** Aynı kanala aynı anda gelen mesajları sıraya alır; TDK beklemesi sırasında
 * iki oyuncunun aynı zincir durumunu görüp ikisinin de kabul edilmesini önler. */
export async function submitWord(channelId: string, playerId: string, rawWord: string): Promise<WordChainResult | null> {
  const previous = submissionLocks.get(channelId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  submissionLocks.set(channelId, current);
  await previous;
  try {
    return await submitWordUnsafe(channelId, playerId, rawWord);
  } finally {
    release();
    if (submissionLocks.get(channelId) === current) submissionLocks.delete(channelId);
  }
}

export interface WordChainStatus {
  channelId: string;
  lastWord: string | null;
  requiredLetter: string | null;
  streak: number;
  bestStreak: number;
  bestHolderId: string | null;
  usedWordsCount: number;
}

export interface WordChainTopEntry {
  guildId: string;
  bestStreak: number;
  bestHolderId: string | null;
}

export interface WordChainScore {
  userId: string;
  words: number;
}

/** Sunucudaki kabul edilmiş kelime sayısına göre gerçek oyuncu sıralaması. */
export async function getGuildWordScores(guildId: string, limit = 10): Promise<WordChainScore[]> {
  const rows = await db
    .select({ userId: wordChainScoresTable.userId, words: wordChainScoresTable.words })
    .from(wordChainScoresTable)
    .where(eq(wordChainScoresTable.guildId, guildId))
    .orderBy(desc(wordChainScoresTable.words))
    .limit(limit);
  return rows;
}

/**
 * Tüm sunuculardaki Kelime Zinciri rekorlarının en yükseğe göre sıralanmış
 * ilk `limit` tanesi (varsayılan 10) — `!kelime top`. Bellekteki oturum
 * haritası zaten kaynak gerçekliğin (DB) önbelleği olduğundan doğrudan
 * `sessions` üzerinden okunur, ekstra bir DB sorgusuna gerek yoktur.
 */
export function getTopStreaks(limit = 10): WordChainTopEntry[] {
  return [...sessions.values()]
    .filter((session) => session.bestStreak > 0)
    .sort((a, b) => b.bestStreak - a.bestStreak)
    .slice(0, limit)
    .map((session) => ({
      guildId: session.guildId,
      bestStreak: session.bestStreak,
      bestHolderId: session.bestHolderId,
    }));
}

export function getStatus(guildId: string): WordChainStatus | null {
  const channelId = guildChannelIndex.get(guildId);
  if (!channelId) return null;
  const session = sessions.get(channelId);
  if (!session) return null;
  return {
    channelId: session.channelId,
    lastWord: session.lastWord,
    requiredLetter: session.requiredLetter,
    streak: session.streak,
    bestStreak: session.bestStreak,
    bestHolderId: session.bestHolderId,
    usedWordsCount: session.usedWords.size,
  };
}
