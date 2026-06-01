# Web-Flasher

烙铁固件浏览器在线升级页面。基于 **Web Serial** 实现 CH32M030 USB-CDC IAP 协议，纯静态，
托管于 GitHub Pages。

线上地址（部署后）：<https://eddddddddy.github.io/Web-Flasher/>

## 使用前提

- 桌面版 **Chrome / Edge**（Safari、Firefox、iOS 不支持 Web Serial）
- 通过 `https://` 访问（GitHub Pages 默认满足）
- Windows 一般免驱（系统自带 CDC `usbser.sys`）

## 升级流程

1. 选择固件版本（默认自动加载最新固件，可用下拉框切换历史版本），或拖入自定义 `.bin`
2. 设备正常运行时点“连接并进入升级模式”，选普通串口 → 设备重启进 bootloader
3. 设备重新枚举后点“开始刷写”，再次选择设备端口 → 自动 擦除 / 写入 / CRC 校验 / 复位

> 第 ② 步后设备会作为新 USB 设备重新枚举，浏览器通常需在第 ③ 步再授权一次端口，属正常现象。
> 若设备支持开机长按按键直接进入 bootloader，可跳过第 ② 步。

## 部署

推送到 `main` 后，`.github/workflows/pages.yml` 会把仓库根目录发布为 Pages 站点。
首次需到 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。

## 固件版本管理

固件放在 `firmware/` 目录，清单 `firmware/manifest.json` 描述版本列表：

```json
{
  "versions": [
    { "version": "2026.06.01", "file": "firmware-2026.06.01.bin", "date": "2026-06-01", "notes": "..." }
  ]
}
```

- 数组**首项即最新版本**，页面加载时自动选中并加载它，其余作为历史版本供下拉选择。
- 发布新固件：把 `.bin` 放进 `firmware/`，在 `versions` 数组**开头**新增一条记录，提交推送即可。
- 用户也可忽略版本列表，直接拖入自有 `.bin`。

## 本地预览

```bash
python3 -m http.server 8000   # 访问 http://localhost:8000
```
