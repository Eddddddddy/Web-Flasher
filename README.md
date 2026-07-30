# SolderingPen Web Flasher

SolderingOS 的 SolderingPen 浏览器升级页面。它通过桌面 Chrome / Edge 的 Web Serial，
为 `pen_m030` 的 **production App-only** 固件执行 CH32M030 USB-CDC IAP 升级。

线上地址：<https://eddddddddy.github.io/Web-Flasher/>

## 支持范围

- 产品：`soldering-pen`
- 板型：`pen_m030`
- 构建档位：`production`
- App 分区：`0x00001800 + 0x0000E380`
- 写入块：128 B
- 最低 Bootloader：`0x0105`（IAP HELLO v2，带 product/board）

**公共仓库和 GitHub Pages 永远只发布 App-only 固件，不发布 `combined.bin`、factory
全片镜像或任何 64 KiB 组合镜像。** 发布校验会同时按文件名、镜像长度和内嵌 App
manifest 拒绝这些文件。网页发布清单也不会接受 Plate、diagnostic 或 thermal-lab 镜像。自定义
`.bin` 仍可用于开发，但同样必须通过内嵌 Pen production App manifest；用户只能确认
“该文件没有发布 SHA-256”，不能绕过产品身份检查。

## 安全升级流程

1. 页面下载 `firmware/manifest.json`，检查产品身份、布局和最低 Bootloader。
2. 页面解析固件固定偏移处的 App manifest，强制核对 product/board/profile；自定义文件也不能跳过。
3. 页面下载 App-only `.bin`，在浏览器内核对长度和 SHA-256，通过后才启用唯一的“连接设备并开始升级”按钮。
4. 用户点击主按钮并选择一次设备。网页先发送 HELLO：若设备已经在 IAP，直接继续；若当前是 App，网页自动发送 `iap` 并等待设备重启，无需用户单独点击“进入升级模式”。
5. 网页释放 App 串口后轮询 `navigator.serial.getPorts()`，等待设备重新枚举，并自动核对已有授权端口的 HELLO。
6. 若浏览器把原设备权限继承给 `Pen IAP`，网页自动开始核对和烧录；若权限未继承，同一个主按钮变为“选择升级设备并继续”，由用户再次选择 `Pen IAP`。
7. USB VID/PID、HELLO product/board、Bootloader 版本、镜像 App manifest 任一不匹配时，网页在擦除前停止。已返回但不兼容的 IAP HELLO 不会被误当成 App。
8. 执行擦除、128 B 分块写入和设备端 CRC 校验。
9. FINISH 携带补齐后的镜像长度与 CRC。Bootloader `0x0105+` 复核长度、CRC 和 App manifest product/board，只有全部验证成功才写 sentinel 并复位。

普通用户默认只看到最新正式固件、一个动态主按钮和升级进度。历史版本、自定义 `.bin` 与技术文件信息收在“高级选项”内，详细协议日志默认折叠。

网页收到 FINISH 的成功回复，只表示 Bootloader 已接受镜像和复位请求；App 是否完成启动仍需观察设备重新枚举/开机。

## 发布清单

`firmware/manifest.json` 使用 schema 2。schema 2 把数值 `productId/boardId/profileId`
纳入强制发布合同，旧 schema 1 不再被页面接受：

```json
{
  "schemaVersion": 2,
  "versions": [
    {
      "version": "3.0",
      "file": "solderingpen-v3.0-abcdef0.bin",
      "date": "2026-07-29",
      "notes": "SolderingPen production App-only firmware",
      "product": "soldering-pen",
      "board": "pen_m030",
      "profile": "production",
      "productId": 1,
      "boardId": 1,
      "profileId": 1,
      "size": 57192,
      "sha256": "64-hex-character SHA-256",
      "appBase": 6144,
      "appLength": 58240,
      "progBlock": 128,
      "minBootloader": 261,
      "sourceRevision": "firmware Git commit"
    }
  ]
}
```

数组首项是默认最新版。每个 `firmware/*.bin` 都必须在清单中列出，清单中的每个文件也必须通过大小和 SHA-256 检查。

### 添加历史正式版本

不要手工复制文件后再填写大小和 SHA-256。使用导入脚本完成内嵌身份、版本号、现有目录、
文件大小和 SHA-256 检查，并原子更新发布清单：

```bash
npm run add-release -- \
  --image /absolute/path/to/firmware.bin \
  --version 2.9 \
  --date 2026-07-01 \
  --source-revision abcdef0123456789abcdef0123456789abcdef01 \
  --notes "SolderingPen 2.9 production release"
```

脚本会把文件命名为 `firmware/solderingpen-v2.9-iap-v2.bin`，并按版本号从新到旧排列
`versions`。页面始终在“高级选项：其他固件”中显示“历史正式版本”选择框；即使清单
中只有一个候选版本也会显示。普通用户仍默认加载数组首项的最新版本。

正式写入前可以只验证、不修改任何文件：

```bash
npm run add-release -- \
  --image /absolute/path/to/firmware.bin \
  --version 2.9 \
  --date 2026-07-01 \
  --source-revision abcdef0123456789abcdef0123456789abcdef01 \
  --dry-run
```

导入后仍需执行 `npm test` 和 `npm run validate-release`。脚本只接受版本号与内嵌
`firmwareVersionCode` 一致的 Pen production App-only 固件；不兼容的旧镜像、重复版本、
重复文件和未登记 `.bin` 都会在修改清单前被拒绝。

## 本地验证

```bash
npm test
npm run validate-release
python3 -m http.server 8000
```

访问 <http://127.0.0.1:8000/>。Web Serial 必须在安全上下文中使用；`localhost`/`127.0.0.1`
可用于本地测试，GitHub Pages 使用 HTTPS。

## 部署

推送到 `main` 后，`.github/workflows/pages.yml` 会：

1. 运行协议单元测试；
2. 验证清单、发布文件大小、SHA-256 以及未登记的 `.bin`；
3. 只把 `index.html`、`iap.js`、`firmware.js` 和 `firmware/` 组装到 `_site`；
4. 将 `_site` 发布到 GitHub Pages。

因此测试代码、脚本和仓库元数据不会进入公开站点。
