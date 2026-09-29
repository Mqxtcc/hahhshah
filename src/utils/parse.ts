import type { Guild } from "discord.js";

/** @mention veya düz ID'den kullanıcı ID'sini çıkarır */
export function parseMention(str: string): string | null {
  const match = str.match(/^<@!?(\d+)>$/) ?? str.match(/^(\d{17,20})$/);
  return match ? match[1] : null;
}

/** #kanal mention'ından veya düz ID'den kanal ID'sini çıkarır */
export function parseChannelMention(str: string): string | null {
  const match = str.match(/^<#(\d+)>$/) ?? str.match(/^(\d{17,20})$/);
  return match ? match[1] : null;
}

// Komut mesajının ham içeriğinden, baştaki `tokenCount` kadar boşlukla
// ayrılmış "kelimeyi" (prefix dahil, komut adı + varsa önceki argümanlar)
// atlayıp geri kalanını AYNEN (satır sonları, kod bloğu ``` işaretleri,
// çoklu boşluklar dahil) döndürür.
// `args.join(" ")` KULLANMA çünkü o, mesajı tek boşlukla parçalayıp
// birleştirdiği için kullanıcının markdown/kod bloğu biçimlendirmesini
// (özellikle satır sonlarını) bozar — çok satırlı custom event/komut kodu,
// hoşgeldin mesajı gibi şeyler tek satıra sıkışır.
export function extractRawRest(content: string, tokenCount: number, prefix: string): string | null {
  const withoutPrefix = content.slice(prefix.length);
  const re = new RegExp(`^\\s*(?:\\S+\\s+){${tokenCount}}`);
  const match = withoutPrefix.match(re);
  if (!match) return null;
  const rest = withoutPrefix.slice(match[0].length).trimEnd();
  return rest.length > 0 ? rest : null;
}

/** Dakika → okunabilir Türkçe süre metni */
export function formatDuration(minutes: number): string {
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} gün`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} saat`;
  return `${minutes} dakika`;
}
