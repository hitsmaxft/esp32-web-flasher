import { unzipSync } from "./vendor/fflate-0.8.2.js";

export const CHIPS = Object.freeze({
  esp32: { name: "ESP32", id: 0, boot: 0x1000 },
  esp32s3: { name: "ESP32-S3", id: 9, boot: 0 },
  esp32c3: { name: "ESP32-C3", id: 5, boot: 0 },
  esp32c6: { name: "ESP32-C6", id: 13, boot: 0 },
  esp32p4: { name: "ESP32-P4", id: 18, boot: 0x2000 },
  esp32c5: { name: "ESP32-C5", id: 23, boot: 0x2000 },
});

function readCString(bytes, offset, length) {
  const end = bytes.indexOf(0, offset);
  if (end < offset || end >= offset + length) throw new Error("镜像元数据缺少结束符");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
}

function hasBytes(bytes, needle) {
  const first = needle[0];
  for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== first) continue;
    let j = 1;
    while (j < needle.length && bytes[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

export function extractFirmwareBinary(input, filename, profile) {
  if (!(input instanceof Uint8Array)) throw new Error("需要二进制文件");
  if (/\.bin$/i.test(filename)) return { bytes: input, source: "local-bin" };
  if (!/\.zip$/i.test(filename)) throw new Error("请选择小智发布版 ZIP 或 .bin 镜像");
  if (input.length > 64 * 1024 * 1024) throw new Error("ZIP 体积超过 64 MB 限制");
  if (!/^v\d+\.\d+\.\d+_[a-z0-9.-]+\.zip$/.test(filename) ||
      !filename.endsWith(`_${profile.id}.zip`)) {
    throw new Error(`发布包文件名与当前板型 ${profile.id} 不符`);
  }
  const entries = unzipSync(input, {
    filter: ({ name, originalSize }) => name === "merged-binary.bin" && originalSize <= 32 * 1024 * 1024,
  });
  const bytes = entries["merged-binary.bin"];
  if (!bytes) throw new Error("ZIP 中没有大小合适的 merged-binary.bin");
  return { bytes, source: "release-zip" };
}

function inspectApp(bytes, offset, chip, profileName) {
  if (offset + 0x100 > bytes.length || bytes[offset] !== 0xe9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(offset + 12, true) !== chip.id ||
      view.getUint32(offset + 0x20, true) !== 0xabcd5432) return null;
  const version = readCString(bytes, offset + 0x30, 32);
  const project = readCString(bytes, offset + 0x50, 32);
  if (project !== "xiaozhi") throw new Error("应用项目名不是 xiaozhi");
  if (profileName === "esp32-s3-rlcd-4.2" &&
      !hasBytes(bytes, new TextEncoder().encode("esp32-s3-rlcd-4.2"))) {
    throw new Error("所选 RLCD 镜像缺少板型标记");
  }
  return { version, project };
}

export function inspectFirmware(bytes, target, profileName) {
  const chip = CHIPS[target];
  if (!chip) throw new Error(`当前网页刷写库不支持 ${target}`);
  if (!(bytes instanceof Uint8Array) || bytes.length < 0x100 || bytes.length > 32 * 1024 * 1024) {
    throw new Error("镜像大小异常");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const app = inspectApp(bytes, 0, chip, profileName);
  if (app) return { kind: "app", size: bytes.length, chip: chip.name, ...app };
  if (bytes.length < 0x11000) throw new Error("未识别到完整应用镜像或整机合并镜像");
  if (bytes[chip.boot] !== 0xe9 || view.getUint16(chip.boot + 12, true) !== chip.id) {
    throw new Error(`镜像 bootloader 不是预期的 ${chip.name} 整机镜像`);
  }
  let appOffset = null;
  let flashRequired = bytes.length;
  for (let offset = 0x8000; offset < 0x8c00; offset += 32) {
    if (view.getUint16(offset, true) !== 0x50aa) break;
    const type = bytes[offset + 2];
    const subtype = bytes[offset + 3];
    const address = view.getUint32(offset + 4, true);
    const size = view.getUint32(offset + 8, true);
    if (!size || address + size > 32 * 1024 * 1024) throw new Error("分区表含异常闪存范围");
    flashRequired = Math.max(flashRequired, address + size);
    if (type === 0 && (subtype === 0 || subtype === 0x10) && appOffset === null) appOffset = address;
  }
  if (appOffset === null || appOffset + 0x100 > bytes.length) throw new Error("未在 0x8000 分区表找到应用镜像");
  const mergedApp = inspectApp(bytes, appOffset, chip, profileName);
  if (!mergedApp) {
    throw new Error("应用镜像头、芯片 ID 或描述符无效");
  }
  return { kind: "merged", size: bytes.length, chip: chip.name, appOffset,
    flashRequired, ...mergedApp };
}

export function resolveFlashPlan(metadata, partitions, selectedOffset) {
  if (metadata.kind === "merged") return { address: 0, required: metadata.flashRequired };
  if (metadata.kind !== "app" || !Array.isArray(partitions)) {
    throw new Error("缺少该板型官方发布镜像的应用分区信息");
  }
  const partition = partitions.find((item) => item.offset === selectedOffset &&
      Number.isSafeInteger(item.size) && Number.isSafeInteger(item.offset) &&
      item.offset >= 0x10000 && item.offset % 0x1000 === 0 && item.size > 0);
  if (!partition) throw new Error("所选应用偏移不在该板型官方分区表中");
  if (metadata.size > partition.size) throw new Error(`应用镜像超过 ${partition.label} 分区容量`);
  return { address: partition.offset, required: partition.offset + metadata.size, partition };
}

export async function sha256(bytes) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
