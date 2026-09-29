import type { Command } from "../types.js";

let loadedCommands: readonly Command[] = [];

/**
 * Komut metadata'sının tek registry'den okunması için geriye dönük uyumlu API.
 * Önceki sürüm çalışma zamanında .js tarıyordu; tsx ile .ts, production bundle
 * ile .js arasında farklı sonuç verdiği için kaynak taraması kaldırıldı.
 */
export async function loadCommands(): Promise<Command[]> {
  return [...loadedCommands];
}

/** Help gibi runtime bileşenlerinin yüklenmiş komut metadata'sına erişimi. */
export function getLoadedCommands(): readonly Command[] {
  return loadedCommands;
}

/** Elle kayıt edilen index listesini help gibi metadata tüketicilerine verir. */
export function setLoadedCommands(commands: readonly Command[]): void {
  loadedCommands = [...commands];
}

export function resetLoadedCommandsForTests(): void {
  loadedCommands = [];
}
