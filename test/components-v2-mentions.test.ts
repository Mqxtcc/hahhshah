import assert from "node:assert/strict";
import test from "node:test";
import { MessageFlags } from "discord.js";
import {
  applyComponentsV2MentionPolicy,
  componentsV2AllowedMentions,
} from "../src/utils/componentsV2Mentions.js";
import { v2Payload } from "../src/utils/messages.js";

test("v2Payload keeps explicit mention options, defaults to no-parse", () => {
  const payload = v2Payload({
    content: "<@123456789012345678>",
    allowedMentions: { parse: ["users"], repliedUser: true },
  });

  // Bilerek istenen ping korunur (örn. hoşgeldin mesajı).
  assert.deepEqual(payload.allowedMentions, { parse: ["users"], repliedUser: true });
  assert.equal(payload.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2);

  const stringPayload = v2Payload("<@123456789012345678>");
  assert.deepEqual(stringPayload.allowedMentions, componentsV2AllowedMentions());
  assert.deepEqual(stringPayload.allowedMentions, { parse: [] });
});

test("serialized V2 message bodies keep explicit API mention options", () => {
  const explicit = applyComponentsV2MentionPolicy({
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: { parse: ["users"], replied_user: true },
  });
  assert.deepEqual(explicit.allowed_mentions, { parse: ["users"], replied_user: true });

  // Explicit yoksa varsayılan: metindeki @ ping atmaz, reply pingi V1'deki gibi kalır.
  const def = applyComponentsV2MentionPolicy({
    flags: MessageFlags.IsComponentsV2,
    components: [],
  });
  assert.deepEqual(def.allowed_mentions, { parse: [] });
});

test("interaction callback V2 data is protected without changing non-V2 bodies", () => {
  const interactionBody = applyComponentsV2MentionPolicy({
    type: 4,
    data: {
      flags: MessageFlags.IsComponentsV2,
      allowed_mentions: { parse: ["roles"] },
    },
  });
  assert.deepEqual(interactionBody.data.allowed_mentions, { parse: ["roles"] });

  const interactionDefault = applyComponentsV2MentionPolicy({
    type: 4,
    data: { flags: MessageFlags.IsComponentsV2, components: [] },
  });
  assert.deepEqual(interactionDefault.data.allowed_mentions, { parse: [] });

  const nonV2Body = {
    flags: 0,
    allowed_mentions: { parse: ["users"], replied_user: true },
  };
  assert.strictEqual(applyComponentsV2MentionPolicy(nonV2Body), nonV2Body);
});
