import type { Message } from "discord.js";

/**
 * !panel mesajını kimin açtığını (message.id -> ownerId) tutan store.
 * Butona/menüye/modala basan kişinin, paneli AÇAN kişiyle aynı olup
 * olmadığını kontrol etmek için kullanılır (yetki kontrolüne ek olarak).
 *
 * Ayrıca bir customId'nin gerçekten kayıtlı bir panel mesajından gelip
 * gelmediğini de doğrular: store'da olmayan bir mesaj id'si (ör. panel
 * formatını taklit eden elle üretilmiş bir customId) otomatik reddedilir.
 */

const panelOwners = new Map<string, { ownerId: string; guildId: string | null }>();
const panelOwnersTouched = new Map<string, number>();
const PANEL_OWNER_TTL_MS = 24 * 60 * 60_000; // 24 saat: panel uzun süre açık kalabilir

export function registerPanelOwner(message: Message, ownerId: string): void {
  panelOwners.set(message.id, { ownerId, guildId: message.guildId });
  panelOwnersTouched.set(message.id, Date.now());
}

export function getPanelOwnerId(messageId: string | undefined | null): string | null {
  if (!messageId) return null;
  panelOwnersTouched.set(messageId, Date.now()); // her etkileşimde ömrünü uzat
  return panelOwners.get(messageId)?.ownerId ?? null;
}

const panelOwnersCleanup = setInterval(() => {
  const cutoff = Date.now() - PANEL_OWNER_TTL_MS;
  for (const [id, touchedAt] of panelOwnersTouched) {
    if (touchedAt < cutoff) {
      panelOwners.delete(id);
      panelOwnersTouched.delete(id);
    }
  }
}, PANEL_OWNER_TTL_MS);
panelOwnersCleanup.unref?.();
