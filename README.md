# ESP32 Web Flasher（小智固件）

本项目是纯静态网页，部署到 GitHub Pages 后用桌面版 Chrome/Edge 的 Web Serial 操作 ESP32 ROM 下载协议。访问者不需要安装 ESP-IDF、espflash、Python、Node 或本地服务器。WebHID 不是这些芯片的 ROM 刷写接口，因此使用 Web Serial。页面运行时不依赖 CDN 或 WASM。

## 支持范围与使用

`catalog.json` 从 小智上游 `main/boards/**/config.json` 生成，包含 182 个构建选项；当前快照匹配 [官方 v2.5.0 发布](https://github.com/78/xiaozhi-esp32/releases/tag/v2.5.0)中的 180 个 ZIP。ESP32-S3 优先展示。Pages 构建会下载这 180 个公开 ZIP、核对官方 SHA-256，并作为同源静态文件发布（合计约 458 MiB）。选择板型后可直接在网页加载官方镜像；也可下载 ZIP、本机选择 ZIP，或选择自己构建的整机 `.bin`。网页不接收 OTA 应用镜像。

1. 核对实际硬件板型，在网页中选择对应构建选项。相同芯片的不同板型不可互换。
2. 将设备置于 ROM download mode，连接 USB 数据线。选择原生 USB Serial/JTAG 或板载 USB 转串口。网页与 ROM 握手后核对芯片型号、闪存容量。
3. 直接加载官方发布版，或选择官方 ZIP / 本机整机 `.bin`。网页检查官方 ZIP SHA-256、bootloader 偏移与芯片 ID、`0x8000` 分区表、应用描述符与项目名，显示镜像 SHA-256。确认覆盖后从 `0x0` 写入，并用设备返回的 MD5 校验。

网页目前支持 `esptool-js` 0.6.1 可识别的 ESP32、ESP32-S3、ESP32-C3、ESP32-C5、ESP32-C6 和 ESP32-P4。目录中 4 个 **ESP32-S31** 构建选项会显示，但连接和刷写已禁用：上游 [esptool-js #248](https://github.com/espressif/esptool-js/issues/248) 仍缺 S31 识别和刷写支持，会把它误判为 P4。不能把它计入已可刷写的板型。其他芯片只有静态镜像校验；实体刷写优先从 RLCD S3 验证，不能仅凭目录和代码认为所有设备都已验收。

写入合并镜像会覆盖其范围内原有数据，包括 NVS、分区表和应用。页面只托管上游公开发布包；不会上传私有固件，因为自行编译的镜像可能包含 Wi-Fi 密码与恢复令牌。

## 更新目录和部署

有 Python 3 的维护者可在上游发布新版后运行 `python3 update_catalog.py --boards-dir /path/to/xiaozhi-esp32/main/boards`，它从 GitHub Release API 和本地小智板级配置重新生成 `catalog.json`。运行时站点没有此依赖。

`.github/workflows/pages.yml` 在 GitHub Actions 中运行 `mirror_releases.py`，逐一核对官方 ZIP 的大小和 SHA-256 后上传 Pages artifact；无需 IDF 或本地构建。`main` 分支推送后触发，也可手动运行。部署地址以本仓库的 Pages 部署结果为准。Pages 提供 Web Serial 所需的 HTTPS 安全上下文。

第三方浏览器依赖固定在 `vendor/`：Espressif `esptool-js` 0.6.1（Apache-2.0）、`fflate` 0.8.2（MIT）、`spark-md5` 3.0.2（WTFPL）。更新时应核对 npm 包校验和并同步许可证。
