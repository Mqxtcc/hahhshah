import { eq } from "../db/jsonOrm.js";
import { db, noteTable } from "../db/index.js";

// ---------------------------------------------------------------------------
// 📝 Kişisel not deposu — kullanıcı başına en fazla 25 not.
// ---------------------------------------------------------------------------

export const MAX_NOTES_PER_USER = 25;
export const MAX_NOTE_LENGTH = 500;

export interface Note {
  id: number;
  content: string;
  createdAt: number;
}

export async function listNotes(userId: string): Promise<Note[]> {
  const rows = await db.select().from(noteTable).where(eq(noteTable.userId, userId));
  return rows
    .map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt.getTime() }))
    .sort((a, b) => b.id - a.id);
}

export async function countNotes(userId: string): Promise<number> {
  const rows = await db.select().from(noteTable).where(eq(noteTable.userId, userId));
  return rows.length;
}

export async function addNote(userId: string, content: string): Promise<Note> {
  const rows = await db.insert(noteTable).values({ userId, content, createdAt: new Date() });
  const row = rows[0];
  return { id: row.id, content: row.content, createdAt: row.createdAt.getTime() };
}

export async function deleteNote(userId: string, id: number): Promise<boolean> {
  const rows = await db.select().from(noteTable).where(eq(noteTable.userId, userId));
  const mine = rows.find((r) => r.id === id);
  if (!mine) return false;
  await db.delete(noteTable).where(eq(noteTable.id, id)).catch(() => null);
  return true;
}
