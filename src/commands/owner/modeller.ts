import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { COMPONENTS_V2_FLAG } from "../../utils/componentsV2.js";
import { requireOwner } from "../../events/messageCreate.js";
import { buildModellerView } from "../../events/modellerPanel.js";

// !modeller — owner-only. Gemini / Groq / OpenRouter için hangi modelin
// kullanılacağını seçmeyi sağlayan bir menü açar (bkz. events/modellerPanel.ts,
// utils/modelSettings.ts). Seçimler data/model-settings.json dosyasına kalıcı
// yazılır; owner hiçbir şey değiştirmezse mevcut/varsayılan modeller aynen
// kullanılmaya devam eder.
const command: Command = {
  name: "modeller",
  aliases: ["model", "aimodel", "aimodeller"],
  description: "Komut gruplarının kullandığı AI modelini seçmeni sağlar (owner-only)",
  usage: "!modeller",
  category: "owner",

  async execute(message: Message) {
    if (!(await requireOwner(message))) return;
    const view = buildModellerView();
    await message.reply({ ...view, flags: COMPONENTS_V2_FLAG, components: [...((view as any).embeds ?? []), ...((view as any).components ?? [])] } as any).catch(() => null);
  },
};

export default command;
