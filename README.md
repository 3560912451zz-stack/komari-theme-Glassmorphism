<div align="center">

# Komari Glassmorphism · 个人维护版

基于原版 Glassmorphism 主题持续修改，重点维护地球交互、节点地理标记、城市中文显示和日常监控体验。

[![Release](https://img.shields.io/github/v/release/3560912451zz-stack/komari-theme-Glassmorphism?style=flat-square&label=release&color=10b981)](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism/releases/latest)
[![Code Quality](https://img.shields.io/github/actions/workflow/status/3560912451zz-stack/komari-theme-Glassmorphism/quality.yml?branch=main&style=flat-square&label=quality)](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism/actions/workflows/quality.yml)
[![Visual Regression](https://img.shields.io/github/actions/workflow/status/3560912451zz-stack/komari-theme-Glassmorphism/visual-regression.yml?branch=main&style=flat-square&label=visual)](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism/actions/workflows/visual-regression.yml)

[下载最新版](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism/releases/latest) ·
[安装方法](#安装与更新) ·
[本分支改动](#本分支改动) ·
[上游与署名](#上游与署名)

</div>

## 项目说明

这是 `3560912451zz-stack/komari-theme-Glassmorphism` 的个人维护分支，不是原作者仓库的镜像。

本分支保留原主题的毛玻璃视觉和 Komari 监控能力，并围绕实际使用中遇到的问题继续开发。当前版本是 **v3.3.16**，发布包可直接导入 Komari。

| 项目 | 当前状态 |
| :--- | :--- |
| 维护仓库 | [3560912451zz-stack/komari-theme-Glassmorphism](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism) |
| 当前版本 | `v3.3.16` |
| 安装方式 | 仓库链接导入或 Release ZIP 上传 |
| 主要运行环境 | Komari 1.2.x 及兼容版本 |
| 前端技术 | Vue 3、Vite 7、Tailwind CSS 4、Bun |
| 原始项目 | [sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism) |

![主题预览](docs/preview.png)

## 本分支改动

### Tab 沉浸地球

- 在首页非输入控件上按 `Tab`，地球平滑移动到画面中央。
- 节点卡片、总览统计和左右工具栏沿统一时间线有序滑出屏幕。
- 再按一次 `Tab` 或按 `Esc`，所有内容带动画回到原位。
- 全屏与普通状态复用同一个地球渲染画布，避免退出时白闪、画面抽动或尺寸突变。
- 页面滚动条保持隐藏，切换状态时不会因为滚动条出现而造成整页横向跳动。

此交互只面向带键盘的桌面端。焦点位于输入框、按钮、链接等交互控件时，不会抢占原本的 `Tab` 行为。

### 节点地理标记

- 地球、点阵地球和平铺地图使用同一套节点地点聚合结果。
- 同一国家、同一城市的多台机器只显示一面旗帜；同国不同城市仍分别显示。
- 城市无法识别时保留节点自己的独立标记，不会退化成整个国家只显示一面旗帜。
- `v3.3.16` 已移除旗帜右上角的节点数量角标，恢复更干净的显示。
- 标记只根据当前可见节点生成。节点删除、隐藏、换 IP 或换地区后，旧标记不会继续残留。
- 节点配置国家与 IP 地理服务结果不一致时，优先相信节点配置，避免国旗漂移到错误国家。
- 私有 IP、保留 IP 和无效的 `0,0` 坐标不会用于地理定位。

### 城市中文与缓存

- 节点详情和列表可显示“城市 · 国家/地区”。
- 地理服务优先请求中文结果，缺少中文城市名时再调用 HTTPS 翻译服务。
- 管理员首次解析的新城市可写入 Komari 主题设置，普通访客直接复用服务器中的城市译名。
- 服务器只缓存“国家代码 + 城市原文 + 中文译名”，不缓存节点 IP、UUID 或地理坐标。
- IP 地理坐标不使用旧版 30 天浏览器缓存，因此删除机器不会留下旧旗帜。
- 翻译失败时显示服务商返回的原始地名，不阻塞节点、国旗和页面加载。
- 对容易被误译的专有地名保留原名，例如马恩岛的 `Middle`。

### 首页与详情页

- 卡片和列表两种节点视图，支持收藏、分组、搜索和快捷筛选。
- 首页搜索支持节点名、地区、IP、CPU 型号以及 IPv4 通配写法。
- 总览卡片支持基础、资源、运维、财务、流量、GPU、资产和自定义方案。
- 详情页支持节点切换、负载与 Ping 图表、地理位置、费用和剩余价值信息。
- 登录后可使用节点对比、健康摘要、拓扑、快照导出和访客审计等高级工具。
- 支持亮色、暗色、北京时间自动切换、自定义背景和色觉辅助配色。

## v3.3.16

本版只处理一个视觉决定：删除上一版加入的节点数量角标。

- Cobe 点阵地球不再显示数量角标。
- 写实贴图地球不再显示数量角标。
- 平铺地图不再显示数量角标。
- 同地点聚合逻辑保留，多台同城节点仍共用一面旗帜。
- 旗帜尺寸和在线/离线统计逻辑保持不变。

[查看 v3.3.16 Release](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism/releases/tag/v3.3.16)

## 安装与更新

### 使用仓库链接导入

在 Komari 后台的主题管理中填写：

```text
https://github.com/3560912451zz-stack/komari-theme-Glassmorphism
```

Komari 会读取该仓库的最新 Release。若导入后仍显示旧版，通常是浏览器或服务端主题缓存，重新导入后再强制刷新页面即可。

### 上传 Release ZIP

1. 打开 [Releases](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism/releases)。
2. 下载最新的 `komari-theme-Glassmorphism-build-<short-sha>.zip`。
3. 进入 Komari 后台的主题管理页面。
4. 上传 ZIP 并启用主题。

不要下载 GitHub 自动生成的 `Source code (zip)`，它是源码包，不是可直接导入的主题构建包。

## 配置提示

主题后台包含以下主要配置组：

- 基础与外观：主题模式、刷新间隔、RPC 连接模式、卡片密度。
- 首页布局：地球样式、访客信息、毛玻璃配色、自定义背景。
- 首页总览：统计卡片预设与自定义卡片顺序。
- 高级工具：拓扑、对比、健康、导出和访客审计入口。
- 节点列表：快捷筛选、元数据字段、离线置底和预警阈值。
- 节点详情：概览卡片、负载图表、GPU 指标和详情分页。

`Tab` 沉浸地球不需要额外配置。关闭页面动画或启用系统“减少动态效果”后，切换会减少或跳过动画。

## 本地开发

需要 Bun 1.2 或更高版本，以及 Node.js 20.19+ 或 22.12+。

```bash
bun install
bun run dev
```

使用本地假节点预览卡片和地球动画时，在被 Git 忽略的 `.env.development.local` 中写入：

```dotenv
VITE_MOCK_NODES=true
```

常用检查：

```bash
bun run type-check
bun run build
bun run test:visual
```

发布流程会在 `komari-theme.json` 版本变更后自动构建 Release ZIP。代码质量和视觉回归由 GitHub Actions 检查。

## 最近版本

| 版本 | 主要变化 |
| :--- | :--- |
| `v3.3.16` | 删除节点数量角标，保留同地点旗帜聚合 |
| `v3.3.15` | 为聚合地点试验节点数量角标，后在 v3.3.16 撤回 |
| `v3.3.14` | 城市中文译名写入 Komari 主题设置，供访客共享 |
| `v3.3.13` | 拒绝 Null Island `0,0` 结果并修正错误坐标回退 |
| `v3.3.12` | 修复管理员状态下隐藏节点和保留 IP 导致的国旗漂移 |
| `v3.3.11` | 城市自动翻译与地球退出动画连续性修复 |
| `v3.3.9` | 在节点详情页显示地理位置 |
| `v3.3.10` | 节点国家与地理结果严格校验，移除 30 天 IP 地理缓存 |
| `v3.3.8` | 同一国家、同一城市的节点聚合为一个地点标记 |
| `v3.3.4` | 加入 `Tab` 沉浸地球及卡片、工具栏协同动画 |

完整构建记录与下载请查看 [Releases](https://github.com/3560912451zz-stack/komari-theme-Glassmorphism/releases)。

## 上游与署名

本分支基于 [sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism) 继续开发。原作者署名保留在主题 manifest 中，本仓库链接和后续版本由 `3560912451zz-stack` 维护。

项目继续遵循仓库中的 [MIT License](LICENSE)。使用、修改或分发时请保留原项目版权和许可证信息。
