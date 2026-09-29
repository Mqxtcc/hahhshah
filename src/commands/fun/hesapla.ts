import { textCard } from "../../utils/componentsV2.js";
import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed, errorEmbed } from "../../utils/embeds.js";
import { generateWithGroq } from "../../utils/groq.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";

// Güvenli bir dört işlem hesap makinesi. `eval`/`Function` KULLANILMIYOR —
// kullanıcı girdisi doğrudan JS olarak çalıştırılmaz (uzaktan kod çalıştırma
// riski). Bunun yerine basit bir shunting-yard ile kendi ifade ayrıştırıcımızı
// yazdık: sadece sayılar, + - * / ve parantez destekleniyor.

class ExpressionError extends Error {}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) num += expr[i++];
      if ((num.match(/\./g) ?? []).length > 1) throw new ExpressionError("Geçersiz sayı formatı.");
      tokens.push(num);
      continue;
    }
    if ("+-*/()".includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    throw new ExpressionError(`Beklenmeyen karakter: "${ch}"`);
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };

// Shunting-yard: infix -> RPN, sonra RPN'i hesapla. Sadece +,-,*,/ ve
// parantez olduğu için tam bir AST'ye gerek yok.
function toRpn(tokens: string[]): string[] {
  const output: string[] = [];
  const ops: string[] = [];
  let prevToken: string | null = null;

  for (const token of tokens) {
    if (/^[0-9.]+$/.test(token)) {
      output.push(token);
    } else if (token === "(") {
      ops.push(token);
    } else if (token === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") output.push(ops.pop()!);
      if (ops.pop() !== "(") throw new ExpressionError("Parantezler eşleşmiyor.");
    } else {
      // Unary minus/plus desteği: "-5" veya "(-5+2)" gibi durumlar için,
      // bir operatörden hemen sonra veya ifadenin başında gelen +/- işaretini
      // 0'dan çıkarma/ekleme olarak ele alıyoruz.
      const isUnary = token === "-" || token === "+";
      const prevWasOperandOrClose = prevToken !== null && (/^[0-9.]+$/.test(prevToken) || prevToken === ")");
      if (isUnary && !prevWasOperandOrClose) {
        output.push("0");
      }
      while (
        ops.length &&
        ops[ops.length - 1] !== "(" &&
        PRECEDENCE[ops[ops.length - 1]] >= PRECEDENCE[token]
      ) {
        output.push(ops.pop()!);
      }
      ops.push(token);
    }
    prevToken = token;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(") throw new ExpressionError("Parantezler eşleşmiyor.");
    output.push(op);
  }
  return output;
}

function evalRpn(rpn: string[]): number {
  const stack: number[] = [];
  for (const token of rpn) {
    if (/^[0-9.]+$/.test(token)) {
      stack.push(Number.parseFloat(token));
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new ExpressionError("Geçersiz ifade.");
    switch (token) {
      case "+": stack.push(a + b); break;
      case "-": stack.push(a - b); break;
      case "*": stack.push(a * b); break;
      case "/":
        if (b === 0) throw new ExpressionError("Sıfıra bölme yapılamaz.");
        stack.push(a / b);
        break;
      default: throw new ExpressionError(`Bilinmeyen işlem: ${token}`);
    }
  }
  if (stack.length !== 1) throw new ExpressionError("Geçersiz ifade.");
  return stack[0];
}

function safeEvaluate(expr: string): number {
  const tokens = tokenize(expr);
  if (tokens.length === 0) throw new ExpressionError("Boş ifade.");
  const rpn = toRpn(tokens);
  const result = evalRpn(rpn);
  if (!Number.isFinite(result)) throw new ExpressionError("Sonuç hesaplanamadı.");
  return result;
}

const MAX_EXPR_LENGTH = 200;

const AI_SYSTEM_PROMPT = `Sen bir hesap makinesisin. Kullanıcı sana bir matematik ifadesi, kelime problemi \
veya yüzde/oran hesabı verecek. Görevin SADECE sonucu hesaplamak.

KURALLAR:
- Yanıtın SADECE sayısal sonuç olsun (gerekiyorsa kısa birimle, ör. "%25" veya "42.5").
- Açıklama, adım adım çözüm, giriş cümlesi YAZMA — sadece nihai sonucu yaz.
- Sonucu bulamıyorsan veya ifade matematiksel değilse tek kelimeyle "HATA" yaz.
- Ondalık sonuçları makul bir hassasiyette (en fazla 6 basamak) yuvarla.`;

async function evaluateWithAi(expr: string): Promise<string | null> {
  try {
    const answer = await generateWithGroq(AI_SYSTEM_PROMPT, expr, { maxTokens: 200, temperature: 0 });
    const trimmed = answer.trim();
    if (!trimmed || /^hata$/i.test(trimmed)) return null;
    return trimmed;
  } catch (err) {
    console.error("hesapla fallback patladı:", err);
    return null;
  }
}

const command: Command = {
  name: "hesapla",
  aliases: ["hesap", "calc"],
  description: "Matematik ifadesini hesaplar; basit işlemler anında, karmaşık/kelime problemleri AI ile çözülür",
  usage: "!hesapla <ifade>  örn: !hesapla (12 + 8) * 3 / 2  |  !hesapla 150'nin %20 fazlası",
  category: "fun",

  async execute(message: Message, args: string[]) {
    const expr = args.join(" ").trim();
    if (!expr) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Eksik Kullanım", `Kullanım: \`${command.usage}\``)] });
    }
    if (expr.length > MAX_EXPR_LENGTH) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [errorEmbed("Çok Uzun", `İfade en fazla ${MAX_EXPR_LENGTH} karakter olabilir.`)] });
    }

    // Hızlı yol: basit +,-,*,/ ve parantez içeren saf sayısal ifadeler yerel
    // olarak, API'ye hiç gitmeden anında hesaplanır (ücretsiz, sınırsız,
    // gecikmesiz).
    try {
      const result = safeEvaluate(expr);
      const rounded = Math.round(result * 1e9) / 1e9;
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed("🧮 Sonuç", `\`${expr}\` = **${rounded}**`)] });
    } catch {
      // Yerel parser bunu anlayamadı (kelime problemi, yüzde, üs, karekök,
      // vb.) — AI'a düşülüyor. Bu yol diğer AI komutları gibi premium/deneme
      // kontrolünden geçer, çünkü API kotası tüketiyor.
      if (!(await requirePremiumOrTrial(message, "hesapla"))) return;

      const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Hesaplanıyor...`) });
      const aiResult = await evaluateWithAi(expr);
      if (!aiResult) {
        return loadingMsg.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [errorEmbed("Hesaplanamadı", "Bu ifadeyi ne yerel hesap makinesi ne de AI çözebildi. Daha net yazmayı dene.")],
        });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "hesapla");
      return loadingMsg.edit({
        flags: MessageFlags.IsComponentsV2,
        components: [infoEmbed("🧮 Sonuç (AI)", `\`${expr}\` = **${aiResult}**`, { footer: "Karmaşık ifade — AI ile hesaplandı" })],
      });
    }
  },
};


addSlash(command, [
  { name: "ifade", description: "Matematiksel ifade", type: "string", required: true },
]);

export default command;
