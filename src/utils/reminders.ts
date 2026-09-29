import { v2Payload } from "./messages.js";
// Kalıcı hatırlatıcılar: DB'de tutulur, açılışta yeniden zamanlanır.
// !hatirlat komutu burayı kullanır; events/ready.ts açılışta
// loadPendingReminders() çağırır.
import type { Client, TextBasedChannel } from "discord.js";
import { and, asc, eq } from "../db/jsonOrm.js";
import { db } from "../db/index.js";
import { remindersTable, type ReminderRow } from "../db/schema.js";

const timers = new Map<number, NodeJS.Timeout>();

// Başarısız gönderim sayacı: bellekte tutulur (DB şeması değişmez).
// id -> kaç kere denendi (1..2). 3. deneme başarısızsa hatırlatıcı silinir.
const retryCounts = new Map<number, number>();
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5 * 60_000;

export interface ReminderInput {
  userId: string;
  guildId: string | null;
  channelId: string;
  note: string;
  dueAt: Date;
}

/** Yeni hatırlatıcı oluştur + zamanla. Oluşan satırın id'sini döner. */
export async function createReminder(client: Client, input: ReminderInput): Promise<number> {
  const inserted = await db
    .insert(remindersTable)
    .values(input)
    .returning({ id: remindersTable.id });
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error("Hatırlatıcı oluşturulamadı.");
  scheduleRow(client, { ...input, id, createdAt: new Date() });
  return id;
}

/** Kullanıcının bekleyen hatırlatıcılarını (vadesi yakın önce) döner. */
export async function listReminders(userId: string): Promise<ReminderRow[]> {
  return db
    .select()
    .from(remindersTable)
    .where(eq(remindersTable.userId, userId))
    .orderBy(asc(remindersTable.dueAt))
    .catch(() => [] as ReminderRow[]);
}

/**
 * Hatırlatıcıyı iptal eder: zamanlayıcıyı durdurur ve DB satırını siler.
 * Başkasının hatırlatıcısını silememesi için userId de eşleşmeli; eşleşme
 * yoksa false döner.
 */
export async function deleteReminder(userId: string, id: number): Promise<boolean> {
  const rows = await db
    .select({ id: remindersTable.id })
    .from(remindersTable)
    .where(and(eq(remindersTable.id, id), eq(remindersTable.userId, userId)))
    .catch(() => [] as { id: number }[]);
  if (rows.length === 0) return false;

  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  retryCounts.delete(id);
  await db.delete(remindersTable).where(eq(remindersTable.id, id)).catch(() => null);
  return true;
}
export async function countActiveReminders(userId: string): Promise<number> {
  const rows = await db
    .select({ id: remindersTable.id })
    .from(remindersTable)
    .where(eq(remindersTable.userId, userId));
  return rows.length;
}

async function fireReminder(client: Client, row: ReminderRow): Promise<void> {
  timers.delete(row.id);

  const text = `⏰ <@${row.userId}> **Hatırlatıcı:** ${row.note}`;
  // Önce aynı kanala yazmayı dene, olmazsa DM'e düş. DB'den silme SADECE
  // gönderim başarılıysa yapılır — ikisi de başarısızsa hatırlatıcı kaybolmaz.
  let sent = false;
  try {
    const channel = (await client.channels.fetch(row.channelId).catch(() => null)) as TextBasedChannel | null;
    if (channel && "send" in channel) {
      await channel.send(v2Payload(text));
      sent = true;
    }
  } catch {
    /* kanala yazılamadı */
  }
  if (!sent) {
    try {
      const user = await client.users.fetch(row.userId);
      await user.send(v2Payload(text));
      sent = true;
    } catch {
      /* DM de kapalıysa yapacak bir şey yok */
    }
  }

  if (sent) {
    retryCounts.delete(row.id);
    await db.delete(remindersTable).where(eq(remindersTable.id, row.id)).catch(() => null);
    return;
  }

  // Gönderim başarısız: kaydı silme, dueAt'i 5 dk ötele; en fazla 3 dene.
  const tries = (retryCounts.get(row.id) ?? 0) + 1;
  if (tries >= MAX_RETRIES) {
    retryCounts.delete(row.id);
    await db.delete(remindersTable).where(eq(remindersTable.id, row.id)).catch(() => null);
    return;
  }
  retryCounts.set(row.id, tries);
  const newDueAt = new Date(Date.now() + RETRY_DELAY_MS);
  await db.update(remindersTable).set({ dueAt: newDueAt }).where(eq(remindersTable.id, row.id)).catch(() => null);
  scheduleRow(client, { ...row, dueAt: newDueAt });
}

function scheduleRow(client: Client, row: ReminderRow): void {
  const msLeft = new Date(row.dueAt).getTime() - Date.now();
  if (timers.has(row.id)) clearTimeout(timers.get(row.id)!);
  if (msLeft <= 0) {
    // Süresi dolmuş (ör. bot kapalıyken geçmiş) — hemen gönder.
    void fireReminder(client, row);
    return;
  }
  timers.set(
    row.id,
    setTimeout(() => void fireReminder(client, row), Math.min(msLeft, 2_147_483_647)),
  );
}

/** Açılışta çağrılır: bekleyenleri yükler, zamanlar; tarihi geçmişleri gönderir. */
export async function loadPendingReminders(client: Client): Promise<void> {
  const rows = await db.select().from(remindersTable);
  // Tarihi geçmişleri önce temizle/gönder.
  const now = Date.now();
  let scheduled = 0;
  for (const row of rows) {
    if (new Date(row.dueAt).getTime() <= now) {
      await fireReminder(client, row).catch(() => null);
    } else {
      scheduleRow(client, row);
      scheduled++;
    }
  }
  if (scheduled > 0) console.log(`[hatırlatıcı] ${scheduled} tane zamanlandı`);
}

/** Test/temizlik için: tüm zamanlayıcıları durdurur. */
export function clearAllReminderTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
