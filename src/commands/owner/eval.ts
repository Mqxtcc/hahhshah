import { COMPONENTS_V2_FLAG, fileComponent, V2CardBuilder } from "../../utils/componentsV2.js";
import util from "node:util";
import {
  AttachmentBuilder,
  type Message,
} from "discord.js";
import type { Command } from "../../types.js";
import { EMOJIS } from "../../utils/emojis.js";
import { requireOwner, getGuildPrefix } from "../../events/messageCreate.js";
import { usageEmbed } from "../../utils/messages.js";

// Güvenlik: yalnızca bot sahibi çalıştırabilir (requireOwner → OWNER_ID
// karşılaştırması). message.author.id Discord gateway üzerinden doğrulanır,
// taklit edilemez.
const EVAL_TIMEOUT_MS = 120_000;
const INPUT_PREVIEW_LIMIT = 500; // embed'de gösterilen girdi
const LOG_PREVIEW_LIMIT = 1400; // embed'de gösterilen konsol çıktısı
const RESULT_PREVIEW_LIMIT = 1500; // embed'de gösterilen dönen değer
const OUTPUT_FILE_LIMIT = 3500; // üstü dosyaya gider

/** .env'deki gizli değerleri konsol audit log'undan maskele. */
function maskSecrets(text: string): string {
  let out = text;
  for (const [key, val] of Object.entries(process.env)) {
    if (val && val.length >= 6) {
      out = out.split(val).join(`[GİZLİ:${key}]`);
    }
  }
  return out;
}

/** ```js ... ``` bloklarını temizle, ham kodu ver. */
function cleanCode(raw: string): string {
  const code = raw.trim();
  const fence = code.match(/^```(?:js|ts|javascript|typescript)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) return fence[1].trim();
  if (code.startsWith("`") && code.endsWith("`") && code.length > 2) {
    return code.slice(1, -1);
  }
  return code;
}

function codeBlock(text: string, lang = "js"): string {
  const safe = text.replace(/```/g, "`\u200b``");
  return `\`\`\`${lang}\n${safe}\n\`\`\``;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + "\n…(kısaltıldı)" : text;
}

/** Sonucu metne çevir + tipini bul. */
function formatResult(value: unknown): { text: string; type: string } {
  if (typeof value === "string") return { text: value, type: "string" };
  if (value === undefined) return { text: "undefined", type: "undefined" };
  if (value === null) return { text: "null", type: "null" };
  const type = Array.isArray(value) ? `array[${value.length}]` : typeof value;
  return {
    text: util.inspect(value, { depth: 4, maxArrayLength: 100, breakLength: 100 }),
    type,
  };
}

interface EvalScope {
  message: Message;
}

interface EvalOutcome {
  value?: unknown;
  logs: string[];
  error?: unknown;
}

/**
 * Kodu çalıştırır. message/client/guild/channel/author scope'ta.
 * Çalışma sırasındaki console.log/error/warn/info/debug çıktılarını yakalar.
 */
async function runCode(code: string, scope: EvalScope): Promise<EvalOutcome> {
  const { message } = scope;
  const client = message.client;
  const guild = message.guild;
  const channel = message.channel;
  const author = message.author;

  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(
      "message",
      "client",
      "guild",
      "channel",
      "author",
      `return (async () => {\n${code}\n})();`,
    ) as (...args: unknown[]) => Promise<unknown>;
  } catch (err) {
    return { logs: [], error: new SyntaxError(`Sözdizimi hatası: ${(err as Error).message}`) };
  }

  // console.* yakalama
  const logs: string[] = [];
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  const capture = (...args: unknown[]) => {
    logs.push(
      args
        .map((a) =>
          typeof a === "string" ? a : util.inspect(a, { depth: 4, maxArrayLength: 100 }),
        )
        .join(" "),
    );
  };
  console.log = capture as typeof console.log;
  console.error = capture as typeof console.error;
  console.warn = capture as typeof console.warn;
  console.info = capture as typeof console.info;
  console.debug = capture as typeof console.debug;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`⏱️ ${EVAL_TIMEOUT_MS / 1000} saniyede tamamlanmadı (timeout).`)),
        EVAL_TIMEOUT_MS,
      );
    });
    const value = await Promise.race([fn(message, client, guild, channel, author), timeout]);
    return { value, logs };
  } catch (error) {
    return { logs, error };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
    console.info = originals.info;
    console.debug = originals.debug;
  }
}

const command: Command = {
  name: "eval",
  aliases: ["ev"],
  description: "JS/TS kodu çalıştırır (owner-only)",
  usage: "!eval <kod>",
  category: "owner",

  async execute(message: Message) {
    if (!(await requireOwner(message))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const code = cleanCode(message.content.slice(prefix.length).replace(/^ev(al)?\s*/i, ""));
    if (!code) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [usageEmbed(
          `${EMOJIS.usage} Kullanım: \`${prefix}eval <js/ts kodu>\`\n` +
            `Örnek: \`${prefix}eval message.guild?.memberCount\``,
        )] })
        .catch(() => null);
      return;
    }

    // Audit log: konsolda (ve !console-log'da) kalıcı iz. Gizli değerler maskeli.
    console.log(
      `eval — ${message.author.tag} (${message.author.id}) — kanal: ${message.channel.id} — kod: ${maskSecrets(code.slice(0, 500))}`,
    );

    const inputPreview =
      code.length > INPUT_PREVIEW_LIMIT
        ? `*girdi uzun olduğu için gösterilmedi (${code.length} karakter)*`
        : codeBlock(code);
    const started = Date.now();
    const outcome = await runCode(code, { message });
    const ms = Date.now() - started;

    const logText = outcome.logs.join("\n");
    const sections: string[] = [`📥 **Girdi:**`, inputPreview];
    if (logText) sections.push(`🖥️ **Konsol:**`, codeBlock(truncate(logText, LOG_PREVIEW_LIMIT)));

    if (outcome.error === undefined) {
      const { text, type } = formatResult(outcome.value);
      const fullOutput = (logText ? logText + "\n\n" : "") + text;
      const tooLong = fullOutput.length > OUTPUT_FILE_LIMIT;

      sections.push(
        `📤 **Dönen değer:**`,
        tooLong
          ? `*çıktı çok uzun (${fullOutput.length} karakter), dosya olarak gönderildi*`
          : codeBlock(truncate(text, RESULT_PREVIEW_LIMIT) || "undefined"),
      );

      const embed = new V2CardBuilder()
        .setColor(0x57f287)
        .setTitle(`${EMOJIS.success} Eval sonucu`)
        .setDescription(sections.join("\n"))
        .setFooter({ text: `⏱️ ${ms}ms • tip: ${type}` })
        .setTimestamp();

      if (tooLong) {
        const file = new AttachmentBuilder(Buffer.from(fullOutput, "utf-8"), {
          name: "eval-cikti.txt",
        });
        await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed, fileComponent(file.name ?? "eval-cikti.txt")], files: [file] }).catch(() => null);
      } else {
        await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
      }
    } else {
      const err = outcome.error;
      const errText =
        err instanceof Error
          ? `${err.name}: ${err.message}` +
            (err.stack ? `\n${err.stack.split("\n").slice(1, 5).join("\n")}` : "")
          : String(err);

      sections.push(`📤 **Hata:**`, codeBlock(truncate(errText, 3000), ""));
      const embed = new V2CardBuilder()
        .setColor(0xed4245)
        .setTitle(`${EMOJIS.error} Eval hatası`)
        .setDescription(sections.join("\n"))
        .setFooter({ text: `⏱️ ${ms}ms` })
        .setTimestamp();
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [embed] }).catch(() => null);
    }
  },
};

export default command;
