import { V2CardBuilder } from "../utils/componentsV2.js";
import { v2Payload } from "../utils/messages.js";
import { type Message } from "discord.js";
import { COLORS } from "../utils/embeds.js";
import type { CustomEvent } from "./store.js";

// ---------------------------------------------------------------------------
// Custom Event "kod" motoru.
//
// GÜVENLİK: Buradaki "kod", HİÇBİR ZAMAN JavaScript/TypeScript olarak
// çalıştırılmaz. eval(), Function(), require(), fs, fetch, process — hiçbiri
// yok. Sadece aşağıda tanımlı sabit bir placeholder/tag listesi metin içinde
// arayıp yerine güvenli değerler koyan düz bir string-işleme fonksiyonudur.
// (YAGPDB'nin "Custom Command" sistemindeki mantığın basitleştirilmiş hali:
// kullanıcıya "kod yazıyormuş" hissi veren ama aslında sabit/öngörülebilir
// bir şablon dili.) Bu sayede sunucu sahibi ne yazarsa yazsın botun sunucusu
// veya diğer sunucular için risk oluşturmaz.
// ---------------------------------------------------------------------------

export const MAX_CODE_LENGTH = 5000;
export const MAX_OUTPUT_LENGTH = 1900; // Discord mesaj limitine (2000) pay bırak

export interface RenderContext {
  message: Message;
  args: string[]; // özel komuttan sonra gelen argümanlar (ör. "!selam ahmet" -> ["ahmet"])
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
}

// İki tarih arasındaki tam gün farkı (hesap yaşı / üyelik süresi gibi
// etiketler için). Negatif/eksik durumlarda "-" döner.
function daysSince(d: Date | null | undefined): string {
  if (!d) return "-";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "0";
  return String(Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

const CHANNEL_TYPE_NAMES: Record<number, string> = {
  0: "metin",
  2: "ses",
  4: "kategori",
  5: "duyuru",
  13: "sahne",
  15: "forum",
};

// {rastgele:a|b|c} gibi tekrarlanabilir tag'ler için basit regex tabanlı
// değişim. Hepsi tek geçişte, iç içe (nested) tag DESTEKLENMEZ — bilerek:
// karmaşık/iç içe yapı = öngörülemezlik = güvenlik riski.
function applyPlaceholders(template: string, ctx: RenderContext): string {
  const { message, args } = ctx;
  const author = message.author;
  const guild = message.guild!;
  const member = message.member;
  const channel = message.channel as unknown as { name?: string; toString: () => string };
  const channelName = channel.name ?? "kanal";

  // İlk etiketlenen kullanıcı (varsa) — rastgele bir kullanıcıyı ID ile
  // etiketleme YOK, sadece komutu çalıştıran kişinin mesajında zaten
  // etiketlediği biri kullanılabilir. Bu, custom event'in @herkes gibi
  // istenmeyen ping atmasını engeller.
  const mentioned = message.mentions.users.first();
  const mentionedMember = message.mentions.members?.first() ?? null;
  // Reply (yanıtla) ile hitap edilen kullanıcı — aynı güvenlik mantığı:
  // sadece mesajın kendisinde zaten var olan bir referans kullanılabilir.
  const repliedUser = message.mentions.repliedUser ?? null;

  const now = new Date();
  const dateStr = now.toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
  const timeStr = now.toLocaleTimeString("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" });
  const dayStr = now.toLocaleDateString("tr-TR", { weekday: "long", timeZone: "Europe/Istanbul" });
  const yearStr = String(now.getFullYear());
  const monthStr = now.toLocaleDateString("tr-TR", { month: "long", timeZone: "Europe/Istanbul" });

  // Rol/renk/boost gibi bilgiler sadece GuildMember üzerinden erişilebilir
  // (mesaj DM'den gelmiyorsa her zaman dolu olur, custom event'ler zaten
  // sadece sunucu içinde çalışıyor).
  const highestRole = member && member.roles.highest.id !== guild.id ? member.roles.highest : null;
  const roleCount = member ? Math.max(0, member.roles.cache.size - 1) : 0; // @everyone hariç
  const nickname = member?.nickname ?? author.username;
  const isBoosting = Boolean(member?.premiumSince);
  const rawChannel = message.channel as unknown as { type?: number; topic?: string | null };

  let out = template;

  // Basit (argümansız) placeholder'lar
  const simple: Record<string, string> = {
    "{kullanıcı}": `${author}`,
    "{kullanici}": `${author}`,
    "{kullanıcı.ad}": author.username,
    "{kullanici.ad}": author.username,
    "{kullanıcı.id}": author.id,
    "{kullanici.id}": author.id,
    "{kullanıcı.avatar}": author.displayAvatarURL(),
    "{kullanici.avatar}": author.displayAvatarURL(),
    "{kullanıcı.oluşturulma}": formatDate(author.createdAt),
    "{kullanici.olusturulma}": formatDate(author.createdAt),
    "{kullanıcı.katılma}": formatDate(member?.joinedAt ?? null),
    "{kullanici.katilma}": formatDate(member?.joinedAt ?? null),
    "{kullanıcı.takma-ad}": nickname,
    "{kullanici.takma-ad}": nickname,
    "{kullanıcı.rol}": highestRole ? highestRole.name : "Rol yok",
    "{kullanici.rol}": highestRole ? highestRole.name : "Rol yok",
    "{kullanıcı.rol-sayısı}": String(roleCount),
    "{kullanici.rol-sayisi}": String(roleCount),
    "{kullanıcı.renk}": highestRole && highestRole.color ? `#${highestRole.color.toString(16).padStart(6, "0")}` : "Varsayılan",
    "{kullanici.renk}": highestRole && highestRole.color ? `#${highestRole.color.toString(16).padStart(6, "0")}` : "Varsayılan",
    "{kullanıcı.boost}": isBoosting ? "Evet" : "Hayır",
    "{kullanici.boost}": isBoosting ? "Evet" : "Hayır",
    "{kullanıcı.bot-mu}": author.bot ? "Evet" : "Hayır",
    "{kullanici.bot-mu}": author.bot ? "Evet" : "Hayır",
    "{kullanıcı.hesap-yaşı}": daysSince(author.createdAt),
    "{kullanici.hesap-yasi}": daysSince(author.createdAt),
    "{kullanıcı.üyelik-süresi}": daysSince(member?.joinedAt ?? null),
    "{kullanici.uyelik-suresi}": daysSince(member?.joinedAt ?? null),
    "{etiketlenen}": mentioned ? `${mentioned}` : "",
    "{etiketlenen.ad}": mentioned ? mentioned.username : "",
    "{etiketlenen.id}": mentioned ? mentioned.id : "",
    "{etiketlenen.takma-ad}": mentionedMember?.nickname ?? mentioned?.username ?? "",
    "{yanıtlanan}": repliedUser ? `${repliedUser}` : "",
    "{yanitlanan}": repliedUser ? `${repliedUser}` : "",
    "{yanıtlanan.ad}": repliedUser ? repliedUser.username : "",
    "{yanitlanan.ad}": repliedUser ? repliedUser.username : "",
    "{yanıtlanan.id}": repliedUser ? repliedUser.id : "",
    "{yanitlanan.id}": repliedUser ? repliedUser.id : "",
    "{sunucu}": guild.name,
    "{sunucu.ad}": guild.name,
    "{sunucu.id}": guild.id,
    "{sunucu.üye}": String(guild.memberCount),
    "{sunucu.uye}": String(guild.memberCount),
    "{sunucu.sahibi}": `<@${guild.ownerId}>`,
    "{sunucu.icon}": guild.iconURL() ?? "",
    "{sunucu.oluşturulma}": formatDate(guild.createdAt),
    "{sunucu.olusturulma}": formatDate(guild.createdAt),
    "{sunucu.boost-seviyesi}": String(guild.premiumTier ?? 0),
    "{sunucu.boost-seviye}": String(guild.premiumTier ?? 0),
    "{sunucu.boost-sayısı}": String(guild.premiumSubscriptionCount ?? 0),
    "{sunucu.boost-sayisi}": String(guild.premiumSubscriptionCount ?? 0),
    "{sunucu.kanal-sayısı}": String(guild.channels.cache.size),
    "{sunucu.kanal-sayisi}": String(guild.channels.cache.size),
    "{sunucu.rol-sayısı}": String(guild.roles.cache.size),
    "{sunucu.rol-sayisi}": String(guild.roles.cache.size),
    "{sunucu.emoji-sayısı}": String(guild.emojis.cache.size),
    "{sunucu.emoji-sayisi}": String(guild.emojis.cache.size),
    "{kanal}": channel.toString(),
    "{kanal.ad}": channelName,
    "{kanal.id}": message.channelId,
    "{kanal.konu}": rawChannel.topic ?? "",
    "{kanal.tür}": CHANNEL_TYPE_NAMES[rawChannel.type ?? -1] ?? "bilinmiyor",
    "{kanal.tur}": CHANNEL_TYPE_NAMES[rawChannel.type ?? -1] ?? "bilinmiyor",
    "{mesaj.id}": message.id,
    "{argümanlar}": args.join(" "),
    "{arguman}": args.join(" "),
    "{args}": args.join(" "),
    "{argsayı}": String(args.length),
    "{argsayi}": String(args.length),
    "{tarih}": dateStr,
    "{saat}": timeStr,
    "{gün}": dayStr,
    "{gun}": dayStr,
    "{yıl}": yearStr,
    "{yil}": yearStr,
    "{ay}": monthStr,
    "{tarihsaat}": `${dateStr} ${timeStr}`,
    "{boşluk}": " ",
    "{bosluk}": " ",
  };

  for (const [tag, value] of Object.entries(simple)) {
    if (out.includes(tag)) out = out.split(tag).join(value);
  }

  // {arg1} .. {arg9} — pozisyonel argümanlar
  for (let i = 1; i <= 9; i++) {
    const tag = `{arg${i}}`;
    if (out.includes(tag)) out = out.split(tag).join(args[i - 1] ?? "");
  }

  // {yazitura} / {evethayır} — her geçtiği yerde bağımsız olarak rastgele
  // (aynı {rastgele:...} mantığı: tek geçişte, her eşleşme kendi zarını atar).
  out = out.replace(/\{yazitura\}/gi, () => (Math.random() < 0.5 ? "Yazı" : "Tura"));
  out = out.replace(/\{evethayır\}/gi, () => (Math.random() < 0.5 ? "Evet" : "Hayır"));
  out = out.replace(/\{evethayir\}/gi, () => (Math.random() < 0.5 ? "Evet" : "Hayır"));

  // {argkalan:N} -> N. argümandan itibaren kalan tüm argümanlar (boşlukla
  // birleştirilmiş). Ör. "!uyar @kişi spam yapıyor" içinde {argkalan:2}
  // "spam yapıyor" verir (1. arg etiketlenen kişi olduğu için).
  out = out.replace(/\{argkalan:(\d+)\}/gi, (_match, nStr: string) => {
    const n = Number(nStr);
    if (!Number.isFinite(n) || n < 1) return "";
    return args.slice(n - 1).join(" ");
  });

  // {argvar:N} -> N. argüman var mı? Evet/Hayır (koşullu metin kurmak için)
  out = out.replace(/\{argvar:(\d+)\}/gi, (_match, nStr: string) => {
    const n = Number(nStr);
    if (!Number.isFinite(n) || n < 1) return "Hayır";
    return args[n - 1] !== undefined ? "Evet" : "Hayır";
  });

  // {uzunluk:metin} -> metnin karakter sayısı
  out = out.replace(/\{uzunluk:([^{}]*)\}/gi, (_m, text: string) => String(text.length));

  // {ters:metin} -> metni ters çevirir
  out = out.replace(/\{ters:([^{}]*)\}/gi, (_m, text: string) => [...text].reverse().join(""));

  // {tekrar:metin|N} -> metni N kez tekrarlar (spam'i önlemek için en fazla 20)
  out = out.replace(/\{tekrar:([^{}|]*)\|(\d+)\}/gi, (_m, text: string, nStr: string) => {
    const n = Math.max(0, Math.min(20, Number(nStr)));
    return text.repeat(n);
  });

  // {rastgele:a|b|c} -> a, b veya c'den rastgele biri
  out = out.replace(/\{rastgele:([^{}]*)\}/gi, (_match, list: string) => {
    const options = list.split("|").map((s) => s.trim()).filter(Boolean);
    if (options.length === 0) return "";
    return options[Math.floor(Math.random() * options.length)];
  });

  // {sayı:1-100} -> min-max (dahil) arası rastgele tam sayı
  out = out.replace(/\{sayı:(-?\d+)-(-?\d+)\}/gi, (_match, minStr: string, maxStr: string) => {
    const min = Math.min(Number(minStr), Number(maxStr));
    const max = Math.max(Number(minStr), Number(maxStr));
    return String(min + Math.floor(Math.random() * (max - min + 1)));
  });
  out = out.replace(/\{sayi:(-?\d+)-(-?\d+)\}/gi, (_match, minStr: string, maxStr: string) => {
    const min = Math.min(Number(minStr), Number(maxStr));
    const max = Math.max(Number(minStr), Number(maxStr));
    return String(min + Math.floor(Math.random() * (max - min + 1)));
  });

  // {büyük:metin} / {küçük:metin} -> harf büyütme/küçültme (tr-TR kurallı)
  out = out.replace(/\{büyük:([^{}]*)\}/gi, (_m, text: string) => text.toLocaleUpperCase("tr-TR"));
  out = out.replace(/\{buyuk:([^{}]*)\}/gi, (_m, text: string) => text.toLocaleUpperCase("tr-TR"));
  out = out.replace(/\{küçük:([^{}]*)\}/gi, (_m, text: string) => text.toLocaleLowerCase("tr-TR"));
  out = out.replace(/\{kucuk:([^{}]*)\}/gi, (_m, text: string) => text.toLocaleLowerCase("tr-TR"));

  return out;
}

// Bilinmeyen/artık {...} kalıpları (yanlış yazılmış tag'ler) mesajın olduğu
// gibi geçmesini istemiyoruz ama silmiyoruz da — kullanıcı hatasını görüp
// düzeltebilsin diye olduğu gibi bırakılır. Tek yaptığımız şey: uzunluk
// sınırı.
function clampLength(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type RenderResult =
  | { kind: "text"; content: string }
  | { kind: "embed"; embed: V2CardBuilder; content?: string };

const HEX_COLOR_REGEX = /^#?[0-9a-fA-F]{6}$/;

// {embed} ... {/embed} bloğu içinde satır satır: başlık:, açıklama:, renk:,
// alan: Ad | Değer (en fazla 5 kez tekrarlanabilir). Blok dışında kalan metin
// yok sayılır — karışıklığı önlemek için "ya düz mesaj ya embed" mantığı.
function tryParseEmbed(template: string, ctx: RenderContext): V2CardBuilder | null {
  const match = template.match(/\{embed\}([\s\S]*?)\{\/embed\}/i);
  if (!match) return null;

  const body = applyPlaceholders(match[1], ctx);
  const embed = new V2CardBuilder().setColor(COLORS.info);
  let fieldCount = 0;
  let hasContent = false;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const titleMatch = line.match(/^(?:başlık|baslik)\s*:\s*(.+)$/i);
    if (titleMatch) {
      embed.setTitle(clampLength(titleMatch[1].trim(), 256));
      hasContent = true;
      continue;
    }

    const descMatch = line.match(/^(?:açıklama|aciklama)\s*:\s*(.+)$/i);
    if (descMatch) {
      embed.setDescription(clampLength(descMatch[1].trim(), 4096));
      hasContent = true;
      continue;
    }

    const colorMatch = line.match(/^renk\s*:\s*(.+)$/i);
    if (colorMatch) {
      const raw = colorMatch[1].trim();
      if (HEX_COLOR_REGEX.test(raw)) {
        embed.setColor(parseInt(raw.replace("#", ""), 16));
      }
      continue;
    }

    const fieldMatch = line.match(/^alan\s*:\s*(.+?)\s*\|\s*(.+)$/i);
    if (fieldMatch && fieldCount < 5) {
      embed.addFields({
        name: clampLength(fieldMatch[1].trim(), 256),
        value: clampLength(fieldMatch[2].trim(), 1024),
      });
      fieldCount++;
      hasContent = true;
      continue;
    }
    // Tanınmayan satırlar sessizce yok sayılır.
  }

  return hasContent ? embed : null;
}

// Kullanıcılar `!customevent-liste`'deki örnekte gösterildiği gibi gerçek
// satır sonu yerine düz metin `\n` (ters eğik çizgi + n) de yazabiliyor —
// özellikle örneği olduğu gibi kopyala-yapıştır yaptıklarında. Discord bunu
// GERÇEK bir satır sonuna çevirmez, iki ayrı karakter (`\` ve `n`) olarak
// kalır; bu yüzden {embed} bloğu satır satır ayrıştırılırken hiçbir alan
// (başlık/açıklama/renk/alan) tanınmıyor ve embed tamamen bozuk çıkıyordu.
// Burada her iki yazımı da (gerçek satır sonu VE düz `\n` metni) satır sonu
// olarak kabul ediyoruz — hem eski (zaten bozuk kaydedilmiş) custom event'ler
// hem yeni oluşturulanlar için, kayıt anında değil HER render'da normalize
// edildiği için otomatik olarak düzelir.
function normalizeLineBreaks(code: string): string {
  return code.replace(/\\n/g, "\n");
}

/**
 * Bir custom event "kod"unu, komutu çalıştıran mesaj bağlamına göre işler.
 * ASLA kod çalıştırmaz — sadece metin/placeholder değişimi yapar.
 */
export function renderCustomEvent(code: string, ctx: RenderContext): RenderResult {
  const normalizedCode = normalizeLineBreaks(code);

  if (/\{embed\}[\s\S]*\{\/embed\}/i.test(normalizedCode)) {
    const embed = tryParseEmbed(normalizedCode, ctx);
    if (embed) return { kind: "embed", embed };
  }

  const rendered = applyPlaceholders(normalizedCode, ctx);
  return { kind: "text", content: clampLength(rendered, MAX_OUTPUT_LENGTH) || "\u200b" };
}

// Kod kaydedilirken (oluşturma anında) temel bir doğrulama: uzunluk + açık
// açık şekilde tehlikeli/anlamsız örüntüler (biri "eval(", "require(" gibi
// bir şey yapıştırsa bile zaten çalıştırılmayacak ama kullanıcıyı en baştan
// uyarmak/yanlış beklentiye sokmamak için basit bir kontrol).
export function validateCustomEventCode(code: string): string | null {
  if (!code || !code.trim()) return "Kod boş olamaz.";
  if (code.length > MAX_CODE_LENGTH) return `Kod en fazla ${MAX_CODE_LENGTH} karakter olabilir (şu an ${code.length}).`;
  const embedOpen = (code.match(/\{embed\}/gi) ?? []).length;
  const embedClose = (code.match(/\{\/embed\}/gi) ?? []).length;
  if (embedOpen !== embedClose || embedOpen > 1) {
    return "`{embed}` ve `{/embed}` tam olarak bir kez ve eşleşecek şekilde kullanılmalı.";
  }
  if ((code.match(/\{\{/g) ?? []).length !== (code.match(/\}\}/g) ?? []).length) {
    return "YAGPDB şablon etiketleri `{{` ve `}}` olarak dengeli kullanılmalı.";
  }
  if (code.includes("{{range ") || code.includes("{{ for ") || code.includes("{{while ")) {
    return "Döngüler güvenlik nedeniyle desteklenmiyor.";
  }
  if (code.includes("{{")) {
    try {
      const parsed = parseTemplateNodes(templateTokens(code));
      if (parsed.stop) return "Şablon bloğu kapanmadan veya yanlış sırada bitmiş.";
    } catch (err) {
      return err instanceof Error ? err.message : "Şablon yapısı geçersiz.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Güvenli YAGPDB-uyumlu mini şablon motoru
//
// Bu bölüm Go/JavaScript çalıştırmaz. Şablon önce AST'ye ayrılır, sonra yalnızca
// aşağıdaki fonksiyon/alan listesi değerlendirilir. Döngü, recursion, eval,
// Function, dosya/ağ erişimi ve keyfi Discord API çağrısı yoktur.
// ---------------------------------------------------------------------------

const SAFE_TEMPLATE_MAX_STEPS = 600;
const SAFE_TEMPLATE_MAX_ACTIONS = 8;
const SAFE_TEMPLATE_MAX_ARGUMENTS = 25;
const SAFE_PERMISSION_NAMES = new Set(["ManageMessages", "ManageRoles", "ModerateMembers", "Administrator"]);

type TemplateValue = string | number | boolean | null | TemplateValue[];
type SafeAction =
  | { type: "sendMessage"; content: string }
  | { type: "sendDM"; content: string }
  | { type: "deleteTrigger" }
  | { type: "giveRole"; targetId: string; roleId: string }
  | { type: "takeRole"; targetId: string; roleId: string };

export interface SafeExecutionResult {
  kind: "text";
  content: string;
  actions: SafeAction[];
}

interface EvalState {
  message: Message;
  args: string[];
  variables: Map<string, TemplateValue>;
  steps: number;
}

type TemplateNode =
  | { kind: "text"; value: string }
  | { kind: "directive"; value: string }
  | { kind: "if"; condition: string; yes: TemplateNode[]; no: TemplateNode[] };

function templateTokens(template: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  const pattern = /\{\{([\s\S]*?)\}\}/g;
  for (let match = pattern.exec(template); match; match = pattern.exec(template)) {
    if (match.index > cursor) tokens.push(template.slice(cursor, match.index));
    tokens.push(`\u0000${match[1]}\u0000`);
    cursor = match.index + match[0].length;
  }
  if (cursor < template.length) tokens.push(template.slice(cursor));
  return tokens;
}

function isDirective(token: string): boolean {
  return token.startsWith("\u0000") && token.endsWith("\u0000");
}

function directiveValue(token: string): string {
  return token.slice(1, -1).trim().replace(/^-|-$/g, "").trim();
}

function parseTemplateNodes(tokens: string[], start = 0, stopAt: Set<string> = new Set()): {
  nodes: TemplateNode[];
  index: number;
  stop: string | null;
} {
  const nodes: TemplateNode[] = [];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!isDirective(token)) {
      nodes.push({ kind: "text", value: token });
      index++;
      continue;
    }

    const value = directiveValue(token);
    const keyword = value.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    if (stopAt.has(keyword)) return { nodes, index, stop: keyword };
    if (keyword === "if") {
      const condition = value.slice(2).trim();
      if (!condition) throw new Error("if koşulu boş olamaz.");
      const yes = parseTemplateNodes(tokens, index + 1, new Set(["else", "end"]));
      let no: TemplateNode[] = [];
      index = yes.index;
      if (yes.stop === "else") {
        const otherwise = parseTemplateNodes(tokens, index + 1, new Set(["end"]));
        no = otherwise.nodes;
        index = otherwise.index;
        if (otherwise.stop !== "end") throw new Error("if bloğu için {{end}} eksik.");
      } else if (yes.stop !== "end") {
        throw new Error("if bloğu için {{end}} eksik.");
      }
      nodes.push({ kind: "if", condition, yes: yes.nodes, no });
      index++;
      continue;
    }
    if (keyword === "else" || keyword === "end") {
      return { nodes, index, stop: keyword };
    }
    if (keyword === "range" || keyword === "for" || keyword === "while") {
      throw new Error("Döngüler güvenlik nedeniyle desteklenmiyor.");
    }
    nodes.push({ kind: "directive", value });
    index++;
  }
  return { nodes, index, stop: null };
}

function tokenizeExpression(expression: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const flush = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of expression.trim()) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      flush();
      quote = char;
      current = char;
      continue;
    }
    if (char === "(" || char === ")") {
      flush();
      tokens.push(char);
      continue;
    }
    if (/\s/.test(char)) flush();
    else current += char;
  }
  if (quote) throw new Error("Kapanmamış tırnak.");
  flush();
  return tokens;
}

function unquote(value: string): string | null {
  if (value.length < 2) return null;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first !== '"' && first !== "'") || first !== last) return null;
  return value.slice(1, -1).replace(/\\(["'\\nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function valueAtPath(path: string, state: EvalState): TemplateValue {
  const message = state.message;
  const guild = message.guild;
  const member = message.member;
  const mentioned = message.mentions.users.first();
  const mentionedMember = message.mentions.members?.first();
  const lowerPath = path.toLowerCase();
  const values: Record<string, TemplateValue> = {
    ".user.id": message.author.id,
    ".user.username": message.author.username,
    ".user.name": message.author.username,
    ".user.mention": `<@${message.author.id}>`,
    ".user.bot": message.author.bot,
    ".user.createdat": message.author.createdAt.toISOString(),
    ".member.id": member?.id ?? "",
    ".member.nick": member?.nickname ?? "",
    ".member.joinedat": member?.joinedAt?.toISOString() ?? "",
    ".server.id": guild?.id ?? "",
    ".server.name": guild?.name ?? "",
    ".server.membercount": guild?.memberCount ?? 0,
    ".server.ownerid": guild?.ownerId ?? "",
    ".channel.id": message.channelId,
    ".channel.name": "name" in message.channel ? String(message.channel.name ?? "") : "",
    ".message.id": message.id,
    ".message.content": message.content,
    ".strippedmsg": message.content,
    ".args": state.args,
    ".cmdargs": state.args,
    ".mentioneduser.id": mentioned?.id ?? "",
    ".mentioneduser.username": mentioned?.username ?? "",
    ".mentioneduser.mention": mentioned ? `<@${mentioned.id}>` : "",
    ".mentionedmember.nick": mentionedMember?.nickname ?? "",
  };
  return values[lowerPath] ?? "";
}

function primitiveValue(token: string, state: EvalState): TemplateValue {
  const quoted = unquote(token);
  if (quoted !== null) return quoted;
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "nil" || token === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
  if (token.startsWith("$")) return state.variables.get(token.slice(1)) ?? "";
  if (token.startsWith(".")) return valueAtPath(token, state);
  return token;
}

const FUNCTION_ARITY: Record<string, number> = {
  eq: 2,
  ne: 2,
  gt: 2,
  ge: 2,
  gte: 2,
  lt: 2,
  le: 2,
  lte: 2,
  and: 2,
  or: 2,
  not: 1,
  len: 1,
  toint: 1,
  tofloat: 1,
  tostring: 1,
  lower: 1,
  upper: 1,
  index: 2,
  contains: 2,
  hasroleid: 1,
  haspermission: 1,
  joinstr: Number.MAX_SAFE_INTEGER,
  userarg: 1,
};

function truthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== false && value !== "" && value !== 0;
}

function asText(value: TemplateValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(asText).join(" ");
  return String(value);
}

function takeExpression(tokens: string[], cursor: number, state: EvalState): { value: TemplateValue; next: number } {
  const token = tokens[cursor];
  if (!token) return { value: "", next: cursor };
  if (token === "(") {
    const nested = parseExpression(tokens, cursor + 1, state, true);
    if (tokens[nested.next] !== ")") throw new Error("Parantez dengesi bozuk.");
    return { value: nested.value, next: nested.next + 1 };
  }
  return { value: primitiveValue(token, state), next: cursor + 1 };
}

function compareValues(left: TemplateValue, right: TemplateValue): boolean {
  if (typeof left === "number" && typeof right === "number") return left === right;
  return asText(left) === asText(right);
}

function parseExpression(
  tokens: string[],
  start: number,
  state: EvalState,
  stopAtCloseParen = false,
): { value: TemplateValue; next: number } {
  state.steps++;
  if (state.steps > SAFE_TEMPLATE_MAX_STEPS) throw new Error("Şablon işlem sınırını aştı.");
  const name = tokens[start]?.toLowerCase();
  if (!name || name === ")" || name === "else" || name === "end") return { value: "", next: start };
  const arity = FUNCTION_ARITY[name];
  if (arity === undefined) return takeExpression(tokens, start, state);

  const values: TemplateValue[] = [];
  let next = start + 1;
  const expected = name === "and" || name === "or" ? Number.MAX_SAFE_INTEGER : arity;
  while (next < tokens.length && tokens[next] !== ")" && (!stopAtCloseParen || tokens[next] !== "else")) {
    const argument = takeExpression(tokens, next, state);
    if (argument.next === next) break;
    values.push(argument.value);
    next = argument.next;
    if (values.length >= expected) break;
  }
  if (name !== "and" && name !== "or" && name !== "joinstr" && values.length !== arity) {
    throw new Error(`\`${name}\` ${arity} argüman bekliyor.`);
  }
  return { value: callSafeFunction(name, values, state), next };
}

function callSafeFunction(name: string, values: TemplateValue[], state: EvalState): TemplateValue {
  const [a, b] = values;
  switch (name) {
    case "eq": return compareValues(a, b);
    case "ne": return !compareValues(a, b);
    case "gt": return Number(a) > Number(b);
    case "ge":
    case "gte": return Number(a) >= Number(b);
    case "lt": return Number(a) < Number(b);
    case "le":
    case "lte": return Number(a) <= Number(b);
    case "and": return values.every(truthy);
    case "or": return values.some(truthy);
    case "not": return !truthy(a);
    case "len": return Array.isArray(a) || typeof a === "string" ? a.length : 0;
    case "toint": return Number.isFinite(Number(a)) ? Math.trunc(Number(a)) : 0;
    case "tofloat": return Number.isFinite(Number(a)) ? Number(a) : 0;
    case "tostring": return asText(a);
    case "lower": return asText(a).toLocaleLowerCase("tr-TR");
    case "upper": return asText(a).toLocaleUpperCase("tr-TR");
    case "contains":
      return Array.isArray(a) ? a.some((item) => compareValues(item, b)) : asText(a).includes(asText(b));
    case "index": {
      const index = Number(b);
      return Array.isArray(a) && Number.isInteger(index) ? a[index] ?? "" : "";
    }
    case "joinstr": {
      const separator = asText(a);
      return values
        .slice(1)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map(asText)
        .join(separator);
    }
    case "hasroleid":
      return Boolean(state.message.member?.roles.cache.has(asText(a)));
    case "haspermission":
      return SAFE_PERMISSION_NAMES.has(asText(a))
        ? Boolean(state.message.member?.permissions.has(asText(a) as never))
        : false;
    case "userarg": {
      const raw = asText(a).replace(/^<@!?(\d+)>$/, "$1");
      if (raw === state.message.author.id) return raw;
      return state.message.mentions.users.has(raw) ? raw : "";
    }
    default:
      return "";
  }
}

function evaluateExpression(expression: string, state: EvalState): TemplateValue {
  const tokens = tokenizeExpression(expression);
  if (tokens.length === 0) return "";
  const result = parseExpression(tokens, 0, state);
  if (result.next < tokens.length && tokens[result.next] !== ")") {
    throw new Error("İfade sonunda beklenmeyen içerik var.");
  }
  return result.value;
}

function executeDirective(value: string, state: EvalState, actions: SafeAction[]): string {
  if (!value || value.startsWith("/*") || value.startsWith("//")) return "";
  const assignment = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*([\s\S]+)$/);
  if (assignment) {
    state.variables.set(assignment[1], evaluateExpression(assignment[2], state));
    return "";
  }

  const tokens = tokenizeExpression(value);
  const action = tokens[0]?.toLowerCase();
  const args: TemplateValue[] = [];
  let cursor = 1;
  while (cursor < tokens.length) {
    const evaluated = takeExpression(tokens, cursor, state);
    args.push(evaluated.value);
    cursor = evaluated.next;
  }
  if (args.length > SAFE_TEMPLATE_MAX_ARGUMENTS) throw new Error("Çok fazla şablon argümanı.");

  if (action === "sendmessage" || action === "senddm") {
    if (args.length !== 1) throw new Error(`${action} tek bir mesaj bekliyor.`);
    if (actions.length >= SAFE_TEMPLATE_MAX_ACTIONS) throw new Error("Şablon aksiyon sınırını aştı.");
    actions.push({ type: action === "senddm" ? "sendDM" : "sendMessage", content: clampLength(asText(args[0]), MAX_OUTPUT_LENGTH) });
    return "";
  }
  if (action === "deletetrigger") {
    if (actions.length >= SAFE_TEMPLATE_MAX_ACTIONS) throw new Error("Şablon aksiyon sınırını aştı.");
    actions.push({ type: "deleteTrigger" });
    return "";
  }
  if (action === "giveroleid" || action === "takeroleid") {
    if (args.length !== 2) throw new Error(`${action} kullanıcı ve rol ID'si bekliyor.`);
    const targetId = asText(args[0]);
    const roleId = asText(args[1]);
    if (!/^\d{15,25}$/.test(targetId) || !/^\d{15,25}$/.test(roleId)) {
      throw new Error("Rol aksiyonu yalnızca geçerli Discord ID'leriyle kullanılabilir.");
    }
    if (actions.length >= SAFE_TEMPLATE_MAX_ACTIONS) throw new Error("Şablon aksiyon sınırını aştı.");
    actions.push({ type: action === "giveroleid" ? "giveRole" : "takeRole", targetId, roleId });
    return "";
  }

  // Tanımsız çağrıları metne çevirmek yerine hata vermek typo kaynaklı
  // güvenlik/işlev hatalarını görünür kılar.
  const expression = evaluateExpression(value, state);
  return asText(expression);
}

function renderSafeNodes(nodes: TemplateNode[], state: EvalState, actions: SafeAction[]): string {
  let output = "";
  for (const node of nodes) {
    state.steps++;
    if (state.steps > SAFE_TEMPLATE_MAX_STEPS) throw new Error("Şablon işlem sınırını aştı.");
    if (node.kind === "text") {
      output += node.value;
    } else if (node.kind === "directive") {
      output += executeDirective(node.value, state, actions);
    } else {
      const condition = truthy(evaluateExpression(node.condition, state));
      output += renderSafeNodes(condition ? node.yes : node.no, state, actions);
    }
    if (output.length > MAX_OUTPUT_LENGTH * 4) output = output.slice(0, MAX_OUTPUT_LENGTH * 4);
  }
  return output;
}

function isCustomEventAllowed(event: CustomEvent, message: Message): boolean {
  const restrictions = event.restrictions;
  const roleIds = message.member?.roles.cache.map((role) => role.id) ?? [];
  if (restrictions.deniedRoleIds.some((id) => roleIds.includes(id))) return false;
  if (restrictions.allowedRoleIds.length > 0 && !restrictions.allowedRoleIds.some((id) => roleIds.includes(id))) return false;
  if (restrictions.deniedChannelIds.includes(message.channelId)) return false;
  if (restrictions.allowedChannelIds.length > 0 && !restrictions.allowedChannelIds.includes(message.channelId)) return false;
  if (restrictions.requiredPermission && !message.member?.permissions.has(restrictions.requiredPermission as never)) return false;
  return true;
}

const executionBuckets = new Map<string, { startedAt: number; count: number }>();
function isRateLimited(message: Message): boolean {
  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  if (executionBuckets.size > 10_000) {
    for (const [bucketKey, bucketValue] of executionBuckets) {
      if (now - bucketValue.startedAt >= 10_000) executionBuckets.delete(bucketKey);
    }
  }
  const bucket = executionBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= 10_000) {
    executionBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count++;
  return bucket.count > 5;
}

async function runSafeActions(actions: SafeAction[], message: Message): Promise<void> {
  for (const action of actions) {
    try {
      if (action.type === "sendMessage") {
        if (!(message.member?.permissions.has("ManageMessages") ?? false)) continue;
        if (!("send" in message.channel) || typeof message.channel.send !== "function") continue;
        await message.channel.send(v2Payload({ content: action.content, allowedMentions: { parse: [] } }));
        continue;
      }
      if (action.type === "sendDM") {
        await message.author.send(v2Payload({ content: action.content, allowedMentions: { parse: [] } }));
        continue;
      }
      if (action.type === "deleteTrigger") {
        const canDelete = message.member?.permissions.has("ManageMessages") ?? false;
        if (canDelete) await message.delete().catch(() => null);
        continue;
      }
      if (action.type === "giveRole" || action.type === "takeRole") {
        const executor = message.member;
        const target = message.guild
          ? await message.guild.members.fetch(action.targetId).catch(() => null)
          : null;
        const role = message.guild?.roles.cache.get(action.roleId) ?? null;
        const botMember = message.guild?.members.me ?? null;
        const explicitTarget = action.targetId === message.author.id || message.mentions.users.has(action.targetId);
        if (
          !executor ||
          !target ||
          !role ||
          !botMember ||
          !explicitTarget ||
          !executor.permissions.has("ManageRoles") ||
          !botMember.permissions.has("ManageRoles") ||
          target.id === message.guild?.ownerId ||
          botMember.roles.highest.position <= role.position ||
          botMember.roles.highest.position <= target.roles.highest.position
        ) {
          continue;
        }
        if (action.type === "giveRole") await target.roles.add(role).catch(() => null);
        else await target.roles.remove(role).catch(() => null);
      }
    } catch (error) {
      // Bir aksiyonun (özellikle kapalı DM'lerin) başarısız olması diğer güvenli
      // aksiyonları ve event'in ana yanıtını durdurmamalı.
      console.error("custom event patladı:", error);
    }
  }
}

/**
 * Yeni syntax: `{{if ...}}{{else}}{{end}}`, `$değişken := ...` ve whitelist
 * edilmiş aksiyonlar. Eski `{kullanıcı}` syntax'ı da geriye dönük çalışır.
 */
export async function executeCustomEvent(code: string, event: CustomEvent, ctx: RenderContext): Promise<SafeExecutionResult | RenderResult | null> {
  if (!event.enabled || !isCustomEventAllowed(event, ctx.message) || isRateLimited(ctx.message)) return null;
  if (!code.includes("{{")) {
    const legacy = renderCustomEvent(code, ctx);
    return legacy.kind === "text"
      ? { kind: "text", content: legacy.content, actions: [] }
      : legacy;
  }

  const parsed = parseTemplateNodes(templateTokens(code));
  if (parsed.stop) throw new Error("Şablon sonunda beklenmeyen blok etiketi var.");
  const state: EvalState = { message: ctx.message, args: ctx.args, variables: new Map(), steps: 0 };
  const actions: SafeAction[] = [];
  const content = clampLength(renderSafeNodes(parsed.nodes, state, actions).trim(), MAX_OUTPUT_LENGTH);
  await runSafeActions(actions, ctx.message);
  return { kind: "text", content: content || "\u200b", actions };
}
