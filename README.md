# Web-Flasher

烙铁固件浏览器在线升级页面。基于 **Web Serial** 实现 CH32M030 USB-CDC IAP 协议，纯静态，
托管于 GitHub Pages。

线上地址（部署后）：<https://eddddddddy.github.io/Web-Flasher/>

## 使用前提

- 桌面版 **Chrome / Edge**（Safari、Firefox、iOS 不支持 Web Serial）
- 通过 `https://` 访问（GitHub Pages 默认满足）
- Windows 一般免驱（系统自带 CDC `usbser.sys`）

## 升级流程

1. 选择固件 `.bin`（或“使用最新内置固件”，若仓库根目录附带了 `firmware.bin`）
2. 设备正常运行时点“连接并进入升级模式”，选普通串口 → 设备重启进 bootloader
3. 设备重新枚举后点“开始刷写”，再次选择设备端口 → 自动 擦除 / 写入 / CRC 校验 / 复位

> 第 ② 步后设备会作为新 USB 设备重新枚举，浏览器通常需在第 ③ 步再授权一次端口，属正常现象。
> 若设备支持开机长按按键直接进入 bootloader，可跳过第 ② 步。

## 部署

推送到 `main` 后，`.github/workflows/pages.yml` 会自动把仓库根目录发布为 Pages 站点
（workflow 中 `enablement: true` 会自动开启 Pages）。若未自动生效，到
**Settings → Pages → Source** 选 **GitHub Actions**。

更新固件：把新的 `firmware.bin` 放到仓库根目录提交即可，页面会自动检测并显示“使用内置固件”。

## 本地预览

```bash
python3 -m http.server 8000   # 访问 http://localhost:8000
```
