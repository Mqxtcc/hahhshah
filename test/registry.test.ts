import assert from "node:assert/strict";
import test from "node:test";
import { commandList, createCommandCollection } from "../src/commands/registry.js";
import type { Command } from "../src/types.js";

test("built-in command registry contains every registered command once", () => {
  assert.equal(commandList.length, 110);
  assert.equal(
    new Set(commandList.map((command) => command.name)).size,
    commandList.length,
  );

  const collection = createCommandCollection(commandList);
  assert.ok(collection.size >= commandList.length);

  for (const command of commandList) {
    assert.equal(collection.get(command.name), command);
    for (const alias of command.aliases ?? []) {
      assert.equal(collection.get(alias), command);
    }
  }
});

test("command registry rejects name and alias collisions", () => {
  const createCommand = (name: string, aliases?: string[]): Command => ({
    name,
    aliases,
    description: "test",
    usage: `!${name}`,
    category: "genel",
    execute: async () => undefined,
  });

  assert.throws(
    () =>
      createCommandCollection([
        createCommand("first", ["shared"]),
        createCommand("second", ["SHARED"]),
      ]),
    /Komut\/alias çakışması: shared/,
  );
});
