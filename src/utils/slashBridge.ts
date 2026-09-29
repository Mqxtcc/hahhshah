import { v2Payload } from "./messages.js";
/**
 * slashBridge — prefix komutları slash (/) olarak da kullanılabilir yapar.
 *
 * Felsefe: her komutun `execute(message, args)` mantığına DOKUNMADAN,
 * slash etkileşimini "mesaj benzeri" bir adapter ile aynı fonksiyona yönlendirir.
 * Böylece 50+ komut için mantık iki kez yazılmaz, davranış birebir aynı kalır.
 *
 * Kullanım (komut dosyasının en altı):
 * ```ts
 * import { addSlash } from "../utils/slashBridge.js";
 * addSlash(command, [
 *   { name: "kullanici", description: "Hedef kullanıcı", type: "user", required: true },
 *   { name: "sebep", description: "Sebep", type: "string" },
 * ]);
 * ```
 * Özel arg dizilimi gereken komutlar 3. parametre olarak map fonksiyonu verir.
 */
import {
  SlashCommandBuilder,
  Collection,
  type ChatInputCommandInteraction,
  type Message,
  type User,
  type GuildMember,
  type Role,
  type GuildTextBasedChannel,
  type Attachment,
  type Snowflake,
} from "discord.js";
import type { Command } from "../types.js";

// ---------------------------------------------------------------------------
// Seçenek tipleri
// ---------------------------------------------------------------------------

export type BridgeOptionType =
  | "string"
  | "integer"
  | "boolean"
  | "user"
  | "channel"
  | "role"
  | "mentionable"
  | "attachment";

export interface BridgeChoice {
  name: string;
  value: string;
}

export interface BridgeOption {
  name: string;
  description: string;
  type: BridgeOptionType;
  required?: boolean;
  choices?: BridgeChoice[];
  minValue?: number;
  maxValue?: number;
}

/** Slash etkileşiminden okunan değerlere tipli erişim. */
export interface SlashValues {
  str(name: string): string | undefined;
  int(name: string): number | undefined;
  bool(name: string): boolean | undefined;
  userMention(name: string): string | undefined;
  channelMention(name: string): string | undefined;
  roleMention(name: string): string | undefined;
  mentionableMention(name: string): string | undefined;
  attachmentUrl(name: string): string | undefined;
  has(name: string): boolean;
}

// ---------------------------------------------------------------------------
// İsim transliterasyonu (Discord slash adları için)
// ---------------------------------------------------------------------------

const TR_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  Ç: "c",
  Ğ: "g",
  İ: "i",
  Ö: "o",
  Ş: "s",
  Ü: "u",
};

/** "çiz" -> "ciz", "tekrarhoşgeldin" -> "tekrarhosgeldin" */
export function toSlashName(name: string): string {
  return name
    .toLocaleLowerCase("tr-TR")
    .split("")
    .map((ch) => TR_MAP[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9_-]/g, "");
}

// ---------------------------------------------------------------------------
// Prefix çözümleyici (content sentezi için)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prefix çözümleyici (content sentezi için)
// ---------------------------------------------------------------------------

/**
 * Sunucuya özel prefix'i döndüren fonksiyon. Döngüsel import'dan kaçınmak için
 * bot başlangıcında kaydedilir; kayıtlı değilse "!" varsayılır.
 */
let prefixResolver: ((guildId: string | null | undefined) => string) | null = null;

export function setSlashPrefixResolver(
  fn: (guildId: string | null | undefined) => string,
): void {
  prefixResolver = fn;
}

// ---------------------------------------------------------------------------
// Message adapter — interaction'ı prefix execute'unun beklediği şekle sokar
// ---------------------------------------------------------------------------

type ReplyOptions = Parameters<Message["reply"]>[0];

class SlashMessageAdapter {
  readonly author: User;
  readonly client: ChatInputCommandInteraction["client"];
  readonly createdTimestamp: number;
  readonly id: Snowflake;
  readonly guild: ChatInputCommandInteraction["guild"];
  readonly guildId: ChatInputCommandInteraction["guildId"];
  readonly channel: ChatInputCommandInteraction["channel"];
  readonly member: GuildMember | null;
  readonly mentions: {
    users: Collection<Snowflake, User>;
    members: Collection<Snowflake, GuildMember>;
    channels: Collection<Snowflake, GuildTextBasedChannel>;
    roles: Collection<Snowflake, Role>;
  };
  readonly attachments: Collection<Snowflake, Attachment>;
  /** prefix kodun okuduğu ham içerik — slash'te sentezlenir. */
  content = "";
  readonly reference = undefined;

  /** Sentezlenmiş komut içeriğini ata (extractRawRest kullanan komutlar için). */
  setContent(content: string): void {
    this.content = content;
  }

  private readonly interaction: ChatInputCommandInteraction;
  private replied = false;
  private replyMessage: Message | null = null;

  /** Komutun adapter üzerinden yanıt verip vermediği. */
  hasReplied(): boolean {
    return this.replied;
  }

  constructor(
    interaction: ChatInputCommandInteraction,
    member: GuildMember | null,
    mentions: SlashMessageAdapter["mentions"],
    attachments: Collection<Snowflake, Attachment>,
  ) {
    this.interaction = interaction;
    this.author = interaction.user;
    this.client = interaction.client;
    this.createdTimestamp = interaction.createdTimestamp;
    this.id = interaction.id;
    this.guild = interaction.guild;
    this.guildId = interaction.guildId;
    this.channel = interaction.channel;
    this.member = member;
    this.mentions = mentions;
    this.attachments = attachments;
  }

  /** İlk reply -> editReply (defer edildi), sonrakiler -> followUp. */
  async reply(options: ReplyOptions): Promise<Message> {
    if (!this.replied) {
      this.replied = true;
      const msg = (await this.interaction.editReply(v2Payload(
        options as Parameters<ChatInputCommandInteraction["editReply"]>[0],
      ))) as unknown as Message;
      this.replyMessage = msg;
      return msg;
    }
    const msg = (await this.interaction.followUp(v2Payload(
      options as Parameters<ChatInputCommandInteraction["followUp"]>[0],
    ))) as unknown as Message;
    return msg;
  }

  async delete(): Promise<void> {
    if (this.replyMessage) {
      await this.replyMessage.delete().catch(() => null);
      return;
    }
    await this.interaction.deleteReply().catch(() => null);
  }

  async fetchReference(): Promise<Message> {
    throw new Error("Slash modunda referans mesaj yok.");
  }
}

// ---------------------------------------------------------------------------
// Değer okuma + arg kurma
// ---------------------------------------------------------------------------

function readValues(
  interaction: ChatInputCommandInteraction,
  options: BridgeOption[],
): SlashValues {
  const o = interaction.options;
  const str = (n: string) => o.getString(n) ?? undefined;
  const int = (n: string) => o.getInteger(n) ?? undefined;
  const bool = (n: string) => o.getBoolean(n) ?? undefined;
  const has = (n: string) => {
    try {
      return o.get(n) != null;
    } catch {
      return false;
    }
  };
  return {
    str,
    int,
    bool,
    has,
    userMention: (n: string) => {
      const u = o.getUser(n);
      return u ? `<@${u.id}>` : undefined;
    },
    channelMention: (n: string) => {
      const c = o.getChannel(n);
      return c ? `<#${c.id}>` : undefined;
    },
    roleMention: (n: string) => {
      const r = o.getRole(n);
      return r ? `<@&${r.id}>` : undefined;
    },
    mentionableMention: (n: string) => {
      const m = o.getMentionable(n) as unknown as
        | (User & { id: string })
        | (Role & { id: string })
        | null;
      if (!m) return undefined;
      // Role nesnesinde `color` vardır; kullanıcı/üye yoktur.
      return "color" in m ? `<@&${m.id}>` : `<@${m.id}>`;
    },
    attachmentUrl: (n: string) => o.getAttachment(n)?.url,
  };
}

/** Varsayılan eşleme: seçenekler sırayla prefix arg'larına dönüşür. */
function defaultMap(values: SlashValues, options: BridgeOption[]): string[] {
  const args: string[] = [];
  for (const opt of options) {
    let v: string | number | boolean | undefined;
    switch (opt.type) {
      case "user":
        v = values.userMention(opt.name);
        break;
      case "channel":
        v = values.channelMention(opt.name);
        break;
      case "role":
        v = values.roleMention(opt.name);
        break;
      case "mentionable":
        v = values.mentionableMention(opt.name);
        break;
      case "attachment":
        v = values.attachmentUrl(opt.name);
        break;
      case "integer":
        v = values.int(opt.name);
        break;
      case "boolean":
        v = values.bool(opt.name);
        break;
      default:
        v = values.str(opt.name);
        break;
    }
    if (v !== undefined) args.push(String(v));
  }
  return args;
}

// ---------------------------------------------------------------------------
// Ana giriş: addSlash
// ---------------------------------------------------------------------------

/**
 * Bir prefix komuta slash karşılığı ekler. `command.execute`'u aynen kullanır;
 * owner-only komutlara ÇAĞRILMAMALIDIR (kullanıcı talimatı).
 */
export function addSlash(
  command: Command,
  options: BridgeOption[] = [],
  map?: (values: SlashValues) => string[],
): void {
  const slashName = toSlashName(command.name);
  if (!slashName) return;

  const builder = new SlashCommandBuilder()
    .setName(slashName)
    .setDescription(command.description.slice(0, 100) || command.name);

  for (const opt of options) {
    const desc = opt.description.slice(0, 100) || opt.name;
    switch (opt.type) {
      case "string":
        builder.addStringOption((b) => {
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required);
          if (opt.choices) {
            for (const c of opt.choices.slice(0, 25)) b.addChoices({ name: c.name.slice(0, 100), value: c.value });
          }
          return b;
        });
        break;
      case "integer":
        builder.addIntegerOption((b) => {
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required);
          if (opt.minValue !== undefined) b.setMinValue(opt.minValue);
          if (opt.maxValue !== undefined) b.setMaxValue(opt.maxValue);
          return b;
        });
        break;
      case "boolean":
        builder.addBooleanOption((b) =>
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required),
        );
        break;
      case "user":
        builder.addUserOption((b) =>
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required),
        );
        break;
      case "channel":
        builder.addChannelOption((b) =>
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required),
        );
        break;
      case "role":
        builder.addRoleOption((b) =>
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required),
        );
        break;
      case "mentionable":
        builder.addMentionableOption((b) =>
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required),
        );
        break;
      case "attachment":
        builder.addAttachmentOption((b) =>
          b.setName(opt.name).setDescription(desc).setRequired(!!opt.required),
        );
        break;
    }
  }

  command.slashName = slashName;
  command.slashData = builder;

  command.slashExecute = async (interaction: ChatInputCommandInteraction) => {
    // Ağır komutlar (AI vb.) 3 sn sınırına takılmasın diye önce defer.
    await interaction.deferReply();

    const values = readValues(interaction, options);
    const args = map ? map(values) : defaultMap(values, options);

    // mentions koleksiyonlarını slash seçeneklerinden doldur
    const users = new Collection<Snowflake, User>();
    const members = new Collection<Snowflake, GuildMember>();
    const channels = new Collection<Snowflake, GuildTextBasedChannel>();
    const roles = new Collection<Snowflake, Role>();
    const attachments = new Collection<Snowflake, Attachment>();
    for (const opt of options) {
      if (opt.type === "user") {
        const u = interaction.options.getUser(opt.name);
        if (u) {
          users.set(u.id, u);
          const m = interaction.options.getMember(opt.name);
          if (m && typeof m === "object" && "id" in m) {
            members.set((m as GuildMember).id, m as GuildMember);
          }
        }
      } else if (opt.type === "channel") {
        const c = interaction.options.getChannel(opt.name);
        if (c) channels.set(c.id, c as GuildTextBasedChannel);
      } else if (opt.type === "role") {
        const r = interaction.options.getRole(opt.name);
        if (r) roles.set(r.id, r as Role);
      } else if (opt.type === "mentionable") {
        const m = interaction.options.getMentionable(opt.name) as unknown as
          | User
          | Role
          | null;
        if (m && "id" in m) {
          // Rol mü kullanıcı mı? Role'da `color`/`position` olur.
          if ("color" in m) roles.set((m as Role).id, m as Role);
          else users.set((m as User).id, m as User);
        }
      } else if (opt.type === "attachment") {
        const a = interaction.options.getAttachment(opt.name);
        if (a) attachments.set(a.id, a);
      }
    }

    // Gerçek GuildMember (permissions.has vb. için API tipi yetmez)
    let member: GuildMember | null = null;
    if (interaction.guild) {
      member =
        interaction.guild.members.cache.get(interaction.user.id) ??
        (await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null));
    }

    const adapter = new SlashMessageAdapter(
      interaction,
      member,
      { users, members, channels, roles },
      attachments,
    );
    // extractRawRest(message.content, ...) kullanan komutlar (duyuru, say,
    // hosgeldin, customevent) için gerçekçi bir içerik sentezle.
    const prefix = prefixResolver?.(interaction.guildId) ?? "!";
    adapter.setContent(
      `${prefix}${command.name}${args.length > 0 ? " " : ""}${args.join(" ")}`,
    );
    await command.execute(adapter as unknown as Message, args);
    // Komut hiç yanıt vermediyse (prefix'teki sessiz early-return gibi),
    // "düşünüyor..." göstergesini kaldır ki takılı kalmasın.
    if (!adapter.hasReplied()) {
      await interaction.deleteReply().catch(() => null);
    }
  };
}
