import { eq } from "../db/jsonOrm.js";
import { db, birthdayTable } from "../db/index.js";

// ---------------------------------------------------------------------------
// 🎂 Doğum günü deposu — gün + ay (yıl tutulmaz).
// ---------------------------------------------------------------------------

export interface Birthday {
  userId: string;
  day: number;
  month: number;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidDate(day: number, month: number): boolean {
  return (
    Number.isInteger(day) &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= DAYS_IN_MONTH[month - 1]
  );
}

export async function setBirthday(userId: string, day: number, month: number): Promise<void> {
  await db
    .insert(birthdayTable)
    .values({ userId, day, month })
    .onConflictDoUpdate({ target: birthdayTable.userId, set: { day, month } });
}

export async function getBirthday(userId: string): Promise<Birthday | null> {
  const rows = await db.select().from(birthdayTable).where(eq(birthdayTable.userId, userId));
  const r = rows[0];
  return r ? { userId: r.userId, day: r.day, month: r.month } : null;
}

export async function deleteBirthday(userId: string): Promise<void> {
  await db.delete(birthdayTable).where(eq(birthdayTable.userId, userId)).catch(() => null);
}

export async function birthdaysInMonth(month: number): Promise<Birthday[]> {
  const rows = await db.select().from(birthdayTable).where(eq(birthdayTable.month, month));
  return rows
    .map((r) => ({ userId: r.userId, day: r.day, month: r.month }))
    .sort((a, b) => a.day - b.day);
}

export const MONTH_NAMES_TR = [
  "",
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
];
