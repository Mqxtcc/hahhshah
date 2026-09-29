import { db } from "../db/index.js";
import { quizScoresTable } from "../db/schema.js";
import { and, desc, eq, sql } from "../db/jsonOrm.js";

function scoreKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/** Bir kullanıcının bilgi yarışması galibiyet sayısını 1 artırır (yoksa satırı oluşturur). */
export async function addQuizWin(guildId: string, userId: string): Promise<void> {
  const key = scoreKey(guildId, userId);
  await db
    .insert(quizScoresTable)
    .values({ key, guildId, userId, wins: 1 })
    .onConflictDoUpdate({
      target: quizScoresTable.key,
      set: { wins: sql`${quizScoresTable.wins} + 1`, updatedAt: new Date() },
    });
}

export interface QuizLeaderboardEntry {
  userId: string;
  wins: number;
}

/** Bir sunucudaki en yüksek skorlu ilk `limit` kullanıcıyı döner (çoktan aza). */
export async function getQuizLeaderboard(guildId: string, limit = 10): Promise<QuizLeaderboardEntry[]> {
  const rows = await db
    .select({ userId: quizScoresTable.userId, wins: quizScoresTable.wins })
    .from(quizScoresTable)
    .where(eq(quizScoresTable.guildId, guildId))
    .orderBy(desc(quizScoresTable.wins))
    .limit(limit);
  return rows;
}

/** Tek bir kullanıcının skorunu döner (hiç kazanmadıysa 0). */
export async function getQuizScore(guildId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ wins: quizScoresTable.wins })
    .from(quizScoresTable)
    .where(and(eq(quizScoresTable.guildId, guildId), eq(quizScoresTable.userId, userId)));
  return rows[0]?.wins ?? 0;
}
