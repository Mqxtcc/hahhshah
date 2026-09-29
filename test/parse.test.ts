import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRawRest,
  formatDuration,
  parseChannelMention,
  parseMention,
} from "../src/utils/parse.js";

test("parseMention kullanıcı mention ve ID değerlerini okur", () => {
  assert.equal(parseMention("<@123456789012345678>"), "123456789012345678");
  assert.equal(parseMention("<@!123456789012345678>"), "123456789012345678");
  assert.equal(parseMention("123456789012345678"), "123456789012345678");
  assert.equal(parseMention("@kullanici"), null);
  assert.equal(parseMention("123"), null);
});

test("parseChannelMention kanal mention ve ID değerlerini okur", () => {
  assert.equal(parseChannelMention("<#123456789012345678>"), "123456789012345678");
  assert.equal(parseChannelMention("123456789012345678"), "123456789012345678");
  assert.equal(parseChannelMention("<@123456789012345678>"), null);
});

test("extractRawRest biçimlendirmeyi ve satır sonlarını korur", () => {
  assert.equal(
    extractRawRest("!duyuru başlık\n\n**mesaj**\nüçüncü satır", 1, "!"),
    "başlık\n\n**mesaj**\nüçüncü satır",
  );
  assert.equal(extractRawRest("!komut", 1, "!"), null);
  assert.equal(extractRawRest("!komut   içerik   ", 1, "!"), "içerik");
});

test("formatDuration Türkçe süreleri doğru biçimlendirir", () => {
  assert.equal(formatDuration(15), "15 dakika");
  assert.equal(formatDuration(60), "1 saat");
  assert.equal(formatDuration(125), "2 saat");
  assert.equal(formatDuration(1440), "1 gün");
  assert.equal(formatDuration(2880), "2 gün");
});
