import {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import type { Command } from "../types.js";
import { readyEvent } from "../events/ready.js";
import {
  initializePersistentState,
  messageCreateEvent,
} from "../events/messageCreate.js";
import { interactionCreateEvent } from "../events/interactionCreate.js";
import { registerLoggingEvents } from "../events/loggingEvents.js";
import { registerWelcomeEvents } from "../events/welcome.js";
import { registerGuildCreateEvents } from "../events/guildCreate.js";
import { registerGuildDeleteEvents } from "../events/guildDelete.js";
import { registerGuardEvents } from "../utils/guard.js";
import { registerRoleMenuReactionEvents } from "../rolemenu/reactions.js";
import { registerSnipeEvents } from "../snipe/store.js";
import { registerCounterEvents } from "../events/counter.js";
import { reportPendingChangelog } from "../utils/changelog.js";
import { handleAutoModMessage } from "../automod/automod.js";
import { deploySlashCommands } from "../deploy.js";
import {
  applyComponentsV2MentionPolicy,
  isRecordPayload,
} from "../utils/componentsV2Mentions.js";

function installComponentsV2MentionPolicy(client: Client): void {
  const request = client.rest.request.bind(client.rest);
  client.rest.request = (options) => {
    if (!isRecordPayload(options.body)) return request(options);
    return request({
      ...options,
      body: applyComponentsV2MentionPolicy(options.body),
    });
  };
}

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
  // Keep the client default untouched: only serialized V2 payloads receive
  // the no-ping policy, so non-V2 responses retain their existing behavior.
  installComponentsV2MentionPolicy(client);
  return client;
}

interface BotEventOptions {
  token: string;
  commands: Collection<string, Command>;
  slashCommands: readonly Command[];
}

function registerMessageEvents(
  client: Client,
  commands: Collection<string, Command>,
): void {
  client.on("messageCreate", (message) => {
    void (async () => {
      const handled = await handleAutoModMessage(message, "create").catch((error: unknown) => {
        console.error("otomod patladı:", error);
        return false;
      });
      if (handled) return;
      await messageCreateEvent(message, commands);
    })().catch((error: unknown) => {
      console.error("mesaj işlenirken patladı:", error);
    });
  });

  // Mesaj düzenlemeleri messageCreate'ten geçmez. Bu ayrı dinleyici olmadan
  // kullanıcı önce masum bir nokta gönderip sonra küfürlü içeriğe edit ederek
  // tüm kelime filtresini bypass edebiliyordu.
  client.on("messageUpdate", (before, after) => {
    void (async () => {
      const message = after.partial ? await after.fetch().catch(() => null) : after;
      if (!message) return;
      await handleAutoModMessage(message, "edit");
    })().catch((error: unknown) => {
      console.error("düzenlenen mesajda otomod patladı:", error);
    });
  });
}

function registerInteractionEvents(
  client: Client,
  commands: Collection<string, Command>,
): void {
  client.on("interactionCreate", (interaction) => {
    void interactionCreateEvent(interaction, commands).catch((error: unknown) => {
      console.error("etkileşim patladı:", error);
    });
  });
}

export function registerDiscordEvents(
  client: Client,
  { token, commands, slashCommands }: BotEventOptions,
): void {
  client.once("clientReady", (readyClient) => {
    readyEvent(readyClient);

    void deploySlashCommands(token, [...slashCommands], readyClient.user.id).catch(
      (error: unknown) => {
        console.error(
          "slash dağıtım patladı:",
          error,
        );
      },
    );
    void reportPendingChangelog(readyClient).catch((error: unknown) => {
      console.error("restart raporu gitmedi:", error);
    });
  });

  registerMessageEvents(client, commands);
  registerInteractionEvents(client, commands);
  registerLoggingEvents(client);
  registerWelcomeEvents(client);
  registerGuildCreateEvents(client);
  registerGuildDeleteEvents(client);
  registerGuardEvents(client);
  registerRoleMenuReactionEvents(client);
  registerSnipeEvents(client);
  registerCounterEvents(client);

  client.on("error", (error) => {
    console.error("discord patladı:", error);
  });
}

export { initializePersistentState };
