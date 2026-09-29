import { resolveEmojis, COMPONENTS_V2_FLAG, V2CardBuilder } from "../utils/componentsV2.js";
// src/events/modellerPanel.ts
// !modeller komutunun görünümünü (tek embed + select menu'ler) oluşturur.
// Owner-only: sadece bot sahibi hangi komut grubunun hangi AI modelini
// kullandığını buradan değiştirebilir (bkz. utils/modelSettings.ts).
//
// Üç grup var — kullanıcı hiçbirini değiştirmediği sürece koddaki orijinal
// varsayılan modeller (utils/modelSettings.ts'teki defaultModel) kullanılmaya
// devam eder.
//
// Tasarım: 4 ayrı embed yerine TEK embed, her grup bir field. Tüm modeller
// hâlâ listeleniyor ve aktif olan ✅ ile işaretleniyor (select menüden de
// seçilebiliyor) — sadece tekrar eden başlık/footer/renk gibi dolgu
// kaldırılarak toplam boy kısaltıldı. Gruplar sağlayıcı adıyla değil
// (Gemini/Groq/OpenRouter), modelin fiilen kullanıldığı yer/komutlarla
// etiketleniyor — owner "hangi model neyi çalıştırıyor" diye sağlayıcı
// isimlerini ezberlemek zorunda kalmasın diye.

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { MODEL_GROUPS, getActiveModel, hasOverride, type ModelGroup } from "../utils/modelSettings.js";
import { EMOJIS } from "../utils/emojis.js";

export const MODELLER_SELECT_PREFIX = "modeller_select_";
export const MODELLER_RESET_PREFIX = "modeller_reset_";

const GROUP_ORDER: ModelGroup[] = ["gemini", "groq", "openrouter"];

// Sağlayıcı adı yerine gösterilecek başlık: modelin kullanıldığı yer.
const GROUP_USAGE_LABEL: Record<ModelGroup, string> = {
  gemini: "Çeviri, Özet & Yazı",
  groq: "Sohbet, Fikir & AFK Cevap",
  openrouter: "Kod Araçları",
};

const GROUP_USAGE_COMMANDS: Record<ModelGroup, string> = {
  gemini: "`!ceviri` `!ozetle` `!yaz` `!bilgiyarismasi`",
  groq: "`!fikir` `!özet` `!sor` AFK otomatik cevap",
  openrouter: "`!kod-yaz` `!kod-analiz` `!kod-duzelt` `!kod-test`",
};

function providerPrefix(value: string): string {
  const sep = value.indexOf(":");
  return sep > 0 ? value.slice(0, sep) : "groq";
}

// Sadece görünüm için: aynı komut grubu (ör. "groq") altında birden fazla
// sağlayıcı olduğunda (Groq/Cerebras + NVIDIA gibi), liste içinde sağlayıcı
// değiştiğinde kalın bir alt başlık basılıyor. Fonksiyonel olarak hepsi aynı
// select menüde/komut grubunda kalmaya devam ediyor — bu sadece okunabilirlik
// için bir ayraç.
const SUBHEADER_LABEL: Record<string, string> = {
  nvidia: "**NVIDIA**",
  gemini: "**Gemini**",
  groq: "**Groq**",
  aimlapi: "**AIML API**",
  pixrouter: "**PixRouter**",
};

function groupField(group: ModelGroup): { name: string; value: string; inline: boolean } {
  const info = MODEL_GROUPS[group];
  const active = getActiveModel(group);

  let lastPrefix: string | null = null;
  const optionLines = info.options
    .flatMap((opt) => {
      const prefix = providerPrefix(opt.value);
      const header = prefix !== lastPrefix && SUBHEADER_LABEL[prefix] ? [SUBHEADER_LABEL[prefix]] : [];
      lastPrefix = prefix;
      const marker = opt.value === active ? EMOJIS.success : "▫️";
      const star = opt.value === info.defaultModel ? " ⭐" : "";
      return [...header, `${marker} ${opt.label}${star}`];
    })
    .join("\n");

  return {
    name: `${info.emoji} ${GROUP_USAGE_LABEL[group]}`,
    value: `-# ${GROUP_USAGE_COMMANDS[group]}\n${optionLines}`,
    inline: false,
  };
}

function selectRowFor(group: ModelGroup): ActionRowBuilder<StringSelectMenuBuilder> {
  const info = MODEL_GROUPS[group];
  const active = getActiveModel(group);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${MODELLER_SELECT_PREFIX}${group}`)
    .setPlaceholder(resolveEmojis(`${GROUP_USAGE_LABEL[group]} — model seç`))
    .addOptions(
      info.options.map((opt) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(resolveEmojis(opt.label))
          .setValue(opt.value)
          .setDefault(opt.value === active);
        if (opt.value === info.defaultModel) option.setDescription("Varsayılan");
        return option;
      }),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function resetButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MODELLER_RESET_PREFIX}all`)
      .setLabel(resolveEmojis("Tümünü Varsayılana Sıfırla"))
      .setEmoji("↩️")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildModellerView(): { flags: number; components: (V2CardBuilder | ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>)[] } {
  const embed = new V2CardBuilder()
    .setColor(0x2b2d31)
    .setTitle("🧠 AI Model Ayarları")
    .setDescription(`${EMOJIS.success} aktif · ⭐ varsayılan — menülerden değiştirebilirsin.`)
    .addFields(GROUP_ORDER.map((group) => groupField(group)));

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    ...GROUP_ORDER.map((group) => selectRowFor(group)),
    resetButtonRow(),
  ];

  return { flags: COMPONENTS_V2_FLAG, components: [embed, ...components] };
}
