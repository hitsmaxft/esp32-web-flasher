import { ESPLoader, Transport } from "./vendor/esptool-js-0.6.1.js";
import { CHIPS, extractFirmwareBinary, inspectFirmware, resolveFlashPlan, sha256 } from "./firmware.js";

const $ = (id) => document.getElementById(id);
const ui = {
  search: $("board-search"), board: $("board"), release: $("release-link"), online: $("online"), boardInfo: $("board-info"),
  file: $("firmware"), connect: $("connect"), flash: $("flash"), disconnect: $("disconnect"),
  agree: $("agree"), progress: $("progress"), status: $("status"), log: $("log"),
  image: $("image-info"), device: $("device-info"), support: $("support"),
  appTargetField: $("app-target-field"), appTarget: $("app-target"), address: $("address-info"),
};
let catalog = null;
let appOffsets = null;
let profile = null;
let firmware = null;
let port = null;
let transport = null;
let loader = null;
let connectedChip = null;
let flashBytes = null;
let busy = false;

function line(message) {
  const stamp = new Date().toLocaleTimeString();
  ui.log.textContent += `[${stamp}] ${message}\n`;
  if (ui.log.textContent.length > 32000) ui.log.textContent = ui.log.textContent.slice(-24000);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function status(message, kind = "idle") {
  ui.status.textContent = message;
  ui.status.dataset.kind = kind;
  line(message);
}

function updateButtons() {
  const supported = !!profile && !!CHIPS[profile.target];
  const matching = supported && connectedChip === CHIPS[profile.target].name;
  const plan = currentFlashPlan();
  ui.search.disabled = busy;
  ui.board.disabled = busy;
  ui.file.disabled = busy || !supported;
  ui.online.disabled = busy || !supported || !profile.asset;
  ui.connect.disabled = busy || !!loader || !supported || !("serial" in navigator);
  ui.appTarget.disabled = busy;
  ui.flash.disabled = busy || !loader || !matching || !plan ||
      plan.required > flashBytes || !ui.agree.checked;
  ui.disconnect.disabled = busy || !port;
}

function currentFlashPlan() {
  if (!firmware || !profile) return null;
  try {
    return resolveFlashPlan(firmware.metadata, appOffsets?.profiles?.[profile.id], Number(ui.appTarget.value));
  } catch { return null; }
}

function renderDestination() {
  ui.appTarget.replaceChildren();
  ui.appTargetField.hidden = !firmware || firmware.metadata.kind !== "app";
  ui.address.hidden = !firmware;
  if (!firmware) return;
  if (firmware.metadata.kind === "app") {
    const partitions = appOffsets?.profiles?.[profile.id] ?? [];
    for (const partition of partitions) {
      const option = document.createElement("option");
      option.value = String(partition.offset);
      option.textContent = `${partition.label} · 0x${partition.offset.toString(16)} · ${(partition.size / 1048576).toFixed(2)} MiB`;
      ui.appTarget.append(option);
    }
    const preferred = partitions.find((item) => item.label === "ota_0") ?? partitions[0];
    if (preferred) ui.appTarget.value = String(preferred.offset);
  }
  refreshDestination();
}

function refreshDestination() {
  if (!firmware) return;
  try {
    const plan = resolveFlashPlan(firmware.metadata, appOffsets?.profiles?.[profile.id], Number(ui.appTarget.value));
    if (firmware.metadata.kind === "app") {
      ui.address.textContent = `检测为纯应用镜像 · 写入 ${plan.partition.label}，起始地址 0x${plan.address.toString(16)}。` +
          "\nOTA 当前启动槽位无法从镜像判断；写入非当前槽位后，设备可能仍启动旧版本。";
    } else {
      ui.address.textContent = "检测为整机合并镜像 · 起始地址 0x0；将覆盖镜像范围内的 bootloader、分区表、应用和配置。";
    }
  } catch (error) {
    ui.address.textContent = `无法写入：${error.message}`;
  }
  updateButtons();
}

function renderBoards(selectedId) {
  const query = ui.search.value.trim().toLowerCase();
  const candidates = catalog.profiles.filter((item) =>
    `${item.id} ${item.board} ${item.target}`.toLowerCase().includes(query));
  ui.board.replaceChildren();
  for (const item of candidates) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.target.toUpperCase()} · ${item.id}${item.asset ? "" : " · 无公开包"}`;
    ui.board.append(option);
  }
  if (candidates.some((item) => item.id === selectedId)) ui.board.value = selectedId;
  profile = catalog.profiles.find((item) => item.id === ui.board.value) ?? null;
  renderProfile();
}

function renderProfile() {
  firmware = null;
  renderDestination();
  ui.file.value = "";
  ui.image.textContent = "尚未选择镜像";
  ui.progress.value = 0;
  ui.agree.checked = false;
  ui.release.removeAttribute("href");
  ui.release.hidden = true;
  ui.online.hidden = true;
  if (!profile) {
    ui.boardInfo.textContent = "没有匹配的板型";
  } else if (!CHIPS[profile.target]) {
    ui.boardInfo.textContent = `${profile.board} · ${profile.target}。当前 esptool-js 不支持该芯片；已禁用连接和刷写。`;
  } else {
    ui.boardInfo.textContent = `${profile.board} · ${CHIPS[profile.target].name} · ${profile.asset ? `${catalog.release} 有公开发布包` : "暂无公开发布包，可选择本机镜像"}`;
    if (profile.asset) {
      ui.release.href = profile.asset;
      ui.release.hidden = false;
      ui.online.hidden = false;
    }
  }
  updateButtons();
}

async function closePort() {
  const active = transport;
  loader = null;
  transport = null;
  port = null;
  connectedChip = null;
  flashBytes = null;
  if (active) await active.disconnect();
  ui.device.textContent = "未连接设备";
  updateButtons();
}

const terminal = {
  clean() {},
  write(message) { if (message.trim()) line(message.trim()); },
  writeLine(message) {
    if (message.startsWith("Writing at 0x")) return;
    line(message);
  },
};

ui.search.addEventListener("input", () => { if (catalog) renderBoards(profile?.id); });
ui.board.addEventListener("change", () => {
  profile = catalog.profiles.find((item) => item.id === ui.board.value) ?? null;
  renderProfile();
});

async function loadImage(input, filename, selectedProfile) {
  if (selectedProfile.mirror && filename === selectedProfile.mirror) {
    const zipHash = await sha256(input);
    if (zipHash !== selectedProfile.sha256) throw new Error("官方发布 ZIP 的 SHA-256 与目录不符");
  }
  const extracted = extractFirmwareBinary(input, filename, selectedProfile);
  const metadata = inspectFirmware(extracted.bytes, selectedProfile.target, selectedProfile.name);
  if (metadata.kind === "app" && !appOffsets?.profiles?.[selectedProfile.id]?.length) {
    throw new Error("该板型没有可核对的官方应用分区偏移；不能刷写纯应用镜像");
  }
  const hash = await sha256(extracted.bytes);
  firmware = { bytes: extracted.bytes, hash, metadata, name: filename, source: extracted.source };
  renderDestination();
  ui.image.textContent = `${filename} · ${metadata.kind === "app" ? "纯应用" : "整机合并"} · ${metadata.chip} · ${metadata.version} · ${(metadata.size / 1048576).toFixed(2)} MiB\nSHA-256 ${hash}`;
  status(`镜像已在浏览器本地校验${extracted.source === "local-bin" ? "；请再次确认本机镜像的板型" : "；发布包与所选板型匹配"}`, "ready");
}

ui.file.addEventListener("change", async () => {
  firmware = null;
  renderDestination();
  ui.image.textContent = "尚未选择镜像";
  ui.progress.value = 0;
  updateButtons();
  const file = ui.file.files?.[0];
  if (!file || !profile) return;
  if (file.size > 64 * 1024 * 1024) {
    status("文件超过 64 MB 限制", "error");
    return;
  }
  busy = true;
  updateButtons();
  try {
    await loadImage(new Uint8Array(await file.arrayBuffer()), file.name, profile);
  } catch (error) {
    status(`镜像校验失败：${error.message}`, "error");
  } finally {
    busy = false;
    updateButtons();
  }
});

ui.online.addEventListener("click", async () => {
  if (!profile?.mirror || busy) return;
  const selectedProfile = profile;
  firmware = null;
  renderDestination();
  ui.image.textContent = "正在加载官方发布镜像…";
  busy = true;
  updateButtons();
  try {
    status(`正在从本站加载 ${selectedProfile.mirror}…`, "working");
    const response = await fetch(`./firmware/${encodeURIComponent(selectedProfile.mirror)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}；可使用上方链接下载 ZIP 后本机选择`);
    const input = new Uint8Array(await response.arrayBuffer());
    if (input.length !== selectedProfile.bytes) throw new Error("官方发布 ZIP 大小与目录不符");
    await loadImage(input, selectedProfile.mirror, selectedProfile);
  } catch (error) {
    ui.image.textContent = "尚未选择镜像";
    status(`加载失败：${error.message}`, "error");
  } finally {
    busy = false;
    updateButtons();
  }
});

ui.connect.addEventListener("click", async () => {
  if (!profile || !CHIPS[profile.target]) return;
  busy = true;
  updateButtons();
  try {
    port = await navigator.serial.requestPort();
    const info = port.getInfo();
    line(`已选择串口：USB VID ${info.usbVendorId?.toString(16) ?? "未知"} / PID ${info.usbProductId?.toString(16) ?? "未知"}`);
    transport = new Transport(port, false);
    loader = new ESPLoader({ transport, baudrate: 115200, terminal, debugLogging: false });
    status("正在与 ROM 下载器握手…", "working");
    await loader.main("no_reset");
    connectedChip = loader.chip?.CHIP_NAME;
    if (connectedChip !== CHIPS[profile.target].name) {
      throw new Error(`设备是 ${connectedChip ?? "未知芯片"}，所选固件需要 ${CHIPS[profile.target].name}`);
    }
    const detected = await loader.detectFlashSize();
    const match = /^(\d+)(MB|KB)$/.exec(detected ?? "");
    if (!match) throw new Error(`无法可靠识别闪存容量：${detected ?? "未知"}`);
    flashBytes = Number(match[1]) * (match[2] === "MB" ? 1048576 : 1024);
    ui.device.textContent = `${connectedChip} · ${detected} flash · USB VID ${info.usbVendorId?.toString(16) ?? "未知"}`;
    status(`${connectedChip} 下载器已连接，闪存 ${detected}`, "ready");
  } catch (error) {
    status(`连接失败：${error.message}`, "error");
    try { await closePort(); } catch (closeError) { line(`端口关闭失败：${closeError.message}`); }
  } finally {
    busy = false;
    updateButtons();
  }
});

ui.flash.addEventListener("click", async () => {
  const plan = currentFlashPlan();
  if (!loader || !firmware || !profile || !ui.agree.checked || busy ||
      !plan || connectedChip !== CHIPS[profile.target]?.name || plan.required > flashBytes) return;
  const selected = firmware;
  busy = true;
  updateButtons();
  ui.progress.value = 0;
  try {
    status(`正在写入 ${profile.id} ${selected.metadata.kind === "app" ? "应用" : "整机"}镜像到 0x${plan.address.toString(16)}；请保持供电和串口连接…`, "working");
    await loader.writeFlash({
      fileArray: [{ data: selected.bytes, address: plan.address }],
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false, compress: false,
      calculateMD5Hash: (image) => {
        const exact = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);
        return globalThis.SparkMD5.ArrayBuffer.hash(exact);
      },
      reportProgress: (_index, written, total) => { ui.progress.value = Math.round(100 * written / total); },
    });
    status(`刷写完成，设备返回的 MD5 已通过；镜像 SHA-256 ${selected.hash}`, "success");
  } catch (error) {
    status(`刷写未完成：${error.message}。请保持下载模式并重试。`, "error");
  } finally {
    busy = false;
    updateButtons();
  }
});

ui.disconnect.addEventListener("click", async () => {
  busy = true;
  updateButtons();
  try {
    await closePort();
    status("串口已断开；板卡仍可能停留在下载模式", "idle");
  } catch (error) {
    status(`断开失败：${error.message}`, "error");
  } finally {
    busy = false;
    updateButtons();
  }
});

ui.agree.addEventListener("change", updateButtons);
ui.appTarget.addEventListener("change", refreshDestination);
if (!("serial" in navigator) || !window.isSecureContext) {
  ui.support.textContent = "当前浏览器不支持安全上下文中的 Web Serial。请使用桌面版 Chrome 或 Edge 打开 HTTPS 页面。";
  ui.support.dataset.kind = "error";
} else {
  ui.support.textContent = "浏览器支持 Web Serial。请先将目标设备置于 ROM 下载模式。";
}
try {
  const response = await fetch("./catalog.json");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  catalog = await response.json();
  try {
    const offsetsResponse = await fetch("./app-offsets.json");
    if (!offsetsResponse.ok) throw new Error(`HTTP ${offsetsResponse.status}`);
    const loaded = await offsetsResponse.json();
    if (loaded.release !== catalog.release) throw new Error("应用分区表与固件目录版本不一致");
    appOffsets = loaded;
  } catch (error) {
    line(`应用分区偏移不可用：${error.message}；整机镜像仍可使用`);
  }
  const requested = new URLSearchParams(location.search).get("board");
  renderBoards(requested || "waveshare-esp32-s3-rlcd-4.2");
  status(`已加载 ${catalog.profiles.length} 个板型选项；公开发布版 ${catalog.release}`, "ready");
} catch (error) {
  status(`板型目录加载失败：${error.message}`, "error");
}
updateButtons();
