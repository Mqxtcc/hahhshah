import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { requireOwnerOrHalfOwner } from "../../events/messageCreate.js";
import { db, getActiveBackend } from "../../db/index.js";
import {
  count,
  getRegisteredTables,
  type AnyTable,
  type Rec,
  type TableMeta,
} from "../../db/jsonOrm.js";
import * as schema from "../../db/schema.js";
import { infoEmbed } from "../../utils/embeds.js";

// Tablo adı (küçük harf) -> tablo nesnesi. db.select().from() için gerçek
// Table gerekir; şemadaki tüm export'lar taranır.
const tablesByName = new Map<string, { meta: TableMeta; table: AnyTable }>();
for (const value of Object.values(schema)) {
  if (value && typeof value === "object" && "$meta" in value) {
    const table = value as AnyTable;
    tablesByName.set(table.$meta.name.toLocaleLowerCase("tr-TR"), { meta: table.$meta, table });
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace("T", " ");
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  }
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function formatRow(rec: Rec): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec)) parts.push(`\`${k}\`: ${formatValue(v)}`);
  const line = parts.join("  ");
  return line.length > 900 ? `${line.slice(0, 897)}…` : line;
}

const command: Command = {
  name: "veribak",
  aliases: ["veritabani", "db-bak"],
  description: "Veritabanını görüntüler: tablo listesi ve satırlar (owner / half-owner, DM'den de çalışır)",
  usage: "!veribak [tablo] [adet]",
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!(await requireOwnerOrHalfOwner(message))) return;

    const backend = getActiveBackend();
    const backendLine = backend === "sqlite" ? "🗄️ SQLite (`data/db/bot.sqlite`)" : "🗄️ JSON (`data/db/*.json`)";

    // ---- !veribak → tablo listesi ----
    if (args.length === 0) {
      const metas = getRegisteredTables().sort((a, b) => a.name.localeCompare(b.name));
      const lines: string[] = [];
      for (const meta of metas) {
        const entry = tablesByName.get(meta.name.toLocaleLowerCase("tr-TR"));
        if (!entry) continue;
        const [{ n }] = await db.select({ n: count() }).from(entry.table);
        lines.push(`\`${meta.name}\` — **${n}** satır`);
      }
      const embed = infoEmbed(
        "Veritabanı Tabloları",
        [backendLine, "", ...lines].join("\n"),
        { footer: "Satırları görmek için: !veribak <tablo> [adet]" },
      );
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
      return;
    }

    // ---- !veribak <tablo> [adet] ----
    const wanted = args[0].toLocaleLowerCase("tr-TR");
    const entry = tablesByName.get(wanted);
    if (!entry) {
      const names = [...tablesByName.keys()].sort().join(", ");
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            infoEmbed(
              "Tablo Bulunamadı",
              `Böyle bir tablo yok: \`${args[0]}\`\n\nMevcut tablolar: ${names}`,
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    const limit = Math.min(Math.max(Number.parseInt(args[1] ?? "10", 10) || 10, 1), 25);
    const rows = (await db.select().from(entry.table)) as Rec[];
    const [{ n: total }] = await db.select({ n: count() }).from(entry.table);
    if (rows.length === 0) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [infoEmbed(entry.meta.name, `${backendLine}\n\nTablo boş.`)] })
        .catch(() => null);
      return;
    }

    const shown = rows.slice(-limit).reverse();
    const body = shown.map((r, i) => `**${rows.length - shown.length + i + 1}.** ${formatRow(r)}`).join("\n\n");
    const header = `${backendLine}\nToplam **${total}** satır — son ${shown.length} gösteriliyor.\n\n`;
    const full = header + body;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 3800) chunks.push(full.slice(i, i + 3800));

    const components = chunks
      .slice(0, 10)
      .map((chunk, i) =>
        infoEmbed(i === 0 ? entry.meta.name : `${entry.meta.name} (devam ${i + 1})`, chunk),
      );
    await message.reply({ flags: COMPONENTS_V2_FLAG, components }).catch(() => null);
  },
};

export default command;
