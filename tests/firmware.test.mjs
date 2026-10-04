import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zipSync } from "../vendor/fflate-0.8.2.js";
import { CHIPS, extractMergedBinary, inspectFirmware } from "../firmware.js";

const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url)));

function image(target, project = "xiaozhi") {
  const bytes = new Uint8Array(0x30000).fill(0xff);
  const view = new DataView(bytes.buffer);
  const chip = CHIPS[target];
  bytes[chip.boot] = 0xe9;
  view.setUint16(chip.boot + 12, chip.id, true);
  view.setUint16(0x8000, 0x50aa, true);
  bytes[0x8002] = 0;
  bytes[0x8003] = 0;
  view.setUint32(0x8004, 0x10000, true);
  view.setUint32(0x8008, 0x20000, true);
  bytes.set(new TextEncoder().encode("factory\0"), 0x800c);
  bytes[0x10000] = 0xe9;
  view.setUint16(0x1000c, chip.id, true);
  view.setUint32(0x10020, 0xabcd5432, true);
  bytes.set(new TextEncoder().encode("2.5.0\0"), 0x10030);
  bytes.set(new TextEncoder().encode(project + "\0"), 0x10050);
  bytes.set(new TextEncoder().encode("esp32-s3-rlcd-4.2\0"), 0x20000);
  return bytes;
}

test("catalog covers every variant with unique identifiers and S3 first", () => {
  assert.equal(catalog.profiles.length, 182);
  assert.equal(new Set(catalog.profiles.map((p) => p.id)).size, catalog.profiles.length);
  assert.equal(catalog.profiles[0].target, "esp32s3");
  assert.ok(catalog.profiles.some((p) => p.id === "waveshare-esp32-s3-rlcd-4.2"));
});

test("all currently supported chip families accept their own merged image", () => {
  for (const target of Object.keys(CHIPS)) {
    assert.equal(inspectFirmware(image(target), target, "other").chip, CHIPS[target].name);
  }
});

test("reject wrong chip, non-XiaoZhi image, and unsupported S31", () => {
  assert.throws(() => inspectFirmware(image("esp32c3"), "esp32s3", "other"), /bootloader/);
  assert.throws(() => inspectFirmware(image("esp32s3", "other"), "esp32s3", "other"), /xiaozhi/);
  assert.throws(() => inspectFirmware(image("esp32s3"), "esp32s31", "other"), /不支持/);
});

test("release ZIP must match the selected board and contain merged-binary.bin", () => {
  const profile = catalog.profiles.find((p) => p.id === "waveshare-esp32-s3-rlcd-4.2");
  const zip = zipSync({ "merged-binary.bin": image("esp32s3") });
  assert.equal(extractMergedBinary(zip, "v2.5.0_waveshare-esp32-s3-rlcd-4.2.zip", profile).bytes.length, 0x30000);
  assert.throws(() => extractMergedBinary(zip, "v2.5.0_other.zip", profile), /板型/);
});
