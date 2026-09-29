import assert from "node:assert/strict";
import test from "node:test";
import { V2CardBuilder } from "../src/utils/componentsV2.js";
import {
  errorEmbed,
  permissionErrorEmbed,
  warningEmbed,
} from "../src/utils/embeds.js";

test("V2 card preserves EmbedBuilder author avatar and URL", () => {
  const card = new V2CardBuilder()
    .setAuthor({
      name: "Audit actor",
      iconURL: "https://cdn.example.com/avatar.png",
      url: "https://example.com/profile",
    })
    .setTitle("Action");

  const serialized = JSON.stringify(card.toJSON());
  assert.ok(serialized.includes("Audit actor"));
  assert.ok(serialized.includes("https://cdn.example.com/avatar.png"));
  assert.ok(serialized.includes("https://example.com/profile"));
});

test("V2 card preserves EmbedBuilder footer icon", () => {
  const card = new V2CardBuilder().setFooter({
    text: "Requested by a user",
    iconURL: "https://cdn.example.com/footer.png",
  });

  const serialized = JSON.stringify(card.toJSON());
  assert.ok(serialized.includes("Requested by a user"));
  assert.ok(serialized.includes("https://cdn.example.com/footer.png"));
});

test("error and warning helpers preserve their branded footer and timestamp", () => {
  const error = JSON.stringify(errorEmbed("Error", "Details").toJSON());
  const warning = JSON.stringify(warningEmbed("Warning", "Details").toJSON());

  assert.ok(error.includes("-# "));
  assert.ok(error.includes("<t:"));
  assert.ok(warning.includes("-# "));
  assert.ok(warning.includes("<t:"));
});

test("permission errors preserve the bot avatar and specialized footer", () => {
  const serialized = JSON.stringify(
    permissionErrorEmbed("Missing permission", "https://cdn.example.com/bot.png").toJSON(),
  );

  assert.ok(serialized.includes("https://cdn.example.com/bot.png"));
  assert.ok(serialized.includes("Yetki Hatası"));
  assert.ok(serialized.includes("<t:"));
});
