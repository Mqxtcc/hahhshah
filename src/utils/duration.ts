// Ortak süre ayrıştırıcı: "10dk", "2saat", "1g", "1g2saat30dk" gibi
// birleşik süreleri milisaniyeye çevirir. (Eskiden hatirlat.ts içindeydi;
// anket --sure de kullanıyor.)
const UNIT_MS: Record<string, number> = {
  sn: 1_000,
  s: 1_000,
  dk: 60_000,
  d: 60_000,
  saat: 3_600_000,
  sa: 3_600_000,
  g: 86_400_000,
  gun: 86_400_000,
  gün: 86_400_000,
};

/** "1g2saat30dk" → ms. Ayrıştırılamazsa null. */
export function parseDuration(input: string): number | null {
  // \b yerine harf-lookahead: "1g2saat" içinde "1g"nin sonundaki \b,
  // ardından rakam geldiği için tutmuyordu ve "1g2saat30dk" yalnızca 30dk
  // olarak algılanıyordu. Birimden sonra harf gelmemesi yeterli.
  const re = /(\d+)\s*(sn|dk|d|saat|sa|gün|gun|g|s)(?![a-zçğıöşü])/giu;
  let match: RegExpExecArray | null;
  let total = 0;
  let matchedAny = false;
  while ((match = re.exec(input))) {
    matchedAny = true;
    const amount = Number.parseInt(match[1], 10);
    const unit = UNIT_MS[match[2].toLowerCase()];
    if (!unit) return null;
    total += amount * unit;
  }
  return matchedAny ? total : null;
}

/** ms → "2 sa 15 dk" gibi okunaklı süre. */
export function formatDurationShort(ms: number): string {
  const parts: string[] = [];
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) parts.push(`${days} gün`);
  if (hours > 0) parts.push(`${hours} sa`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} dk`);
  return parts.join(" ");
}
