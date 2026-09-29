import { errorCard, textCard } from "../utils/componentsV2.js";
import { MessageFlags, PermissionFlagsBits, type Message, type Role } from "discord.js";
import type { Command } from "../types.js";
import { errorEmbed } from "../utils/embeds.js";
import { parseDuration, formatDurationShort } from "../utils/duration.js";
import { requireModPerm, NO_PING, msg } from "./mod/_shared.js";
import { grantTimedRole, revokeTimedRole } from "../timedroles/store.js";
import { addSlash } from "../utils/slashBridge.js";

const MIN_MS = 60_000;
const MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Rol hiyerarşisi güvenlik kontrolü. Hata mesajı döndürür (null = temiz). */
function hierarchyError(message: Message, role: Role): string | null {
  const guild = message.guild!;
  const me = guild.members.me;
  if (!me) return "Botun sunucudaki yetkisi okunamadı.";
  if (role.managed) return "Entegrasyon rolleri süreli verilemez.";
  if (role.id === guild.id) return "@everyone verilemez.";
  if (me.roles.highest.position <= role.position) {
    return "Bu rol benden üstte — rolümü daha yukarı taşıman lazım.";
  }
  const member = message.member!;
  const isOwner = guild.ownerId === member.id;
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  if (!isOwner && !isAdmin && member.roles.highest.position <= role.position) {
    return "Bu rol senin en yüksek rolünden üstte.";
  }
  return null;
}

const command: Command = {
  name: "sürelirol",
  aliases: ["surelirol", "temprol"],
  description: "Kullanıcıya vadesi dolunca otomatik alınan rol verir",
  usage: "!sürelirol @kullanıcı @rol <süre> [sebep] • !sürelirol al @kullanıcı @rol",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Bu komut sadece sunucu içinde kullanılabilir.")] });
    }
    if (!(await requireModPerm(message, "sürelirol", PermissionFlagsBits.ManageRoles))) return;

    // Erken alma: !sürelirol al @kullanıcı @rol
    if (args[0]?.toLocaleLowerCase("tr-TR") === "al") {
      const targetUser = message.mentions.users.first();
      const role = message.mentions.roles.first();
      if (!targetUser || !role) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Kullanım: `!sürelirol al @kullanıcı @rol`") })], ...NO_PING });
      }
      const ok = await revokeTimedRole(message.client, message.guild.id, targetUser.id, role.id);
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [errorCard({ description: ok ? msg.ok(`${targetUser} kullanıcısından **${role.name}** erken alındı.`) : msg.err("Bu kullanıcıda aktif süreli kayıt bulunamadı.") })],
        ...NO_PING,
      });
    }

    const targetUser = message.mentions.users.first();
    const role = message.mentions.roles.first();
    const durArg = args.find((a) => parseDuration(a) !== null);
    const durationMs = durArg ? parseDuration(durArg)! : null;

    if (!targetUser || !role || !durationMs) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [errorCard({ description: msg.err("Kullanım: `!sürelirol @kullanıcı @rol 30dk [sebep]`") })],
        ...NO_PING,
      });
    }
    if (targetUser.bot) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Botlara süreli rol verilemez.") })], ...NO_PING });
    }
    if (durationMs < MIN_MS || durationMs > MAX_MS) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Süre en az 1 dakika, en çok 30 gün olabilir.") })], ...NO_PING });
    }
    const hierr = hierarchyError(message, role);
    if (hierr) return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err(hierr) })], ...NO_PING });

    const reason = args.filter((a) => a !== durArg && !a.startsWith("<@")).join(" ").trim() || undefined;
    try {
      const expiresAt = await grantTimedRole(
        message.client, message.guild, targetUser.id, role.id, durationMs, message.author.id, reason,
      );
      const ts = Math.floor(expiresAt.getTime() / 1000);
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: textCard(msg.ok(`${targetUser} kullanıcısına **${role.name}** verildi — ${formatDurationShort(durationMs)} sonra (<t:${ts}:R>) otomatik alınacak.`)),
        ...NO_PING,
      });
    } catch (err) {
      console.error("sürelirol patladı la:", err);
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: msg.err("Rol verilemedi — yetkimi ve rol sırasını kontrol et.") })], ...NO_PING });
    }
  },
};

addSlash(
  command,
  [
    { name: "kullanici", description: "Rol verilecek kullanıcı", type: "user", required: true },
    { name: "rol", description: "Verilecek rol", type: "role", required: true },
    { name: "sure", description: "Süre (örn. 30dk, 2saat, 1g)", type: "string", required: true },
    { name: "sebep", description: "Sebep (isteğe bağlı)", type: "string" },
  ],
  (v) => {
    const args: string[] = [];
    const u = v.userMention("kullanici");
    const r = v.roleMention("rol");
    const s = v.str("sure");
    const sebep = v.str("sebep");
    if (u) args.push(u);
    if (r) args.push(r);
    if (s) args.push(s);
    if (sebep) args.push(...sebep.split(/\s+/));
    return args;
  },
);

export default command;
