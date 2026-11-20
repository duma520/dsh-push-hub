/**
 * dsh-push-hub — 浏览器半身（设置界面）。
 *
 * 手写 ModuleLoader bundle：零构建、只依赖 shell 已提供的 'react'。
 *
 * 挂载两个位置：
 *   1. settings.section        —— 设置 → 左侧「推送中枢」
 *   2. plugins.bundle.config   —— 插件详情页配置区（官方按 props.view 区分摘要/整页）
 *
 * v0.9.0 界面（视觉照抄 @xmanrui/dsh-im 的设置面板，MIT）：
 *   左栏 174px 通道卡（方形 logo + 名称 + 账号数，选中浅蓝底蓝边框）；
 *   右栏「手动接入」主按钮 + 右上「N / N 运行正常」胶囊 + 机器人行卡；
 *   机器人行卡默认折叠，点右侧蓝色齿轮才展开表单（避免五套表单同时铺开）。
 *   v0.7.0 的平铺表单被主人实测评为「太丑」，本次彻底换掉。
 *
 * 边界（重要）：
 *  - 本插件是「主动推送」。收消息、被 @ 才回复属 dsh-im-connect 的职责，
 *    这里只在「来源与回落」里写清并给入口，不假装能做。
 *  - 不写 dsh-bridge 的 config.json（它是整表重写，会把本插件的配置冲掉）。
 *  - 凭据不回显：只以 <已配置 尾4位> 出现，回传掩码即表示不改。
 *  - CSS 内联在本文件里（ModuleLoader 只能 require 宿主给的模块，不能 import 相对路径），
 *    样式源与 lib/theme.js 保持同源，改动时两边一起改。
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: '@duma520/dsh-push-hub',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    /** 与 host 半身一致的路由前缀。 */
    const API = '/@duma520/dsh-push-hub/api'

    /** 样式注入用的唯一 id（防重复插入）。 */
    const THEME_ID = 'duma520-dsh-push-hub'

    const THEME_CSS = String.raw`
/* dsh-push-hub — 界面样式（对齐 @xmanrui/dsh-im 的视觉规范）
 * 全部类名带 dph- 前缀，避免和宿主或其它插件冲突。
 * 颜色一律走 var(--dsw-alias-*, 兜底值)，跟随宿主主题。
 */

.dph-root {
  --dph-blue: var(--dsw-alias-state-business-primary, #3370ff);
  --dph-blue-soft: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 12%, #fff);
  --dph-label-1: var(--dsw-alias-label-primary, #1f2329);
  --dph-label-2: var(--dsw-alias-label-secondary, #646a73);
  --dph-label-3: var(--dsw-alias-label-tertiary, #8f959e);
  --dph-border-1: var(--dsw-alias-border-l1, #eef0f3);
  --dph-border-2: var(--dsw-alias-border-l2, #e5e6eb);
  --dph-bg-1: var(--dsw-alias-bg-layer-1, #fff);
  --dph-hover: var(--dsw-alias-interactive-bg-hover, #eef0f3);
  --dph-success: var(--dsw-alias-state-success-primary, #20a162);
  --dph-warn: var(--dsw-alias-state-warn-primary, #d97706);
  --dph-error: var(--dsw-alias-state-error-primary, #d54941);
  box-sizing: border-box;
  /* v0.26.1：宿主给的容器有定高，但本插件原先没声明高度与溢出，
     于是内容超出后被直接裁掉（工具区只到「扫码接入」，下面全看不见）。
     这里让根节点自己撑满并纵向滚动；父容器若没定高，height:100% 退化成
     auto，滚动交回外层，不会出现双滚动条。 */
  height: 100%;
  min-height: 0;
  /* 右侧留白交给 scrollbar-gutter，别再额外补 padding，否则双份空隙。 */
  padding: 2px 0 28px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  color: var(--dph-label-1);
  font-family: "HarmonyOS Sans SC", "Source Han Sans SC", "Noto Sans SC", "Alibaba PuHuiTi", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.55;
}
.dph-root *, .dph-root *::before, .dph-root *::after { box-sizing: border-box; }

/* ── 头部 ───────────────────────────────────────────────────────────── */
.dph-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 2px 0 12px; }
.dph-headMain { min-width: 0; }
.dph-title { margin: 0; font-size: 17px; line-height: 24px; font-weight: 650; letter-spacing: .01em; }
.dph-subtitle { margin: 4px 0 0; color: var(--dph-label-3); font-size: 12px; line-height: 18px; }
.dph-headTools { flex: none; display: flex; align-items: center; gap: 8px; }
.dph-iconBtn { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 1px solid var(--dph-border-2); border-radius: 8px; color: var(--dph-label-2); background: var(--dph-bg-1); font: inherit; cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
.dph-iconBtn:hover:not(:disabled) { border-color: #aeb3bb; color: var(--dph-label-1); background: #f7f8fa; }
.dph-iconBtn:disabled { opacity: .45; cursor: default; }
.dph-iconBtn svg { width: 16px; height: 16px; }
.dph-iconBtn[aria-current="page"] { border-color: color-mix(in srgb, var(--dph-blue) 42%, #dfe1e5); color: var(--dph-blue); background: var(--dph-blue-soft); }

/* ── 状态行 / 进度条 ────────────────────────────────────────────────── */
.dph-status { display: flex; align-items: center; gap: 10px; min-height: 20px; margin: 0 0 14px; color: var(--dph-label-3); font-size: 11.5px; }
.dph-statusText[data-tone="success"] { color: var(--dph-success); }
.dph-statusText[data-tone="error"] { color: var(--dph-error); }
.dph-statusText[data-tone="warn"] { color: var(--dph-warn); }
.dph-progress { flex: 1 1 auto; max-width: 200px; height: 3px; border-radius: 2px; background: var(--dph-border-1); overflow: hidden; }
.dph-progressFill { height: 100%; background: var(--dph-blue); transition: width .2s ease; }
.dph-banner { margin: 0 0 10px; padding: 8px 11px; border-radius: 9px; font-size: 12px; line-height: 18px; }
.dph-banner[data-tone="error"] { border: 1px solid color-mix(in srgb, var(--dph-error) 34%, #fff); background: color-mix(in srgb, var(--dph-error) 7%, #fff); color: var(--dph-error); }
.dph-banner[data-tone="success"] { border: 1px solid color-mix(in srgb, var(--dph-success) 34%, #fff); background: color-mix(in srgb, var(--dph-success) 7%, #fff); color: var(--dph-success); }
.dph-banner[data-tone="warn"] { border: 1px solid color-mix(in srgb, var(--dph-warn) 34%, #fff); background: color-mix(in srgb, var(--dph-warn) 7%, #fff); color: var(--dph-warn); }

/* ── 布局：左通道栏 + 分隔线 + 右面板 ───────────────────────────────── */
.dph-layout { display: grid; grid-template-columns: 174px 1px minmax(0, 1fr); gap: 24px; align-items: start; }
.dph-rail { display: grid; align-content: start; gap: 8px; padding: 0 4px 1px 1px; min-width: 0; }
.dph-railHead { padding: 5px 4px 1px; color: var(--dph-label-3); font-size: 11px; letter-spacing: .02em; }
.dph-railDivider { height: 1px; background: var(--dph-border-1); margin: 7px 2px 3px; }
.dph-divider { width: 1px; align-self: stretch; background: var(--dph-border-1); }
.dph-panel { min-width: 0; }
@media (max-width: 760px) {
  .dph-layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .dph-divider { display: none; }
  .dph-rail { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .dph-railHead, .dph-railDivider { grid-column: 1 / -1; }
}

/* ── 左栏通道卡 ─────────────────────────────────────────────────────── */
.dph-channel { width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dph-border-1); border-radius: 14px; background: var(--dph-bg-1); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color .16s, box-shadow .16s, background .16s; }
.dph-channel:hover { border-color: color-mix(in srgb, var(--dph-blue) 25%, var(--dph-border-1)); background: color-mix(in srgb, var(--dph-blue) 2%, var(--dph-bg-1)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dph-channel:focus-visible { outline: 2px solid var(--dph-blue); outline-offset: 2px; }
.dph-channel[aria-selected="true"] { border-color: color-mix(in srgb, var(--dph-blue) 43%, #dfe1e5); color: var(--dph-blue); background: color-mix(in srgb, var(--dph-blue) 12%, var(--dph-bg-1)); box-shadow: 0 3px 12px rgb(51 112 255 / 7%); }
.dph-channelCopy { min-width: 0; display: grid; }
.dph-channelCopy strong { font-size: 14px; line-height: 20px; font-weight: 680; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dph-channelNote { color: var(--dph-label-3); font-size: 10px; line-height: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dph-channel[aria-selected="true"] .dph-channelNote { color: color-mix(in srgb, var(--dph-blue) 70%, #8f959e); }

/* 通道 logo：方形圆角块，字母字形，零图片依赖 */
.dph-logo { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; box-shadow: 0 1px 3px rgb(31 35 41 / 7%); font-size: 15px; font-weight: 700; line-height: 1; user-select: none; }
.dph-logoTelegram { color: #fff; background: #229ed9; }
.dph-logoFeishu { color: #3370ff; background: #fff; border: 1px solid var(--dph-border-2); }
.dph-logoQq { color: #fff; background: #1677ff; }
.dph-logoWechat { color: #fff; background: #07c160; }
.dph-logoSynology { color: #fff; background: #3b6fd4; }
.dph-logoDingtalk { color: #fff; background: #0089ff; }
.dph-logoWecom { color: #fff; background: #2c8ef5; }
.dph-logoWecomApp { color: #fff; background: #1a6fd4; }
.dph-logoSlack { color: #fff; background: #4a154b; }
.dph-logoDiscord { color: #fff; background: #5865f2; }
.dph-logoMatrix { color: #fff; background: #0dbd8b; }
.dph-logoEmail { color: #fff; background: #7a869a; }

/* ── 工具行（扫码/导入/试发/代理/来源） ────────────────────────────── */
.dph-tool { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid transparent; border-radius: 10px; color: var(--dph-label-2); background: transparent; font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
.dph-tool:hover { background: var(--dph-hover); color: var(--dph-label-1); }
.dph-tool[aria-selected="true"] { border-color: var(--dph-border-2); background: var(--dph-hover); color: var(--dph-label-1); font-weight: 600; }

/* ── 通用卡片 ──────────────────────────────────────────────────────── */
.dph-card { border: 1px solid var(--dph-border-2); border-radius: 14px; background: var(--dph-bg-1); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.dph-cardBody { padding: 20px; }
.dph-card + .dph-card { margin-top: 12px; }
.dph-cardTitle { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
.dph-cardNote { margin: 0 0 12px; color: var(--dph-label-2); font-size: 12.5px; line-height: 1.65; }
.dph-sectionTitle { margin: 18px 0 8px; font-size: 13px; font-weight: 650; color: var(--dph-label-1); }

/* ── 页面骨架 ──────────────────────────────────────────────────────── */
.dph-page { display: flex; flex-direction: column; gap: 12px; padding: 0 0 8px; }
.dph-pageHead { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px; }
.dph-pageHeadText { min-width: 0; flex: 1 1 240px; }
.dph-pageTitle { margin: 0; font-size: 15px; line-height: 22px; font-weight: 650; display: flex; align-items: center; gap: 7px; }
.dph-pageHint { margin: 4px 0 0; color: var(--dph-label-3); font-size: 11.5px; line-height: 17px; }
.dph-onlineBadge { flex: none; min-height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; border-radius: 999px; background: #f2f3f5; color: var(--dph-label-2); font-size: 12px; white-space: nowrap; }
.dph-onlineBadge[data-tone="success"] { color: var(--dph-success); background: color-mix(in srgb, var(--dph-success) 9%, #fff); }
.dph-onlineBadge[data-tone="warn"] { color: var(--dph-warn); background: color-mix(in srgb, var(--dph-warn) 9%, #fff); }

/* 问号小圆 */
.dph-helpDot { width: 17px; height: 17px; display: inline-grid; place-items: center; border-radius: 50%; border: 1px solid color-mix(in srgb, #1677ff 28%, #dfe1e5); color: #1677ff; font-size: 11px; font-weight: 700; line-height: 1; cursor: help; flex: none; }

/* ── 按钮 ──────────────────────────────────────────────────────────── */
.dph-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.dph-btnPrimary { min-height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 13px; border: 1px solid #1677ff; border-radius: 8px; color: #fff; background: #1677ff; font: inherit; font-size: 13px; font-weight: 560; cursor: pointer; transition: background .15s, border-color .15s; }
.dph-btnPrimary:hover:not(:disabled) { background: #0e63e6; border-color: #0e63e6; }
.dph-btnSecondary { min-height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 13px; border: 1px solid #86909c; border-radius: 8px; color: var(--dph-label-1); background: var(--dph-bg-1); font: inherit; font-size: 13px; cursor: pointer; transition: background .15s, border-color .15s; }
.dph-btnSecondary:hover:not(:disabled) { background: #f7f8fa; border-color: #6b7580; }
.dph-btn { min-height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 0 11px; border: 1px solid var(--dph-border-2); border-radius: 8px; color: var(--dph-label-1); background: var(--dph-bg-1); font: inherit; font-size: 12.5px; cursor: pointer; transition: background .15s, border-color .15s; }
.dph-btn:hover:not(:disabled) { background: #f7f8fa; border-color: #aeb3bb; }
.dph-btnDanger { min-height: 28px; display: inline-flex; align-items: center; padding: 0 9px; border: 1px solid var(--dph-border-2); border-radius: 8px; color: var(--dph-error); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.dph-btnDanger:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dph-error) 40%, #e5e6eb); background: color-mix(in srgb, var(--dph-error) 6%, #fff); }
.dph-btnPrimary:disabled, .dph-btnSecondary:disabled, .dph-btn:disabled, .dph-btnDanger:disabled { opacity: .45; cursor: default; }
.dph-btnPrimary:focus-visible, .dph-btnSecondary:focus-visible, .dph-btn:focus-visible, .dph-btnDanger:focus-visible { outline: 2px solid var(--dph-blue); outline-offset: 2px; }

/* ── 机器人列表 ────────────────────────────────────────────────────── */
.dph-listSection { min-width: 0; }
.dph-listHeading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 8px; padding: 0 2px; }
.dph-listHeading h3 { margin: 0; font-size: 14px; font-weight: 650; }
.dph-listHeading span { color: var(--dph-label-3); font-size: 11.5px; }
.dph-botList { min-width: 0; width: 100%; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin: 0; padding: 0; list-style: none; }
.dph-botList > li { min-width: 0; max-width: 100%; }
.dph-botCard { position: relative; min-width: 0; width: 100%; border: 1px solid var(--dph-border-2); border-radius: 14px; background: var(--dph-bg-1); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.dph-botCardBody { min-width: 0; padding: 12px 10px; }
.dph-botCardTop { min-width: 0; display: flex; flex-wrap: nowrap; align-items: flex-start; justify-content: space-between; gap: 6px; }
.dph-botIdentity { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 8px; }
.dph-botAvatar { flex: none; width: 38px; height: 38px; display: grid; place-items: center; border-radius: 11px; font-size: 18px; font-weight: 700; line-height: 1; user-select: none; }
.dph-botName { min-width: 0; display: grid; gap: 1px; }
.dph-nameRow { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dph-botName h3 { margin: 0; min-width: 0; font-size: 15px; line-height: 21px; font-weight: 650; color: var(--dph-label-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dph-botName p { margin: 0; min-width: 0; font: 12px/16px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dph-label-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dph-botCardTools { flex: none; display: flex; align-items: flex-start; gap: 4px; }
.dph-botHealthGroup { display: grid; justify-items: end; gap: 4px; }
.dph-health { display: inline-flex; align-items: center; gap: 7px; color: var(--dph-label-2); font-size: 12px; white-space: nowrap; }
.dph-healthDot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #aeb3bb; }
.dph-healthDot[data-tone="success"] { background: var(--dph-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dph-success) 14%, transparent); }
.dph-healthDot[data-tone="warning"] { background: var(--dph-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dph-warn) 14%, transparent); }
.dph-healthDot[data-tone="error"] { background: var(--dph-error); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dph-error) 14%, transparent); }
.dph-lastChecked { display: inline-flex; align-items: baseline; gap: 4px; color: var(--dph-label-3); font-size: 11px; white-space: nowrap; }
.dph-botSettingsButton { min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 6px; border: 0; border-radius: 8px; color: var(--dph-blue); background: transparent; font: inherit; font-size: 12px; cursor: pointer; transition: color .15s, background .15s; }
.dph-botSettingsButton:hover { color: var(--dph-label-1); background: var(--dph-hover); }
.dph-botSettingsButton svg { width: 15px; height: 15px; }
.dph-moreSettingsChevron { width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform .22s cubic-bezier(.4, 0, .2, 1); }
.dph-botSettingsButton[aria-expanded="true"] .dph-moreSettingsChevron { transform: rotate(-135deg); }
.dph-aliasEdit { display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 3px; border: 0; border-radius: 5px; color: var(--dph-label-3); background: transparent; cursor: pointer; }
.dph-aliasEdit:hover:not(:disabled) { color: var(--dph-blue); background: var(--dph-hover); }
.dph-aliasEdit svg { width: 13px; height: 13px; opacity: .7; }
.dph-aliasEdit:hover:not(:disabled) svg { opacity: 1; }
.dph-aliasEditIcon { display: inline-grid; place-items: center; line-height: 0; }
.dph-aliasEditIcon svg { width: 13px; height: 13px; }

/* ── 机器人设置标签页 ───────────────────────────────────────────────── */
.dph-tabs { min-width: 0; display: grid; gap: 0; }
.dph-tabsBar { position: relative; min-width: 0; display: flex; align-items: center; gap: 4px; }
.dph-tabsStrip { min-width: 0; flex: 1 1 auto; display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; scroll-behavior: smooth; }
.dph-tabsStrip::-webkit-scrollbar { display: none; }
.dph-tab { flex: none; padding: 5px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dph-label-2); font-size: 12.5px; line-height: 20px; font-family: inherit; cursor: pointer; white-space: nowrap; }
.dph-tab:hover:not(:disabled) { background: var(--dph-hover); color: var(--dph-label-1); }
.dph-tab[aria-selected="true"] { background: color-mix(in srgb, var(--dph-blue) 11%, #fff); color: var(--dph-blue); font-weight: 620; }
.dph-tabArrow { flex: none; width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 1px solid var(--dph-border-2); border-radius: 6px; background: var(--dph-bg-1); color: var(--dph-label-3); cursor: pointer; }
.dph-tabArrow:hover:not(:disabled) { color: var(--dph-label-1); border-color: #aeb3bb; }
.dph-tabArrow[hidden] { display: none; }
.dph-tabArrow svg { width: 12px; height: 12px; }
.dph-tabPanel { min-width: 0; padding-top: 12px; border-top: 1px solid var(--dph-border-1); margin-top: 8px; }
.dph-recvRow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--dph-border-1); }
.dph-recvRow:last-of-type { border-bottom: 0; }
.dph-recvRow[data-tone="muted"] { opacity: .82; }
/* v0.39.0：接收权被别的轮询者占着（409）时，这一行要看得出来不是「正常在收」。 */
.dph-recvRow[data-tone="warn"] .dph-recvNote { color: var(--dph-warn); }
.dph-recvMain { min-width: 0; display: grid; gap: 2px; }
.dph-recvNote { color: var(--dph-label-3); font-size: 11.5px; line-height: 17px; word-break: break-word; }
.dph-recvList { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.dph-recvItem { padding: 9px 10px; border: 1px solid var(--dph-border-1); border-radius: 9px; background: var(--dph-bg-1); min-width: 0; }
.dph-recvMeta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dph-recvTagBtn { padding: 1px 7px; border-radius: 999px; font-size: 10.5px; line-height: 16px; background: var(--dph-bg-3, rgba(120,140,255,.16)); color: var(--dph-link-1, #6b8cff); white-space: nowrap; }
.dph-recvItem[data-kind="callback"] { border-left: 3px solid var(--dph-link-1, #6b8cff); }
.dph-recvTagFile { padding: 1px 7px; border-radius: 999px; font-size: 10.5px; line-height: 16px; background: var(--dph-ok-bg, rgba(60,190,120,.16)); color: var(--dph-ok-fg, #2f9e68); white-space: nowrap; }
.dph-recvItem[data-kind="attachment"] { border-left: 3px solid var(--dph-ok-fg, #2f9e68); }
.dph-recvText { margin: 6px 0 0; color: var(--dph-label-1); font-size: 12.5px; line-height: 20px; white-space: pre-wrap; word-break: break-word; }
/* 折叠体（点齿轮才展开） */
.dph-collapsible { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .22s cubic-bezier(.4, 0, .2, 1); }
.dph-collapsible[data-open="true"] { grid-template-rows: 1fr; }
.dph-collapsibleBody { min-height: 0; overflow: hidden; visibility: hidden; }
.dph-collapsible[data-open="true"] .dph-collapsibleBody { visibility: visible; }
.dph-collapsibleBodyInner { padding-top: 12px; }

/* ── 表单 ──────────────────────────────────────────────────────────── */
.dph-field { display: grid; grid-template-columns: 92px minmax(0, 1fr); align-items: center; gap: 8px; margin-top: 7px; }
.dph-field > label { color: var(--dph-label-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }
.dph-fieldWide { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; align-items: center; gap: 8px; margin-top: 7px; }
.dph-fieldWide > label { color: var(--dph-label-3); font-size: 11.5px; }
.dph-hintRow { margin: 4px 0 0 100px; color: var(--dph-label-3); font-size: 11px; line-height: 16px; }
.dph-hintRow[data-tone="warn"] { color: var(--dph-warn); }
.dph-hintRow[data-tone="error"] { color: var(--dph-error); }
.dph-input, .dph-select { min-width: 0; width: 100%; padding: 6px 9px; border: 1px solid var(--dph-border-2); border-radius: 7px; color: var(--dph-label-1); background: var(--dph-bg-1); font: inherit; font-size: 12.5px; }
.dph-input:focus, .dph-select:focus { outline: none; border-color: color-mix(in srgb, var(--dph-blue) 60%, #dfe1e5); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dph-blue) 12%, transparent); }
.dph-input::placeholder { color: #b8bec7; }
.dph-select { cursor: pointer; }
.dph-nameInput { font-weight: 600; }
.dph-inline { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dph-inline > .dph-input { flex: 1 1 auto; }
.dph-inline > .dph-select { flex: 0 0 auto; width: auto; }
/* 发送到：类型下拉 + 手填 ID 一行，候选下拉另起一行（候选可能很长，挤在一行会把 ID 输入框压没） */
.dph-targetBox { display: grid; gap: 6px; min-width: 0; }
.dph-targetPicker { width: 100%; }
.dph-check { display: inline-flex; align-items: center; gap: 6px; color: var(--dph-label-2); font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap; }
.dph-check input { width: 14px; height: 14px; margin: 0; accent-color: #1677ff; cursor: pointer; }
.dph-dividerLine { height: 1px; background: var(--dph-border-1); margin: 12px 0 2px; }
.dph-dashedLine { height: 0; border-top: 1px dashed var(--dph-border-2); margin: 11px 0 0; }
.dph-testRow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 11px; }
.dph-testResult { font-size: 11.5px; }
.dph-testResult[data-tone="success"] { color: var(--dph-success); }
.dph-testResult[data-tone="error"] { color: var(--dph-error); }
.dph-testResult[data-tone="muted"] { color: var(--dph-label-3); }

/* 徽标 */
.dph-badge { display: inline-flex; align-items: center; padding: 0 7px; border: 1px solid transparent; border-radius: 999px; font-size: 11px; line-height: 17px; white-space: nowrap; }
.dph-badge[data-tone="success"] { color: var(--dph-success); border-color: color-mix(in srgb, var(--dph-success) 30%, #fff); background: color-mix(in srgb, var(--dph-success) 8%, #fff); }
.dph-badge[data-tone="warn"] { color: var(--dph-warn); border-color: color-mix(in srgb, var(--dph-warn) 30%, #fff); background: color-mix(in srgb, var(--dph-warn) 8%, #fff); }
.dph-badge[data-tone="error"] { color: var(--dph-error); border-color: color-mix(in srgb, var(--dph-error) 30%, #fff); background: color-mix(in srgb, var(--dph-error) 8%, #fff); }
.dph-badge[data-tone="muted"] { color: var(--dph-label-2); border-color: var(--dph-border-2); background: #f7f8fa; }

/* 空态 / 新增卡 */
.dph-empty { border: 1px dashed var(--dph-border-2); border-radius: 14px; padding: 20px 16px; text-align: center; color: var(--dph-label-3); font-size: 12.5px; line-height: 1.7; }
.dph-addBox { width: 100%; min-height: 44px; display: grid; place-items: center; margin-top: 2px; border: 1px dashed var(--dph-border-2); border-radius: 14px; color: var(--dph-label-2); background: transparent; font: inherit; font-size: 12.5px; cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
.dph-addBox:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dph-blue) 40%, #dfe1e5); color: var(--dph-blue); background: color-mix(in srgb, var(--dph-blue) 4%, #fff); }
.dph-addBox:disabled { opacity: .5; cursor: default; }

/* 原始 JSON / 路径 */
.dph-pre { margin: 8px 0 0; padding: 10px 12px; border-radius: 9px; background: #f7f8fa; color: var(--dph-label-2); font: 11.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
.dph-code { font: 11.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dph-label-2); word-break: break-all; }
.dph-ordered { margin: 0 0 10px 18px; padding: 0; font-size: 12.5px; line-height: 1.85; color: var(--dph-label-2); }

/* 二维码 */
.dph-qrWrap { display: grid; justify-items: center; gap: 8px; padding: 14px; text-align: center; }
.dph-qrImg { width: 200px; height: 200px; display: block; background: #fff; border-radius: 10px; border: 1px solid var(--dph-border-1); }

/* 加载 / 骨架 */
.dph-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 40px 16px; color: var(--dph-label-3); font-size: 12.5px; }
.dph-spinner { width: 18px; height: 18px; border: 2.5px solid var(--dph-border-1); border-top-color: var(--dph-blue); border-radius: 50%; animation: dph-spin .8s linear infinite; }
@keyframes dph-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dph-spinner { animation: none; }
  .dph-collapsible, .dph-moreSettingsChevron, .dph-progressFill { transition: none; }
}

/* 主面板（从侧栏点进来时的整页） */
/* v0.39.1：.dph-pageWrap 原先只有留白、没有高度与溢出，而它的父级
   （layout 的 .mainPanel：display:flex/column、min-height:0、无 overflow）
   不会替它滚；更里层 .dph-root 的 height:100% 因此在「父级无定高」时退化成
   auto，滚动永远不触发，内容超出就被裁掉。
   这里让 pageWrap 自己成为 flex 滚动项：flex:1 + min-height:0 拿满剩余高度，
   溢出自己滚；同时显式给 8px 可见滚动条（宿主全局把滚动条做成 5px 细条，
   观感上像没有）。 */
.dph-pageWrap {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-height: 0;
  max-height: 100%;
  padding: 20px 24px 28px;
  max-width: 1180px;
  margin: 0 auto;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb, rgba(128, 128, 128, .45)) transparent;
}
.dph-pageWrap::-webkit-scrollbar { width: 8px; height: 8px; }
.dph-pageWrap::-webkit-scrollbar-track { background: transparent; }
.dph-pageWrap::-webkit-scrollbar-thumb {
  background: var(--dsh-scrollbar-thumb, rgba(128, 128, 128, .45));
  border-radius: 8px;
}
.dph-pageWrap::-webkit-scrollbar-thumb:hover { background: var(--dsh-scrollbar-thumb-hover, rgba(128, 128, 128, .75)); }
@media (max-width: 760px) {
  .dph-pageWrap { padding: 12px 12px 20px; }
}

/* 多投递目标（v0.14.0）：一行一个目标，底部是「再加一个」与候选挑选。 */
.dph-targetRow { display: block; margin-bottom: 6px; }
.dph-targetRow:last-of-type { margin-bottom: 0; }
.dph-targetDrop { flex: 0 0 auto; padding: 0 8px; height: 32px; }
.dph-targetFoot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.dph-targetAdd { flex: 0 0 auto; height: 32px; }
/* 摘要视图（插件详情页） */
.dph-summary { display: flex; flex-direction: column; gap: 10px; }
.dph-summaryRow { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 12.5px; }
.dph-summaryKey { color: var(--dph-label-3); font-size: 11.5px; min-width: 62px; }
.dph-summaryVal { color: var(--dph-label-1); min-width: 0; }
`

    /** 通道元信息（只用于界面展示；真实上限由 host 返回）。 */
    /** 各通道的收法（接收页里标出来，省得以为都是一种）。 */
    const RECEIVE_MODE = {
      telegram: '长轮询',
      wechat: '长轮询',
      matrix: '长轮询',
      feishu: 'WSClient 长连接',
      slack: 'Socket Mode',
      discord: 'Gateway 长连接',
      qq: 'Gateway 长连接',
      email: 'IMAP 轮询',
      dingtalk: 'Stream 长连接',
      wecom_app: '智能机器人 WS',
    }

    const CHANNEL_TITLES = {
      wechat: '微信',
      feishu: '飞书',
      dingtalk: '钉钉',
      wecom: '企业微信（群机器人）',
      wecom_app: '企业微信（自建应用）',
      qq: 'QQ',
      telegram: 'Telegram',
      slack: 'Slack',
      discord: 'Discord',
      matrix: 'Matrix',
      synology_chat: '群晖 Chat',
      email: '邮件',
    }

    // 顺序与 lib/config.js 的 ALL_CHANNELS 保持一致：国内常用的在前，国际的居中，小众的收尾。
    const CHANNEL_ORDER = [
      'wechat', 'feishu', 'dingtalk', 'wecom', 'wecom_app', 'qq',
      'telegram', 'slack', 'discord', 'matrix', 'synology_chat', 'email',
    ]

    /** 方形 logo 的配色类与字形（零图片依赖，纯 CSS）。 */
    const LOGO_CLASS = {
      wechat: 'dph-logoWechat',
      feishu: 'dph-logoFeishu',
      dingtalk: 'dph-logoDingtalk',
      wecom: 'dph-logoWecom',
      wecom_app: 'dph-logoWecomApp',
      qq: 'dph-logoQq',
      telegram: 'dph-logoTelegram',
      slack: 'dph-logoSlack',
      discord: 'dph-logoDiscord',
      matrix: 'dph-logoMatrix',
      synology_chat: 'dph-logoSynology',
      email: 'dph-logoEmail',
    }

    const LOGO_TEXT = {
      wechat: '微', feishu: '飞', dingtalk: '钉', wecom: '企', wecom_app: '应',
      qq: 'Q', telegram: 'T', slack: 'S', discord: 'D', matrix: 'M',
      synology_chat: '群', email: '邮',
    }

    /** 每个通道填凭据的指引（一句话，能让人知道去哪复制）。 */
    const OWN_HINTS = {
      wechat: 'iLink 扫码后拿到的 bot token 与账号 ID；只能发给跟它说过话的人。',
      dingtalk: '钉钉群 → 群设置 → 机器人 → 自定义 → 复制 Webhook；如果勾了「加签」，把 SEC 开头的 secret 也填上。国内直连。',
      wecom: '企业微信群 → 群机器人 → 添加 → 复制 Webhook（key 是 UUID）。只能发到那个群，@ 人填成员账号或 @all。',
      wecom_app: '企业微信「我的企业」拿企业 ID，「应用管理 → 你的应用」拿 Secret 与 AgentId。能发给指定成员；注意要在应用里配「企业可信IP」。',
      slack: 'Slack App → OAuth & Permissions → Bot User OAuth Token（xoxb- 开头），scope 至少 chat:write；还要把机器人 /invite 进频道。',
      discord: 'Discord Developer Portal → Bot → Token；把机器人邀请进服务器，并在「发送到」里填频道 ID（开发者模式下右键频道复制）。',
      matrix: 'Element → 设置 → 帮助与关于 → 访问令牌，加上 homeserver 地址（例 https://matrix.org）。加密房间暂不支持。',
      email: '借 DSH profile 里的 nodemailer 发信（本插件零依赖）。多数邮箱要填「授权码」而不是登录密码。',
      telegram: 'BotFather 里 /newbot 拿到的 token。国内直连会超时，去「代理通道」把 Telegram 打开。',
      feishu: '飞书开放平台 → 自建应用 → 凭证与基础信息（App ID / App Secret）。国内直连，不用开代理。',
      qq: 'QQ 开放平台 → 机器人 → 开发设置（AppID / AppSecret）。国内直连，不用开代理。',
      wechat: 'iLink 扫码后拿到的 bot token 与账号 ID；只能发给跟它说过话的人。',
      synology_chat: '三种类型对齐群晖面板：「传入的 Webhook」填整合给的整条 URL（或只填 NAS 地址 + webhook 令牌，会自动拼）；「发出的 Webhook」是群晖回调你的方向，本插件只登记不发送；「机器人」填传入 URL（或 NAS + 令牌）+ 数字用户 ID。',
    }

    const MENTION_LABELS = { none: '不 @ 任何人', user: '@ 指定的人', all: '@ 所有人' }

    // 「对方 ID」输入框的占位提示：五个通道要填的东西形态完全不同，只写一个「对方 ID」等于让人猜。
    const TARGET_PLACEHOLDERS = {
      dingtalk: { user: '钉钉群机器人不需要收件人 —— 它天然发到生成 Webhook 的那个群', group: '钉钉群机器人不需要收件人' },
      wecom: { user: '企业微信群机器人不需要收件人 —— 它天然发到生成 Webhook 的那个群', group: '企业微信群机器人不需要收件人' },
      wecom_app: { user: '成员账号，例 zhangsan；多个用 | 分隔；填 @all 发给全部成员', group: '成员账号，例 zhangsan' },
      slack: { user: '#频道名 或频道 ID（C 开头）', group: '#频道名 或频道 ID（C 开头），机器人要在频道里' },
      discord: { user: '频道 ID，纯数字 —— 开发者模式里右键频道复制', group: '频道 ID，纯数字' },
      matrix: { user: '房间 ID，形如 !abcdef:matrix.org', group: '房间 ID，形如 !abcdef:matrix.org' },
      email: { user: '收件人邮箱，多个用逗号分隔', group: '收件人邮箱，多个用逗号分隔' },
      telegram: { user: '对方 chat_id，纯数字（例 6317****92）', group: '群 / 频道 chat_id，-100 开头（例 -1001234567890）' },
      feishu: { user: '单聊 open_id，ou_ 开头', group: '群 chat_id，oc_ 开头' },
      qq: { user: '单聊 openid —— 开放平台后台「消息推送」日志里复制', group: '群 group_openid —— 先在群里 @ 一次机器人再去后台复制' },
      wechat: { user: '对方 user id，形如 o9cq…@im.wechat', group: 'iLink 没有群，这里也只能填单聊 user id' },
      synology_chat: { user: '群晖用户 ID（数字，例 73）—— 只有「机器人」类型要填', group: '群晖用户 ID（数字，例 73）—— 只有「机器人」类型要填' },
    }
    const targetPlaceholder = (channel, kind) => {
      const row = TARGET_PLACEHOLDERS[channel] ?? {}
      return row[kind === 'group' ? 'group' : 'user'] ?? '对方 ID'
    }

    /**
     * v0.40.0：群晖 Chat 的「类型」按群晖面板的三种整合分。
     * 老配置里的 'webhook' 与空值（type 从未写过）一律归到 incoming ——
     * 它们原本走的就是「往里发」的协议，语义完全一致，不能因为归一变了行为。
     */
    const normalizeSynType = (value) => {
      const text = String(value ?? '').trim().toLowerCase()
      if (text === 'bot') return 'bot'
      if (text === 'outgoing') return 'outgoing'
      return 'incoming'
    }
    /** 每种整合类型实际要填的字段（其余隐藏，免得九个框铺开不知道填哪几个）。 */
    const SYN_FIELDS = {
      incoming: ['webhookUrl', 'nasUrl', 'token'],
      outgoing: ['outgoingUrl', 'token', 'channel', 'triggerWord'],
      bot: ['incomingUrl', 'outgoingUrl', 'nasUrl', 'token', 'userIds'],
    }

    /**
     * 单个机器人卡的设置标签页。
     *
     * 为什么要分标签：v0.9.0 把「名称 + 五六个凭据 + 发送到 + @ 提醒 + 两个测试按钮」
     * 全塞在一个折叠体里，一展开就是十几行，用户找不到「发送到」在哪。
     * 参考 @xmanrui/dsh-im 的做法按用途分组，每组只显示相关的那几行。
     *
     * 注意：标签只是「显示分组」，所有字段的 state 始终在 ownBots 里，
     * 切标签不会丢输入（DOM 会卸载但值在 state 里）。
     */
    const BOT_TABS = [
      { id: 'general', label: '通用' },
      { id: 'delivery', label: '投递设置' },
      { id: 'access', label: '访问设置' },
      { id: 'advanced', label: '高级' },
    ]

    /** 按通道给出该卡可用的标签（群晖 Chat 没有 @ 提醒，就不给「访问设置」）。 */
    const botTabsForChannel = (channel) => BOT_TABS.filter((tab) => tab.id !== 'access' || channel !== 'synology_chat')
    /** 左侧导航里除了通道之外的几项。 */
    const EXTRA_NAV = [
      { key: 'qr', label: '扫码接入', hint: '一次性拿到凭据' },
      { key: 'test', label: '试发一条', hint: '群发验证' },
      { key: 'outbox', label: '发送记录', hint: '发出去了什么' },
      { key: 'stream', label: '流式会话', hint: '一条消息反复改' },
      { key: 'progress', label: '进度表情', hint: '挂个进行中' },
      // v0.35.0：每分钟配额是「悄悄生效」的东西 —— 消息只是变慢了，界面不提示。
      // 没有这一页，用户只会觉得「今天怎么这么慢」然后去调 chunkDelayMs（那是块间隔，没用）。
      { key: 'limits', label: '发送配额', hint: '每分钟几条' },
      // v0.36.0：入站附件。没这一页，「对方发的图没保存下来」就完全没法定位 ——
      // 是取不到（平台本身不给，或本轮没做）、是超了上限、还是磁盘策略清掉了，界面上必须能看出是哪一种。
      { key: 'files', label: '入站附件', hint: '存到哪儿、清了没' },
      { key: 'proxy', label: '代理通道', hint: '逐通道开关' },
      { key: 'visibility', label: '通道显示', hint: '显示 / 隐藏' },
      { key: 'receive', label: '接收消息', hint: '主动拉取' },
      { key: 'sources', label: '来源与顺序', hint: '回落规则' },
    ]

    /** 内联 SVG 图标：统一 24 网格描边风格，零依赖。 */
    function icon(children) {
      return h('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, children)
    }

    const ICONS = {
      chevronLeft: () => icon([h('path', { key: 'a', d: 'M15 5l-7 7 7 7' })]),
      chevronRight: () => icon([h('path', { key: 'a', d: 'M9 5l7 7-7 7' })]),
      reload: () => icon([
        h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 6' }),
        h('path', { key: 'b', d: 'M20 4.5V11h-6' }),
      ]),
      undo: () => icon([
        h('path', { key: 'a', d: 'M4 10h10a5 5 0 0 1 0 10h-3' }),
        h('path', { key: 'b', d: 'M8 6 4 10l4 4' }),
      ]),
      pencil: () => icon([
        h('path', { key: 'a', d: 'M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z' }),
      ]),
      help: () => icon([
        h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }),
        h('path', { key: 'b', d: 'M9.5 9.2a2.6 2.6 0 1 1 3.4 2.5c-.7.3-1 .9-1 1.6' }),
        h('path', { key: 'c', d: 'M12 17h.01' }),
      ]),
    }

    /** 统一的请求封装：任何失败都转成可读中文，不把 undefined 抛给界面。 */
    async function call(method, path, body) {
      const res = await fetch(API + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let data
      try {
        data = text === '' ? {} : JSON.parse(text)
      } catch {
        data = { ok: false, error: '返回的不是 JSON：' + text.slice(0, 200) }
      }
      if (!res.ok && data.ok !== false) data.ok = false
      return data
    }

    /** 主设置面板：设置分区与插件详情页共用同一份组件。 */
    function PushHubSettings(props) {
      const compact = props?.view === 'summary'

      const [loading, setLoading] = useState(true)
      const [saving, setSaving] = useState(false)
      const [progress, setProgress] = useState(0)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      const [channels, setChannels] = useState([])
      const [configPath, setConfigPath] = useState('')
      const [defaults, setDefaults] = useState([])
      const [picked, setPicked] = useState([])
      const [ownBots, setOwnBots] = useState({})
      const [ownFields, setOwnFields] = useState({})
      const [qrCaps, setQrCaps] = useState({})
      const [qrSession, setQrSession] = useState(null)
      const [qrBusy, setQrBusy] = useState(false)
      const [targetMeta, setTargetMeta] = useState({})
      const [saveStatus, setSaveStatus] = useState({ state: 'idle', at: '', error: '' })
      const hydrated = useRef(false)
      const autoTimer = useRef(null)
      const savingRef = useRef(false)
      const pendingRef = useRef(false)
      const [accountTests, setAccountTests] = useState({})
      const [qrUndo, setQrUndo] = useState(null)
      // 界面导航：view 是 'channel' 时再看 selectedChannel。
      const [view, setView] = useState('channel')
      const [selectedChannel, setSelectedChannel] = useState('')
      // 「获取会话」的结果：key = channel|account，值是 {busy, items, note}
      const [targetLists, setTargetLists] = useState({})
      // 代理：url 一个地址 + channels 每通道一个开关（后端读的也是这两个键）
      const [proxy, setProxy] = useState({ url: '', channels: {} })
      /**
       * 通道显示偏好（v0.26.0）：只影响左侧列表显示哪些通道，**不碰发送、不碰接收**。
       * mode='all' 全部显示（再减去 hidden）；mode='bound' 只显示有账号的（再减去 hidden）。
       * 两个模式叠加，所以「只看已绑定的」和「这条我暂时不想看到」能同时用。
       */
      const [visibility, setVisibility] = useState({ mode: 'all', hidden: [] })
      // 展开中的机器人卡（同一时刻只展开一个，避免五套表单同时铺开）
      const [openCard, setOpenCard] = useState('')
      // 点过「明码」的密钥字段：key = 通道|账号|字段名，值是明文（只活在内存里，不回写 ownBots）
      const [revealed, setRevealed] = useState({})
      // 每张机器人卡当前停在哪个标签（key = 通道|下标），默认「通用」
      const [cardTab, setCardTab] = useState({})

      /** 接收（v0.15.0）：能收的通道、每个账号运行态、收件箱。 */
      const [recv, setRecv] = useState({ loading: false, receivable: [], status: [], blocked: {}, inboxPath: '', messages: [], busy: '', note: '' })
      /**
       * 发文件（v0.18.0）：能发文件的通道清单 + 每个账号自己的发文件状态。
       *
       * 单独一份状态而不是复用 accountTests：发文件与发文字是两件事，
       * 一个成功不代表另一个也能成（比如 token 有 chat:write 但没有 files:write），
       * 混在一行会让用户以为「既然文字能发，文件当然也行」。
       */
      const [fileState, setFileState] = useState({ channels: [], busy: {}, note: {}, at: {} })
      /**
       * 发送回执（v0.28.0）：最近发出去的那些，含平台返回的消息 id。
       *
       * 放在 fileState 之后（不是中间）：前面那些 state 的下标被探针当契约用
       * （probe_visibility / probe_tabs 里的 IDX 表），插在中间会让它们假红。
       */
      const [outboxState, setOutboxState] = useState({ loading: false, path: '', entries: [], note: '' })
      /**
       * 改 / 撤的能力表（v0.29.0）。
       *
       * 由后端给，前端不自己写死 —— 通道支持面会随平台变（Slack 的 chat.delete
       * 在 dsh-im 里根本没实现，是我们按官方文档补的），前端写死一份迟早过期，
       * 过期后就会给用户一个「点了必然失败」的按钮，那比没有按钮更糟。
       */
      // v0.30.0：react / reactReasons 跟 edit / del 一起从 /edit/channels 拿 ——
      // 一次加载把三种能力都定好，不给「点了必然失败」的按钮。
      const [editCaps, setEditCaps] = useState({ edit: [], del: [], react: [], editReasons: {}, deleteReasons: {}, reactReasons: {} })
      // v0.32.0：流式会话。只读 —— 开流 / 送更新 / 定稿都在工具侧，
      // 界面上开一条流没有任何意义（没有东西往里送），但得让人看见「现在有几条在跑」。
      const [streamState, setStreamState] = useState({ loading: false, channels: [], reasons: {}, streams: [], size: 0, note: '' })
      // v0.33.0：进度表情。同样只读 —— 挂与收尾都是发送方的动作，
      // 界面能做的有意义的事只有一件：让你看见现在还有几条没被收尾。
      const [progressState, setProgressState] = useState({ channels: [], reasons: {}, items: [], size: 0, note: '', swept: [], maxActive: 0, ttlMs: 0 })
      // v0.35.0：限流桶的现状。只读 —— 配额在账号的「高级」页里改，这一页只回答「谁在等」。
      const [limitState, setLimitState] = useState({ channels: [], reasons: {}, buckets: [], defaults: {}, size: 0, note: '' })
      // v0.36.0：入站附件。这一页只回答三件事 —— 硬盘上有什么、策略是什么、哪些没下下来以及为什么。
      // 策略在别的页面改不了（它不属于任何通道，属于这台机器的硬盘），所以这一页带一个就地修改的入口。
      const [inboundState, setInboundState] = useState({ items: [], totalBytes: 0, totalHuman: '', count: 0, root: '', policy: {}, reasons: {}, saving: false, note: '', busy: '' })
      const nameRefs = useRef({})

      /** 拉取配置：只拿到掩码后的值。 */
      const reload = useCallback(async () => {
        setLoading(true)
        setProgress(30)
        setError('')
        try {
          const data = await call('GET', '/config')
          setProgress(80)
          if (data.ok !== true) throw new Error(data.error ?? '读取配置失败')
          setChannels(Array.isArray(data.channels) ? data.channels : [])
          setConfigPath(String(data.configPath ?? ''))
          const effective = Array.isArray(data.defaults) ? data.defaults.map(String) : []
          setDefaults(effective)
          const saved = Array.isArray(data?.config?.default_channels) ? data.config.default_channels.map(String) : []
          const explicitEmpty = data?.config?.default_channels_explicit === true && saved.length === 0
          setPicked(saved.length > 0 ? saved : explicitEmpty ? [] : effective)
          setOwnBots(data?.config?.own_bots && typeof data.config.own_bots === 'object' ? data.config.own_bots : {})
          // v0.40.2：整页重新拉配置时，明码缓存必须整体作废。
          // 它是「这一刻这个名称下的字段值」的快照，配置一换就不再成立；
          // 留着它，同名行会在下一次渲染里把上一轮的明文顶回只读框。
          setRevealed({})
          const fields = data?.ownBotFields && typeof data.ownBotFields === 'object' ? data.ownBotFields : {}
          setOwnFields(fields)
          setTargetMeta(data?.targetMeta && typeof data.targetMeta === 'object' ? data.targetMeta : {})
          const pol = data?.config?.proxy
          setProxy(pol !== null && typeof pol === 'object'
            ? {
                url: String(pol.url ?? ''),
                channels: pol.channels !== null && typeof pol.channels === 'object' ? pol.channels : {},
              }
            : { url: '', channels: {} })
          const vis = data?.config?.channel_visibility
          setVisibility(vis !== null && typeof vis === 'object'
            ? {
                mode: vis.mode === 'bound' ? 'bound' : 'all',
                hidden: Array.isArray(vis.hidden) ? vis.hidden.map(String) : [],
              }
            : { mode: 'all', hidden: [] })
          // 首次进入时自动选中第一个「已配账号」的通道，省得用户自己找。
          setSelectedChannel((prev) => {
            if (prev !== '') return prev
            const keys = Object.keys(fields)
            const withAcc = keys.find((key) => Array.isArray(data?.config?.own_bots?.[key]) && data.config.own_bots[key].length > 0)
            return withAcc ?? keys[0] ?? ''
          })
          try {
            const caps = await call('GET', '/qr/capabilities')
            setQrCaps(caps?.capabilities && typeof caps.capabilities === 'object' ? caps.capabilities : {})
          } catch {
            setQrCaps({})
          }
          // 哪些通道能发文件由后端说了算（判据是「实现了 sendFile」），前端不猜。
          try {
            const fl = await call('GET', '/send/file/channels')
            setFileState((prev) => ({ ...prev, channels: Array.isArray(fl?.channels) ? fl.channels.map(String) : [] }))
          } catch {
            setFileState((prev) => ({ ...prev, channels: [] }))
          }
          // 同理：哪些通道能带按钮也由后端说了算（判据是「实现了按钮支持」）。
          try {
            const bc = await call('GET', '/buttons/channels')
            setButtonChannels(Array.isArray(bc?.channels) ? bc.channels.map(String) : [])
          } catch {
            setButtonChannels([])
          }
          // v0.25.0：哪些通道能引用回复，同样由后端说了算。
          try {
            const rc = await call('GET', '/reply/channels')
            setReplyChannels(Array.isArray(rc?.channels) ? rc.channels.map(String) : [])
          } catch {
            setReplyChannels([])
          }
          // v0.28.0：发送回执。读不到不算错 —— 可能一次都没发过。
          try {
            const oh = await call('GET', '/send/history?limit=100')
            setOutboxState({
              loading: false,
              path: String(oh?.path ?? ''),
              entries: Array.isArray(oh?.entries) ? oh.entries : [],
              note: '',
            })
          } catch {
            setOutboxState({ loading: false, path: '', entries: [], note: '读取发送记录失败' })
          }
          // v0.29.0：谁能改 / 谁能撤。同样以后端为准。
          try {
            const ec = await call('GET', '/edit/channels')
            setEditCaps({
              edit: Array.isArray(ec?.edit) ? ec.edit.map(String) : [],
              del: Array.isArray(ec?.del) ? ec.del.map(String) : [],
              react: Array.isArray(ec?.react) ? ec.react.map(String) : [],
              editReasons: ec?.editReasons && typeof ec.editReasons === 'object' ? ec.editReasons : {},
              deleteReasons: ec?.deleteReasons && typeof ec.deleteReasons === 'object' ? ec.deleteReasons : {},
              reactReasons: ec?.reactReasons && typeof ec.reactReasons === 'object' ? ec.reactReasons : {},
            })
          } catch {
            setEditCaps({ edit: [], del: [], react: [], editReasons: {}, deleteReasons: {}, reactReasons: {} })
          }
          // v0.32.0：流式会话现状。读不到不算错 —— 绝大多数时候一条都没有。
          try {
            const sl = await call('GET', '/send/stream/list')
            setStreamState({
              loading: false,
              channels: Array.isArray(sl?.channels) ? sl.channels.map(String) : [],
              reasons: sl?.reasons && typeof sl.reasons === 'object' ? sl.reasons : {},
              streams: Array.isArray(sl?.streams) ? sl.streams : [],
              size: Number(sl?.size ?? 0),
              note: '',
            })
          } catch {
            setStreamState({ loading: false, channels: [], reasons: {}, streams: [], size: 0, note: '读取流式会话失败' })
          }
          // v0.33.0：进度表情现状。忘收尾的表情会一直挂着，这一页就是用来发现它的。
          try {
            const pl = await call('GET', '/send/progress/list')
            setProgressState({
              channels: Array.isArray(pl?.channels) ? pl.channels.map(String) : [],
              reasons: pl?.reasons && typeof pl.reasons === 'object' ? pl.reasons : {},
              items: Array.isArray(pl?.items) ? pl.items : [],
              size: Number(pl?.size ?? 0),
              // v0.34.0：列表接口会顺手清掉超时的，把清了几条、上限多少、TTL 多少都摆出来，
              // 否则「怎么少了一条」会像个 bug。
              swept: Array.isArray(pl?.swept) ? pl.swept.map(String) : [],
              maxActive: Number(pl?.maxActive ?? 0),
              ttlMs: Number(pl?.items?.[0]?.ttlMs ?? 0),
              note: typeof pl?.detail === 'string' && pl.detail !== '' ? pl.detail : '',
            })
          } catch {
            setProgressState({ channels: [], reasons: {}, items: [], size: 0, note: '读取进度表情失败', swept: [], maxActive: 0, ttlMs: 0 })
          }
          // v0.35.0：限流桶现状。桶是易失的，重启后这里是空的 —— 那是正确状态。
          try {
            const lm = await call('GET', '/send/limits')
            setLimitState({
              channels: Array.isArray(lm?.channels) ? lm.channels.map(String) : [],
              reasons: lm?.reasons && typeof lm.reasons === 'object' ? lm.reasons : {},
              buckets: Array.isArray(lm?.buckets) ? lm.buckets : [],
              defaults: lm?.defaults && typeof lm.defaults === 'object' ? lm.defaults : {},
              size: Number(lm?.size ?? 0),
              note: typeof lm?.detail === 'string' && lm.detail !== '' ? lm.detail : '',
            })
          } catch {
            setLimitState({ channels: [], reasons: {}, buckets: [], defaults: {}, size: 0, note: '读取发送配额失败' })
          }
          // v0.36.0：已落盘的附件 + 下载策略。策略读不到不该让整页失败，所以单独 try。
          try {
            const fl = await call('GET', '/receive/files')
            setInboundState((prev) => ({
              ...prev,
              items: Array.isArray(fl?.items) ? fl.items : [],
              totalBytes: Number(fl?.totalBytes ?? 0),
              totalHuman: String(fl?.totalHuman ?? ''),
              count: Number(fl?.count ?? 0),
              root: String(fl?.root ?? ''),
              policy: fl?.policy && typeof fl.policy === 'object' ? fl.policy : {},
              reasons: fl?.policy?.reasons && typeof fl.policy.reasons === 'object' ? fl.policy.reasons : {},
              note: typeof fl?.detail === 'string' && fl.detail !== '' ? fl.detail : '',
            }))
          } catch {
            setInboundState((prev) => ({ ...prev, note: '读取附件目录失败' }))
          }

        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setProgress(100)
          setLoading(false)
          hydrated.current = true
          window.setTimeout(() => setProgress(0), 400)
        }
      }, [])

      useEffect(() => { reload() }, [reload])

      // 切到「接收消息」时才拉状态：进面板不额外打请求。
      useEffect(() => {
        if (view !== 'receive') return
        loadReceive()
      }, [view])

      const togglePick = (name) => {
        setPicked((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : prev.concat([name])))
      }

      // ── 自有机器人 ──────────────────────────────────────────────────────
      const ownRows = (channel) => (Array.isArray(ownBots?.[channel]) ? ownBots[channel] : [])

      const addOwn = (channel) => {
        const fields = ownFields?.[channel] ?? []
        const row = { name: '' }
        for (const field of fields) row[field.key] = ''
        setOwnBots((prev) => {
          const list = (Array.isArray(prev?.[channel]) ? prev[channel] : []).concat([row])
          // 新加的这条立刻展开，省得用户再点一次齿轮
          setOpenCard(channel + '|' + (list.length - 1))
          return { ...prev, [channel]: list }
        })
      }

      /**
       * 清掉某一行占着的「明码」缓存（v0.40.2）。
       *
       * revealed 的键是 `通道|名称|字段`（见 revealKeyOf）。名称是用户可改、
       * 也可复用的，而缓存按名称索引 —— 删掉「DSH 通知」再建一条同名的，
       * 键正好撞上，旧明文就被塞进只读输入框：用户既改不了也删不掉。
       *
       * 所以**删除与改名都必须把那份缓存一起清掉**，否则「删除」在语义上
       * 只是把行从表单里拿掉，内存里那份明文还活着等下一次同名复用。
       * 空名称也算：空名行的键是 `通道||字段`，同样是共享命名空间。
       */
      const clearRevealed = (channel, name) => {
        const prefix = channel + '|' + String(name ?? '') + '|'
        setRevealed((prev) => {
          const hits = Object.keys(prev).filter((k) => k.startsWith(prefix))
          if (hits.length === 0) return prev
          const next = { ...prev }
          for (const k of hits) delete next[k]
          return next
        })
      }

      /**
       * 移除一个账号。
       *
       * v0.26.2 修的缺陷：删掉最后一个账号后，这里原来是 `delete next[channel]` ——
       * 于是提交给后端的 own_bots 里就没有这个通道的键了。而后端 mergeUserConfig
       * 把「键不存在」理解成「前端这次没提到这个通道」，走 continue 保留旧值，
       * 结果磁盘上的账号原封不动，用户回到界面又看到它。
       *
       * 现在改成保留键 + 空数组：这是一个**明确的**「这个通道我一条账号都不剩了」。
       * 后端收到空数组会走 `delete own[channel]`，整条落盘消失。
       * 十二个通道（含群晖）都走同一条 own_bots 路径，改这一处全部生效。
       */
      const dropOwn = (channel, index) => {
        // v0.40.2：删行同时把它占着的明码缓存清掉。
        // 不取名称就清不掉 —— 缓存键里带着名称，而行马上就不在了，
        // 之后再想反查「刚才删的那条叫什么」已经没处可问。
        setOwnBots((prev) => {
          const list = (Array.isArray(prev?.[channel]) ? prev[channel] : [])
          const gone = list[index]
          if (gone !== undefined) clearRevealed(channel, gone?.name ?? '')
          return { ...prev, [channel]: list.filter((_, i) => i !== index) }
        })
      }

      /**
       * 改一行的若干字段。
       *
       * v0.40.2：改到 name 时必须把旧名占着的明码缓存清掉。
       * 否则「A 点了明码 → 改名成 B → 又改回 A」这条路径下，
       * 旧明文会从缓存里原样冒出来 —— 删除路径已经堵了，改名路径也得堵。
       */
      const patchOwn = (channel, index, patch) => {
        setOwnBots((prev) => {
          const list = (Array.isArray(prev?.[channel]) ? prev[channel] : [])
          const old = list[index]
          const renamed = patch !== null && typeof patch === 'object' && Object.hasOwn(patch, 'name')
            && String(patch.name ?? '') !== String(old?.name ?? '')
          if (renamed) clearRevealed(channel, old?.name ?? '')
          return {
            ...prev,
            [channel]: list.map((item, i) => (i === index ? { ...item, ...patch } : item)),
          }
        })
      }

      // ── 多投递目标（v0.14.0）────────────────────────────────────────────
      // 一个机器人可以同时发到多个会话。数据结构是 acc.targets 数组，第一条同步写回
      // acc.target —— 老通道实现（以及 targetsOf 的回落）只认单个目标。
      const targetsOfRow = (item) => {
        const list = Array.isArray(item?.targets) ? item.targets.filter((x) => x !== null && typeof x === 'object') : []
        if (list.length > 0) return list
        return [item?.target ?? { kind: 'user', id: '' }]
      }
      /** 写第 idx 条目标：同时把第一条同步到 target，保证后端与老通道都能读到。 */
      const patchTarget = (channel, rowIndex, idx, patch) => {
        setOwnBots((prev) => {
          const list = (Array.isArray(prev?.[channel]) ? prev[channel] : []).map((item, i) => {
            if (i !== rowIndex) return item
            const targets = targetsOfRow(item).map((t, k) => (k === idx ? { ...t, ...patch } : t))
            return { ...item, targets, target: targets[0] }
          })
          return { ...prev, [channel]: list }
        })
      }
      const addTarget = (channel, rowIndex, preset) => {
        setOwnBots((prev) => {
          const list = (Array.isArray(prev?.[channel]) ? prev[channel] : []).map((item, i) => {
            if (i !== rowIndex) return item
            const targets = targetsOfRow(item)
            const extra = preset !== null && typeof preset === 'object' ? preset : { kind: 'user', id: '' }
            if (targets.some((t) => String(t?.id ?? '').trim() === String(extra.id ?? '').trim() && String(extra.id ?? '').trim() !== '')) return item
            const next = targets.concat([{ kind: extra.kind === 'group' ? 'group' : 'user', id: String(extra.id ?? '') }])
            return { ...item, targets: next, target: next[0] }
          })
          return { ...prev, [channel]: list }
        })
      }
      const dropTarget = (channel, rowIndex, idx) => {
        setOwnBots((prev) => {
          const list = (Array.isArray(prev?.[channel]) ? prev[channel] : []).map((item, i) => {
            if (i !== rowIndex) return item
            const targets = targetsOfRow(item).filter((_, k) => k !== idx)
            // 至少留一条空行，否则界面上就没有「发送到」这一格了
            const next = targets.length > 0 ? targets : [{ kind: 'user', id: '' }]
            return { ...item, targets: next, target: next[0] }
          })
          return { ...prev, [channel]: list }
        })
      }

      // ── 扫码接入 ────────────────────────────────────────────────────────
      const startQr = async (channel) => {
        setQrBusy(true)
        setError('')
        setNotice('')
        setProgress(30)
        try {
          const data = await call('POST', '/qr/start', { channel })
          if (data.ok !== true) throw new Error(data.error ?? '扫码启动失败')
          setQrSession(data)
          setView('qr')
          setProgress(100)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setQrBusy(false)
          window.setTimeout(() => setProgress(0), 400)
        }
      }

      const cancelQr = async () => {
        const id = qrSession?.sessionId ?? ''
        setQrSession(null)
        if (id === '') return
        try {
          await call('POST', '/qr/cancel', { sessionId: id })
        } catch {
          // 取消失败无所谓：会话有 10 分钟 TTL
        }
      }

      const applyQr = async () => {
        const id = qrSession?.sessionId ?? ''
        if (id === '') return
        setQrBusy(true)
        setError('')
        setProgress(50)
        const snapshot = ownBots
        try {
          const data = await call('POST', '/qr/apply', { sessionId: id })
          if (data.ok !== true) throw new Error(data.error ?? '保存失败')
          const added = typeof data.account === 'string' ? data.account : String(data?.account?.name ?? '')
          setQrSession(null)
          setQrUndo({ snapshot, channel: String(data.channel ?? ''), name: added })
          setNotice('已自动保存到自有机器人：' + ((CHANNEL_TITLES[data.channel] ?? data.channel) + ' · ' + added))
          setProgress(100)
          await reload()
          if (data.channel) {
            setSelectedChannel(String(data.channel))
            setView('channel')
          }
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setQrBusy(false)
          window.setTimeout(() => setProgress(0), 500)
        }
      }

      const undoQr = async () => {
        if (qrUndo === null) return
        const snapshot = qrUndo.snapshot ?? {}
        setQrBusy(true)
        try {
          await applySave({ default_channels: picked, own_bots: snapshot }, true)
          setQrUndo(null)
          setNotice('已撤销扫码添加')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setQrBusy(false)
        }
      }

      const qrSessionId = qrSession?.sessionId ?? ''
      const qrPhase = qrSession?.phase ?? ''
      const qrAppliedRef = useRef('')
      useEffect(() => {
        if (qrPhase !== 'success') return
        const id = qrSessionId
        if (id === '' || qrAppliedRef.current === id) return
        qrAppliedRef.current = id
        void applyQr()
      })

      useEffect(() => {
        if (qrSessionId === '') return undefined
        if (qrPhase !== 'waiting' && qrPhase !== 'scanned') return undefined
        const timer = window.setInterval(async () => {
          try {
            const data = await call('GET', '/qr/poll?sessionId=' + encodeURIComponent(qrSessionId))
            if (data.ok === true) setQrSession(data)
          } catch {
            // 网络抖动：本轮跳过
          }
        }, 1500)
        return () => window.clearInterval(timer)
      }, [qrSessionId, qrPhase])

      // ── 自动保存 ────────────────────────────────────────────────────────
      const buildPayload = useCallback(() => ({
        default_channels: picked,
        own_bots: ownBots,
        proxy,
        channel_visibility: visibility,
      }), [picked, ownBots, proxy, visibility])

      const applySave = useCallback(async (payload, reloadAfter) => {
        if (savingRef.current) {
          pendingRef.current = true
          return false
        }
        savingRef.current = true
        setSaving(true)
        try {
          const data = await call('POST', '/config', payload)
          if (data.ok !== true) throw new Error(data.error ?? '保存失败')
          setSaveStatus({ state: 'saved', at: new Date().toLocaleTimeString('zh-CN'), error: '' })
          setError('')
          if (reloadAfter === true) await reload()
          return true
        } catch (err) {
          const message = String(err?.message ?? err)
          setSaveStatus({ state: 'failed', at: '', error: message })
          return false
        } finally {
          savingRef.current = false
          setSaving(false)
          if (pendingRef.current) {
            pendingRef.current = false
            window.setTimeout(() => { autoSaveRef.current?.() }, 0)
          }
        }
      }, [reload])

      const autoSaveRef = useRef(null)
      autoSaveRef.current = () => {
        if (!hydrated.current) return
        void applySave(buildPayload(), false)
      }

      useEffect(() => {
        if (!hydrated.current) return undefined
        if (autoTimer.current !== null) window.clearTimeout(autoTimer.current)
        autoTimer.current = window.setTimeout(() => {
          autoTimer.current = null
          void applySave(buildPayload(), false)
        }, 600)
        return () => {
          if (autoTimer.current !== null) {
            window.clearTimeout(autoTimer.current)
            autoTimer.current = null
          }
        }
      }, [picked, ownBots, proxy, applySave, buildPayload])

      // ── 逐账号探测 / 测试 / 获取会话 ────────────────────────────────────
      const testKey = (channel, name) => channel + '|' + String(name)
      const setTestState = (key, patch) => setAccountTests((prev) => ({ ...prev, [key]: { ...(prev?.[key] ?? {}), ...patch } }))
      const nowText = () => new Date().toLocaleTimeString('zh-CN')

      const probeOne = async (channel, name) => {
        const key = testKey(channel, name)
        setTestState(key, { busy: true, ok: null, detail: '探测中…', kind: 'probe' })
        try {
          const data = await call('POST', '/probe/account', { channel, account: name })
          setTestState(key, {
            busy: false,
            ok: data.ok === true,
            detail: String(data.detail ?? '') + (data.supported === false ? '（该通道不支持只读探测）' : ''),
            kind: 'probe',
            at: nowText(),
          })
        } catch (err) {
          setTestState(key, { busy: false, ok: false, detail: String(err?.message ?? err), kind: 'probe', at: nowText() })
        }
      }

      const testTextState = useState('推送中枢测试消息')
      const testText = testTextState[0]
      const setTestText = testTextState[1]

      // v0.20.0：试发页也能带按钮。
      // 存的是「按钮 JSON 原文」而不是解析后的对象 —— 用户边打字边看到自己的
      // 输入，解析交给后端（buttons.js），坏格式由后端报错，前端不重复实现一遍校验，
      // 免得两边规则漂移。
      const testButtonsState = useState('')
      const testButtons = testButtonsState[0]
      const setTestButtons = testButtonsState[1]
      const [buttonChannels, setButtonChannels] = useState([])
      // v0.25.0：要引用回复的那条消息 ID（留空 = 当新消息发）。
      const replyToState = useState('')
      const replyTo = replyToState[0]
      const setReplyTo = replyToState[1]
      const [replyChannels, setReplyChannels] = useState([])

      const testOne = async (channel, name) => {
        const key = testKey(channel, name)
        setTestState(key, { busy: true, ok: null, detail: '发送中…', kind: 'send' })
        try {
          const data = await call('POST', '/test/account', { channel, account: name, text: testText })
          setTestState(key, {
            busy: false,
            ok: data.ok === true,
            detail: String(data.detail ?? '') || (data.ok === true ? '已发送' : '发送失败'),
            kind: 'send',
            at: nowText(),
          })
        } catch (err) {
          setTestState(key, { busy: false, ok: false, detail: String(err?.message ?? err), kind: 'send', at: nowText() })
        }
      }

      /**
       * 给某个账号发一个文件（v0.18.0）。
       *
       * 先用 ref 拿 prompt 让用户填绝对路径，而不是在卡里塞一个 input：
       * 文件路径很长、又不该被存进配置（配置是账号级设置，不是一次性参数），
       * 塞进卡里还会跟着「保存」一起写进 config.json。
       */
      const sendFileOne = async (channel, name) => {
        const key = testKey(channel, name)
        const input = window.prompt('要发的文件绝对路径（例 D:\\报告\\周报.pdf）', '')
        if (input === null) return
        const filePath = String(input).trim()
        if (filePath === '') return
        setFileState((prev) => ({ ...prev, busy: { ...prev.busy, [key]: true }, note: { ...prev.note, [key]: '发送中…' } }))
        try {
          await applySave(buildPayload(), false)
          const data = await call('POST', '/send/file/account', { channel, account: name, filePath })
          setFileState((prev) => ({
            ...prev,
            busy: { ...prev.busy, [key]: false },
            note: { ...prev.note, [key]: (data.ok === true ? '✓ ' : '✗ ') + String(data.detail ?? '') },
            at: { ...prev.at, [key]: nowText() },
          }))
        } catch (err) {
          setFileState((prev) => ({
            ...prev,
            busy: { ...prev.busy, [key]: false },
            note: { ...prev.note, [key]: '✗ ' + String(err?.message ?? err) },
            at: { ...prev.at, [key]: nowText() },
          }))
        }
      }


      /**
       * 改一条已经发出去的消息（v0.29.0）。
       *
       * 为什么用 prompt 而不是在列表里就地编辑：发件箱是「已发生的记录」，
       * 就地改容易让人以为改的是记录本身。用弹窗问一句「改成什么」，
       * 语义清楚 —— 改的是远处那条消息，不是这行文字。
       */
      const editSent = async (entry, messageId, chatId) => {
        const channel = String(entry?.channel ?? '')
        const target = String(messageId ?? '').trim()
        const place = String(chatId ?? '').trim()
        if (channel === '' || target === '') return
        const input = window.prompt('把这条消息改成什么？（清空正文不等于删消息，要删请用「撤回」）', String(entry?.text ?? ''))
        if (input === null) return
        const text = String(input)
        if (text.trim() === '') {
          setOutboxState((prev) => ({ ...prev, note: '改成的正文不能为空 —— 要清掉请用「撤回」' }))
          return
        }
        setOutboxState((prev) => ({ ...prev, note: '正在改 ' + target + '…' }))
        try {
          await applySave(buildPayload(), false)
          const data = await call('POST', '/send/edit', {
            channel,
            account: entry?.account ?? undefined,
            messageId: target,
            text,
            ...(place === '' ? {} : { chatId: place }),
          })
          setOutboxState((prev) => ({ ...prev, note: (data.ok === true ? '✓ ' : '✗ ') + channel + ' ' + target + '：' + String(data.detail ?? '') }))
        } catch (err) {
          setOutboxState((prev) => ({ ...prev, note: '✗ ' + String(err?.message ?? err) }))
        }
      }

      /** 撤回一条已经发出去的消息（v0.29.0）。不可逆，所以必须先问一句。 */
      const deleteSent = async (entry, messageId, chatId) => {
        const channel = String(entry?.channel ?? '')
        const target = String(messageId ?? '').trim()
        const place = String(chatId ?? '').trim()
        if (channel === '' || target === '') return
        const NL = String.fromCharCode(10)
        if (!window.confirm('撤回 ' + channel + ' 的这条消息（' + target + '）？' + NL + '撤回之后对方那边就没了，不可撤销。')) return
        setOutboxState((prev) => ({ ...prev, note: '正在撤回 ' + target + '…' }))
        try {
          await applySave(buildPayload(), false)
          const data = await call('POST', '/send/delete', {
            channel,
            account: entry?.account ?? undefined,
            messageId: target,
            ...(place === '' ? {} : { chatId: place }),
          })
          setOutboxState((prev) => ({ ...prev, note: (data.ok === true ? '✓ ' : '✗ ') + channel + ' ' + target + '：' + String(data.detail ?? '') }))
        } catch (err) {
          setOutboxState((prev) => ({ ...prev, note: '✗ ' + String(err?.message ?? err) }))
        }
      }

      /**
       * 给一条已发出的消息加表情回应（v0.30.0）。
       *
       * 输入框的默认值按通道给：Slack 默认 thumbsup（它只认名字），
       * 其余默认 👍。**不替用户猜** —— 他改成什么都原样发出去。
       */
      const reactSent = async (entry, messageId, chatId) => {
        const channel = String(entry?.channel ?? '')
        const target = String(messageId ?? '').trim()
        const place = String(chatId ?? '').trim()
        if (channel === '' || target === '') return
        const hint = channel === 'slack'
          ? 'Slack 认的是表情名字，不是字符。填 thumbsup / tada / eyes 这类名字。'
          : '填一个 emoji（例如 👍）。Discord 的自定义表情要写 name:id。'
        const input = window.prompt(hint, channel === 'slack' ? 'thumbsup' : '👍')
        if (input === null) return
        const emoji = String(input).trim()
        if (emoji === '') {
          setOutboxState((prev) => ({ ...prev, note: '要给表情' }))
          return
        }
        setOutboxState((prev) => ({ ...prev, note: '正在给 ' + target + ' 加 ' + emoji + '…' }))
        try {
          await applySave(buildPayload(), false)
          const data = await call('POST', '/send/react', {
            channel,
            account: entry?.account ?? undefined,
            messageId: target,
            emoji,
            ...(place === '' ? {} : { chatId: place }),
          })
          setOutboxState((prev) => ({ ...prev, note: (data.ok === true ? '✓ ' : '✗ ') + channel + ' ' + target + '：' + String(data.detail ?? '') }))
        } catch (err) {
          setOutboxState((prev) => ({ ...prev, note: '✗ ' + String(err?.message ?? err) }))
        }
      }

      /**
       * 去掉表情回应（v0.30.0）。
       *
       * Matrix 这里必须填**回应事件 id**，不是原消息 id —— 它的表情本身是一个
       * 独立事件，只能撤回那个事件。提示文案按通道换，免得用户填错还以为是 bug。
       */
      const unreactSent = async (entry, messageId, chatId) => {
        const channel = String(entry?.channel ?? '')
        const target = String(messageId ?? '').trim()
        const place = String(chatId ?? '').trim()
        if (channel === '' || target === '') return
        const hint = channel === 'matrix'
          ? 'Matrix 要去掉表情，得填「回应事件 id」（加表情时返回的那个 $ 开头 id）—— 它的表情是独立事件，撤它才能去掉。'
          : channel === 'telegram'
            ? 'Telegram 没有「只删某一个」的接口：留空会把机器人挂的表情一次清空。'
            : '要去掉哪个表情？（Slack 填名字，例如 thumbsup）'
        const input = window.prompt(hint, channel === 'slack' ? 'thumbsup' : '')
        if (input === null) return
        setOutboxState((prev) => ({ ...prev, note: '正在去掉 ' + target + ' 上的表情…' }))
        try {
          await applySave(buildPayload(), false)
          const data = await call('POST', '/send/unreact', {
            channel,
            account: entry?.account ?? undefined,
            messageId: target,
            emoji: String(input).trim(),
            ...(place === '' ? {} : { chatId: place }),
          })
          setOutboxState((prev) => ({ ...prev, note: (data.ok === true ? '✓ ' : '✗ ') + channel + ' ' + target + '：' + String(data.detail ?? '') }))
        } catch (err) {
          setOutboxState((prev) => ({ ...prev, note: '✗ ' + String(err?.message ?? err) }))
        }
      }

      /**
       * 「获取会话」：让用户从下拉里选，而不是对着空白框猜 chat_id。
       *
       * 必须先 flush 一次保存：/targets 读的是磁盘上的账号（含刚填的 token），
       * 600ms 防抖还没落盘时会「找不到账号」，那提示会非常费解。
       */
      const loadTargets = async (channel, name) => {
        const key = testKey(channel, name)
        setTargetLists((prev) => ({ ...prev, [key]: { busy: true, items: [], note: '' } }))
        try {
          await applySave(buildPayload(), false)
          const data = await call('POST', '/targets', { channel, account: name })
          setTargetLists((prev) => ({
            ...prev,
            [key]: { busy: false, items: Array.isArray(data.items) ? data.items : [], note: String(data.note ?? '') },
          }))
        } catch (err) {
          setTargetLists((prev) => ({ ...prev, [key]: { busy: false, items: [], note: '获取失败：' + String(err?.message ?? err) } }))
        }
      }

      // ── 接收（v0.15.0）─────────────────────────────────────────────────
      /** 读接收状态 + 收件箱。任何失败都落到 note 里，不弹错误。 */
      const loadReceive = async (quiet) => {
        setRecv((prev) => ({ ...prev, loading: quiet !== true }))
        try {
          const [st, box] = await Promise.all([call('GET', '/receive/status'), call('GET', '/receive/inbox?limit=100')])
          setRecv((prev) => ({
            ...prev,
            loading: false,
            receivable: Array.isArray(st?.receivable) ? st.receivable.map(String) : [],
            status: Array.isArray(st?.status) ? st.status : [],
            blocked: st?.blocked && typeof st.blocked === 'object' ? st.blocked : {},
            inboxPath: String(box?.path ?? prev.inboxPath),
            messages: Array.isArray(box?.messages) ? box.messages : [],
            note: '',
          }))
        } catch (err) {
          setRecv((prev) => ({ ...prev, loading: false, note: '读取接收状态失败：' + String(err?.message ?? err) }))
        }
      }

      /** 开 / 关某个通道的接收。startsWith 阶段先把账号落盘，免得收到旧配置。 */
      const toggleReceive = async (channel, on) => {
        setRecv((prev) => ({ ...prev, busy: channel, note: '' }))
        try {
          await applySave(buildPayload(), false)
          const data = await call('POST', on ? '/receive/start' : '/receive/stop', { channel })
          setNotice(data?.ok === true
            ? (on ? '「' + (CHANNEL_TITLES[channel] ?? channel) + '」开始接收' : '「' + (CHANNEL_TITLES[channel] ?? channel) + '」已停止接收')
            : '')
          setRecv((prev) => ({ ...prev, busy: '', note: data?.ok === true ? '' : String(data?.detail ?? data?.error ?? '操作失败') }))
          await loadReceive(true)
        } catch (err) {
          setRecv((prev) => ({ ...prev, busy: '', note: String(err?.message ?? err) }))
        }
      }

      const clearInbox = async () => {
        setRecv((prev) => ({ ...prev, busy: 'inbox', note: '' }))
        try {
          await call('POST', '/receive/inbox/clear')
          await loadReceive(true)
          setNotice('收件箱已清空')
        } catch (err) {
          setRecv((prev) => ({ ...prev, busy: '', note: String(err?.message ?? err) }))
        } finally {
          setRecv((prev) => ({ ...prev, busy: '' }))
        }
      }

      const save = async () => {
        setProgress(40)
        setError('')
        setNotice('')
        const ok = await applySave(buildPayload(), true)
        setProgress(ok ? 100 : 0)
        window.setTimeout(() => setProgress(0), 500)
      }

      // ── 试发 ────────────────────────────────────────────────────────────
      const [testResult, setTestResult] = useState(null)
      const [testing, setTesting] = useState(false)

      const runTest = async (dryRun) => {
        setTesting(true)
        setProgress(35)
        setTestResult(null)
        setError('')
        try {
          const data = await call('POST', '/test', {
            text: testText,
            channels: picked.length > 0 ? picked : undefined,
            buttons: testButtons.trim() === '' ? undefined : testButtons,
            replyTo: replyTo.trim() === '' ? undefined : replyTo.trim(),
            dry_run: dryRun === true,
          })
          setProgress(100)
          setTestResult(data)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setTesting(false)
          window.setTimeout(() => setProgress(0), 500)
        }
      }

      // ── 渲染小件 ────────────────────────────────────────────────────────
      const logo = (channel, cls) => h('span', {
        className: (cls ?? 'dph-logo') + ' ' + (LOGO_CLASS[channel] ?? ''),
        'aria-hidden': 'true',
      }, LOGO_TEXT[channel] ?? '?')

      const badge = (tone, text) => h('span', { className: 'dph-badge', 'data-tone': tone }, text)

      /**
       * 密钥明码：平时只看指纹（前 6 位…后 4 位），点「明码」才向插件要一次原文。
       *
       * 为什么单独走接口而不是直接用掩码串：后端返回给浏览器的从来不是真 token
       * （index.js 用 fingerprintSecret 处理过），想看到全文只能问 POST /reveal。
       * 明文只存这个 state，**绝不回写 ownBots** —— 否则 600ms 后的自动保存
       * 会把明文当成新值再存一遍盘，掩码就白做了。
       */
      const revealKeyOf = (channel, name, key) => channel + '|' + name + '|' + key

      const toggleReveal = async (channel, name, key) => {
        const k = revealKeyOf(channel, name, key)
        if (revealed[k] !== undefined) {
          setRevealed((prev) => { const next = { ...prev }; delete next[k]; return next })
          return
        }
        setError('')
        try {
          const data = await call('POST', '/reveal', { channel, account: name, key })
          if (data.ok !== true) throw new Error(data.error ?? '取不到明文')
          setRevealed((prev) => ({ ...prev, [k]: String(data.value ?? '') }))
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }

      /** 卡内一行字段：标签 + 控件（可带尾部附加控件）。 */
      const field = (label, control, tail) => h('div', { className: tail ? 'dph-fieldWide' : 'dph-field', key: label },
        h('label', null, label),
        control,
        tail ?? null,
      )

      /** 折叠体：点齿轮才展开，grid-template-rows 0fr→1fr 做高度动画。 */
      const collapsible = (open, children) => h('div', { className: 'dph-collapsible', 'data-open': open ? 'true' : 'false' },
        h('div', { className: 'dph-collapsibleBody' },
          h('div', { className: 'dph-collapsibleBodyInner' }, children),
        ),
      )

      // ── 渲染：左栏 ──────────────────────────────────────────────────────
      const channelKeys = Object.keys(ownFields).length > 0 ? Object.keys(ownFields) : CHANNEL_ORDER

      // ── 可见通道（v0.26.0）─────────────────────────────────────────────
      //
      // 三道过滤，顺序不能反：
      //   1. channelKeys 决定「存在哪些通道」（后端给了字段的，或内置顺序兜底）
      //   2. mode==='bound' 时只留「有账号」的 —— 账号数取后端 channels 的 accounts 长度，
      //      取不到再回落本地的 ownRows（账号刚加上还没 reload 的那一瞬间）
      //   3. 最后统一减去 hidden
      //
      // 第 3 步必须在最后：用户手动隐藏一条「本来就没账号」的通道时，
      // 顺序反了会让它在 bound 模式下又冒出来。
      const accountCountOf = (channel) => {
        const info = channels.find((c) => String(c?.name) === channel)
        const fromServer = Array.isArray(info?.accounts) ? info.accounts.length : -1
        return fromServer >= 0 ? fromServer : ownRows(channel).length
      }

      const visMode = visibility?.mode === 'bound' ? 'bound' : 'all'
      const hiddenSet = new Set(Array.isArray(visibility?.hidden) ? visibility.hidden.map(String) : [])
      const visibleChannelKeys = channelKeys.filter((channel) => {
        if (hiddenSet.has(channel)) return false
        if (visMode === 'bound' && accountCountOf(channel) === 0) return false
        return true
      })

      // 当前选中的通道被隐藏（或被 bound 模式筛掉）时，自动落到第一个还看得见的通道。
      // 否则右侧会停在一个左侧列表里根本不存在的通道上，用户会以为界面卡住了。
      const effectiveSelected = visibleChannelKeys.includes(selectedChannel)
        ? selectedChannel
        : (visibleChannelKeys[0] ?? '')

      const railChannels = visibleChannelKeys.map((channel) => {
        const rows = ownRows(channel)
        const total = accountCountOf(channel)
        const on = view === 'channel' && effectiveSelected === channel
        return h('button', {
          key: channel,
          type: 'button',
          className: 'dph-channel',
          'aria-selected': on ? 'true' : 'false',
          onClick: () => { setView('channel'); setSelectedChannel(channel) },
        },
          logo(channel),
          h('span', { className: 'dph-channelCopy' },
            h('strong', null, CHANNEL_TITLES[channel] ?? channel),
            h('span', { className: 'dph-channelNote' }, total > 0 ? total + ' 个账号' : '未配置'),
          ),
        )
      })

      const railTools = EXTRA_NAV.map((item) => {
        const on = view === item.key
        return h('button', {
          key: item.key,
          type: 'button',
          className: 'dph-tool',
          'aria-selected': on ? 'true' : 'false',
          onClick: () => setView(item.key),
        }, item.label)
      })

      const rail = h('div', { className: 'dph-rail' },
        h('div', { className: 'dph-railHead' }, '通道'),
        railChannels.length > 0
          ? railChannels
          : h('div', { className: 'dph-empty', style: { padding: '8px 6px', fontSize: 11.5, margin: 0 } },
              '通道都被隐藏了。去「通道显示」里放开几条，或把模式切回「全部显示」。'),
        h('div', { className: 'dph-railDivider' }),
        h('div', { className: 'dph-railHead' }, '工具'),
        railTools,
      )

      // ── 渲染：通道详情 ──────────────────────────────────────────────────
      const channelDetail = (channel) => {
        const rows = ownRows(channel)
        const fields = ownFields[channel] ?? []
        const meta = targetMeta?.[channel] ?? {}
        const kinds = Array.isArray(meta?.kinds) ? meta.kinds : []
        const isDefault = picked.includes(channel)
        const info = channels.find((c) => String(c?.name) === channel)
        const bestEffort = info?.bestEffort === true
        const merged = Array.isArray(info?.accounts) ? info.accounts : []

        // 「N / N 运行正常」：只统计自有机器人里探测通过的
        let checkedOk = 0
        let checkedAll = 0
        for (let i = 0; i < rows.length; i += 1) {
          const st = accountTests?.[testKey(channel, rows[i]?.name ?? '')]
          if (st !== undefined && st !== null && st.busy !== true && st.ok !== null) {
            checkedAll += 1
            if (st.ok === true) checkedOk += 1
          }
        }
        const onlineText = rows.length === 0
          ? '未接入机器人'
          : (checkedAll === 0 ? rows.length + ' 个账号 · 未检查' : checkedOk + ' / ' + rows.length + ' 运行正常')
        const onlineTone = rows.length === 0 ? 'muted' : (checkedAll > 0 && checkedOk === rows.length ? 'success' : checkedAll > 0 ? 'warn' : 'muted')

        const pageHead = h('div', { className: 'dph-pageHead' },
          h('div', { className: 'dph-pageHeadText' },
            h('h2', { className: 'dph-pageTitle' },
              CHANNEL_TITLES[channel] ?? channel,
              h('span', {
                className: 'dph-helpDot',
                title: OWN_HINTS[channel] ?? '',
                'aria-label': '凭据去哪拿',
              }, '?'),
              bestEffort ? badge('warn', '尽力而为') : null,
            ),
            h('p', { className: 'dph-pageHint' }, OWN_HINTS[channel] ?? ''),
          ),
          h('span', { className: 'dph-onlineBadge', 'data-tone': onlineTone }, onlineText),
        )

        const actions = h('div', { className: 'dph-actions' },
          h('button', {
            type: 'button',
            className: 'dph-btnPrimary',
            disabled: qrBusy || saving,
            onClick: () => startQr(channel),
          }, '扫码接入机器人'),
          h('button', {
            type: 'button',
            className: 'dph-btnSecondary',
            disabled: saving,
            onClick: () => addOwn(channel),
          }, '手动接入'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('label', { className: 'dph-check' },
            h('input', { type: 'checkbox', checked: isDefault, onChange: () => togglePick(channel) }),
            '设为默认推送',
          ),
        )

        const summaryNote = merged.length === 0
          ? h('p', { className: 'dph-cardNote' }, '这个通道还没有任何可用账号。点上面的「扫码接入机器人」或「手动接入」加一个。')
          : h('p', { className: 'dph-cardNote' },
              '可发账号 ' + merged.length + ' 个：' + merged.join('、'))

        const cards = rows.map((item, i) => {
          const target = item?.target ?? { kind: 'user', id: '' }
          const targetList = targetsOfRow(item)
          const mention = item?.mention ?? { mode: 'none', userIds: [] }
          const tkey = testKey(channel, item?.name ?? '')
          const st = accountTests?.[tkey] ?? null
          const tl = targetLists?.[tkey] ?? null
          const cardKey = channel + '|' + i
          const open = openCard === cardKey
          const name = String(item?.name ?? '')
          const tone = st === null || st === undefined ? 'idle' : st.busy === true ? 'idle' : st.ok === true ? 'success' : st.ok === false ? 'error' : 'idle'
          const healthText = st === null || st === undefined
            ? '未检查'
            : st.busy === true
              ? '检查中…'
              : st.ok === true
                ? '运行正常'
                : st.ok === false
                  ? (st.kind === 'send' ? '发送失败' : '连接失败')
                  : '未检查'
          const idText = String(target.id ?? '').trim() === '' ? '未设发送目标' : String(target.id)
          // 这张卡当前停在哪一页（默认「通用」）
          const tabList = botTabsForChannel(channel)
          const tabId = tabList.some((tab) => tab.id === cardTab[cardKey]) ? cardTab[cardKey] : 'general'
          const tabsBar = h('div', { className: 'dph-tabsBar' },
            h('div', { className: 'dph-tabsStrip', role: 'tablist', 'aria-label': (name === '' ? '未命名机器人' : name) + ' 的设置' },
              tabList.map((tab) => h('button', {
                key: tab.id,
                type: 'button',
                role: 'tab',
                className: 'dph-tab',
                'aria-selected': tab.id === tabId ? 'true' : 'false',
                onClick: () => setCardTab((prev) => ({ ...prev, [cardKey]: tab.id })),
              }, tab.label)),
            ),
          )

          // 群晖三种「整合」类型要填的东西完全不一样（字段名对齐群晖面板）：
          //   传入的 Webhook —— 一条带令牌的 URL（也可以只给 NAS 地址 + 令牌让后端拼）
          //   发出的 Webhook —— 群晖回调你的方向，只登记 URL / 令牌 / 频道 / 触发字，本插件不发送
          //   机器人         —— 传入 URL 用来发；NAS + 令牌 + 数字用户 ID 是点对点发的必需品
          // 九个框全铺开人会不知道填哪几个，所以按 type 只留相关的。
          const synType = normalizeSynType(item?.type)
          // 「高级」页的字段（代理 / 分块长度 / 块间延迟 / 自签证书）不受群晖按类型过滤的影响 ——
          // 它们跟哪种整合无关，永远可填。
          const visibleFields = channel !== 'synology_chat'
            ? fields
            : fields.filter((f) => f.group === 'advanced' || f.key === 'type' || SYN_FIELDS[synType].includes(f.key))
          // v0.17.0：高级字段挪到第四页，通用页只留名称与凭据。
          const generalFields = visibleFields.filter((f) => f.group !== 'advanced')
          const advancedFields = visibleFields.filter((f) => f.group === 'advanced')

          return h('li', { key: cardKey },
            h('div', { className: 'dph-botCard' },
              h('div', { className: 'dph-botCardBody' },
                h('div', { className: 'dph-botCardTop' },
                  h('div', { className: 'dph-botIdentity' },
                    logo(channel, 'dph-botAvatar ' + (LOGO_CLASS[channel] ?? '')),
                    h('div', { className: 'dph-botName' },
                      h('div', { className: 'dph-nameRow' },
                        h('h3', { title: name === '' ? '未命名' : name }, name === '' ? '未命名机器人' : name),
                        h('button', {
                          type: 'button',
                          className: 'dph-aliasEdit',
                          title: '改个名字',
                          disabled: saving,
                          onClick: () => {
                            setOpenCard(cardKey)
                            const el = nameRefs.current?.[cardKey]
                            if (el !== undefined && el !== null && typeof el.focus === 'function') el.focus()
                          },
                        }, h('span', { className: 'dph-aliasEditIcon' }, ICONS.pencil())),
                        item.imported_from === 'qr' ? badge('success', '扫码') : null,
                        item.stale === true ? badge('error', '可能已过期') : null,
                      ),
                      h('p', { title: idText }, idText),
                    ),
                  ),
                  h('div', { className: 'dph-botCardTools' },
                    h('div', { className: 'dph-botHealthGroup' },
                      h('span', { className: 'dph-health' },
                        h('span', { className: 'dph-healthDot', 'data-tone': tone }),
                        healthText,
                      ),
                      h('span', { className: 'dph-lastChecked' },
                        '最近检查 ',
                        st?.at !== undefined && st?.at !== '' ? String(st.at) : '—',
                      ),
                    ),
                    h('button', {
                      type: 'button',
                      className: 'dph-botSettingsButton',
                      'aria-expanded': open ? 'true' : 'false',
                      title: open ? '收起设置' : '展开设置',
                      onClick: () => setOpenCard(open ? '' : cardKey),
                    }, '设置', h('span', { className: 'dph-moreSettingsChevron' })),
                  ),
                ),
                collapsible(open,
                  h('div', null,
                    tabsBar,
                    // 三个标签页：通用（名称+凭据）、投递设置（发送到）、访问设置（@ 提醒）。
                    // 「检查凭据 / 发条测试消息」不放进标签页 —— 任何时候都可能想验一下，常驻在下面。
                    tabId === 'general'
                      ? h('div', { className: 'dph-tabPanel', role: 'tabpanel' },
                    field('名称',
                      h('input', {
                        className: 'dph-input dph-nameInput',
                        ref: (el) => { nameRefs.current[cardKey] = el },
                        value: name,
                        placeholder: '给这个机器人起个名字',
                        onChange: (e) => patchOwn(channel, i, { name: e.target.value }),
                      }),
                      h('button', { type: 'button', className: 'dph-btnDanger', disabled: saving, onClick: () => dropOwn(channel, i) }, '移除'),
                    ),
                    generalFields.map((f) => {
                      // 这个字段是否被点过「明码」（有值就是明文，没有就是掩码/指纹）
                      const shownSecret = revealed[revealKeyOf(channel, item?.name ?? '', f.key)]
                      return field(f.label,
                      f.key === 'type' && channel === 'synology_chat'
                        ? h('select', {
                            key: f.key,
                            className: 'dph-select',
                            value: synType,
                            onChange: (e) => patchOwn(channel, i, { type: e.target.value }),
                          },
                            h('option', { value: 'incoming' }, '传入的 Webhook（整合 → 往里发，只需 Webhook URL）'),
                            h('option', { value: 'outgoing' }, '发出的 Webhook（整合 → 群晖回调你的 URL，本插件不发送）'),
                            h('option', { value: 'bot' }, '机器人（整合 → 传入 URL / 传出 URL / 令牌）'),
                          )
                        : h('input', {
                            key: f.key,
                            className: 'dph-input',
                            // 明码时用 text + readOnly：既能看见全文，又不给 onChange 机会
                            // 把明文写回 ownBots（否则自动保存会把掩码覆盖成明文）。
                            type: f.secret === true && shownSecret === undefined ? 'password' : 'text',
                            value: f.secret === true && shownSecret !== undefined ? shownSecret : (item[f.key] ?? ''),
                            readOnly: f.secret === true && shownSecret !== undefined,
                            placeholder: f.placeholder ?? (f.secret === true ? '留空则不修改' : ''),
                            onChange: (e) => patchOwn(channel, i, { [f.key]: e.target.value }),
                          }),
                      f.secret === true
                        ? h('button', {
                            key: f.key + '_reveal',
                            type: 'button',
                            className: 'dph-btn',
                            disabled: saving,
                            title: shownSecret === undefined ? '显示完整密钥（只在本机浏览器内存里）' : '恢复成指纹显示',
                            onClick: () => { void toggleReveal(channel, item?.name ?? '', f.key) },
                          }, shownSecret === undefined ? '明码' : '隐藏')
                        : undefined)
                    }),
                      )
                      : null,
                    tabId === 'delivery'
                      ? h('div', { className: 'dph-tabPanel', role: 'tabpanel' },
                    // 发送到：永远渲染「类型下拉 + 手填输入框」，列表里有候选时再多给一个下拉供挑。
                    // 老版只在列表为空时渲染输入框 —— 一旦点过「获取会话」，用户就再也看不到输入框，
                    // 以为只能从列表里选（QQ 恒为空列表、飞书只列群，单聊就彻底没法填）。
                    kinds.length === 0
                      ? h('div', { className: 'dph-hintRow', 'data-tone': synType === 'outgoing' ? 'warn' : undefined },
                        synType === 'outgoing'
                          ? '「发出的 Webhook」没有发送目标 —— 它的方向是「群晖 → 你填的 URL」，本插件不会用它发消息；要发消息请把「类型」改成「传入的 Webhook」或「机器人」。'
                          : synType === 'bot'
                            ? '「机器人」不用在这里填目标 —— 它发的是「通用」页里那个「用户 ID」，只能点对点发。'
                            : '这个通道没有「发送到」—— 「传入的 Webhook」天然发到生成它的那个频道。')
                      : field('发送到',
                      h('div', { className: 'dph-targetBox' },
                        // v0.14.0：一个机器人可以发到多个会话。每行一个目标，第一行可删不掉（至少留一行）。
                        targetList.map((t, ti) => h('div', { key: ti, className: 'dph-targetRow' },
                          h('div', { className: 'dph-inline' },
                            h('select', {
                              className: 'dph-select',
                              value: t.kind,
                              onChange: (e) => patchTarget(channel, i, ti, { kind: e.target.value }),
                            }, kinds.map((k) => h('option', { key: k.value, value: k.value }, k.label))),
                            h('input', {
                              className: 'dph-input',
                              value: t.id ?? '',
                              placeholder: targetPlaceholder(channel, t.kind),
                              onChange: (e) => patchTarget(channel, i, ti, { id: e.target.value }),
                            }),
                            targetList.length > 1
                              ? h('button', {
                                  type: 'button', className: 'dph-btn dph-targetDrop', title: '删掉这个目标',
                                  onClick: () => dropTarget(channel, i, ti),
                                }, '删')
                              : null,
                          ),
                        )),
                        h('div', { className: 'dph-targetFoot' },
                          h('button', { type: 'button', className: 'dph-btn dph-targetAdd', onClick: () => addTarget(channel, i) }, '+ 再加一个目标'),
                          tl !== null && tl.items.length > 0
                            ? h('select', {
                                className: 'dph-select dph-targetPicker',
                                defaultValue: '',
                                onChange: (e) => {
                                  const pickedItem = tl.items.find((x) => String(x.id) === e.target.value)
                                  if (pickedItem !== undefined) addTarget(channel, i, { kind: pickedItem.kind, id: String(pickedItem.id) })
                                  e.target.selectedIndex = 0
                                },
                              },
                                h('option', { value: '' }, '— 从这 ' + tl.items.length + ' 个已列出的会话里挑一个加进来 —'),
                                tl.items.map((x) => h('option', { key: x.id, value: x.id }, String(x.label) + ' · ' + String(x.detail))),
                              )
                            : null,
                        ),
                      ),
                      h('button', { type: 'button', className: 'dph-btn', disabled: tl?.busy === true || saving, onClick: () => loadTargets(channel, name) },
                        tl?.busy === true ? '获取中…' : '获取会话'),
                    ),
                    kinds.length === 0 || targetList.every((t) => String(t?.id ?? '').trim() !== '') ? null
                      : h('div', { className: 'dph-hintRow', 'data-tone': 'warn' },
                          '还有目标没填收件人 —— 现在点「发条测试消息」会直接失败。凭据本身没问题，缺的只是收件人 ID。'),
                    kinds.length === 0 ? null : h('div', { className: 'dph-hintRow' }, String(meta?.hint ?? '')),
                    tl === null || (tl.note === '' && tl.items.length === 0) ? null
                      : h('div', {
                          className: 'dph-hintRow',
                          'data-tone': tl.items.length > 0 ? 'muted' : 'warn',
                        }, (tl.items.length > 0 ? '可发目标 ' + tl.items.length + ' 个。' : '') + tl.note),
                      )
                      : null,
                    tabId === 'access'
                      ? h('div', { className: 'dph-tabPanel', role: 'tabpanel' },
                    channel === 'synology_chat' ? null : field('@ 提醒',
                      h('div', { className: 'dph-inline' },
                        h('select', {
                          className: 'dph-select',
                          value: mention.mode,
                          onChange: (e) => patchOwn(channel, i, { mention: { ...mention, mode: e.target.value } }),
                        }, ['none', 'user', 'all'].map((m) => h('option', { key: m, value: m }, MENTION_LABELS[m]))),
                        mention.mode === 'user'
                          ? h('input', {
                              className: 'dph-input',
                              value: Array.isArray(mention.userIds) ? mention.userIds.join(',') : '',
                              placeholder: '要 @ 的成员 ID，多个用逗号分隔',
                              onChange: (e) => patchOwn(channel, i, {
                                mention: { ...mention, userIds: e.target.value.split(',').map((v) => v.trim()).filter((v) => v !== '') },
                              }),
                            })
                          : null,
                      ),
                    ),
                      )
                      : null,
                    tabId === 'advanced'
                      ? h('div', { className: 'dph-tabPanel', role: 'tabpanel' },
                    h('div', { className: 'dph-hintRow' }, '这些都是可选的。留空 = 用该通道的默认值，不影响发送。'),
                    advancedFields.map((f) => {
                      const raw = item?.[f.key]
                      if (f.type === 'boolean') {
                        // 复用既有 .dph-field 网格与 .dph-check —— 不新增样式类，
                        // 少一份要跟两份 CSS 同步的东西。
                        return field(f.label,
                          h('label', { className: 'dph-check', title: f.placeholder ?? '' },
                            h('input', {
                              type: 'checkbox',
                              checked: raw === true,
                              onChange: (e) => patchOwn(channel, i, { [f.key]: e.target.checked === true }),
                            }),
                            raw === true ? '已开启' : '未开启',
                          ),
                        )
                      }
                      const isNumber = f.type === 'number'
                      return field(f.label,
                        h('input', {
                          key: f.key,
                          className: 'dph-input',
                          type: isNumber ? 'number' : 'text',
                          // v0.35.0：perMinute 的 0 是「明确不限」，下限必须是 0 ——
                          // 沿用全局的 min=1 会让用户填 0 时浏览器直接拦下，
                          // 而那个 0 恰恰是关掉限流的唯一写法。
                          min: isNumber ? (f.key === 'perMinute' ? '0' : '1') : undefined,
                          value: raw === undefined || raw === null ? '' : String(raw),
                          placeholder: f.placeholder ?? '',
                          onChange: (e) => {
                            // 数字字段：空串 = 清掉（用通道默认），否则转成整数；
                            // 不转的话后端会收到 "1200" 这样的字符串，虽然也能用，
                            // 但界面回读时数字与字符串混在一起容易判断出错。
                            if (!isNumber) { patchOwn(channel, i, { [f.key]: e.target.value }); return }
                            const text = e.target.value.trim()
                            patchOwn(channel, i, { [f.key]: text === '' ? '' : Number(text) })
                          },
                        }),
                      )
                    }),
                      )
                      : null,
                    h('div', { className: 'dph-testRow' },
                      h('button', { type: 'button', className: 'dph-btn', disabled: st?.busy === true || saving, onClick: () => probeOne(channel, name) },
                        st?.kind === 'probe' && st?.busy === true ? '探测中…' : '检查凭据'),
                      h('button', { type: 'button', className: 'dph-btnPrimary', disabled: st?.busy === true || saving, onClick: () => testOne(channel, name) },
                        st?.kind === 'send' && st?.busy === true ? '发送中…' : '发条测试消息'),
                      // 只有真正实现了 sendFile 的通道才给这个按钮 —— 不然点了必然失败，
                      // 用户会以为是路径填错了，而不是「这个通道本来就不支持附件」。
                      (fileState.channels ?? []).includes(channel)
                        ? h('button', {
                            type: 'button',
                            className: 'dph-btn',
                            disabled: fileState.busy?.[tkey] === true || saving,
                            title: '发一个本地文件到「发送到」里的目标；文件路径不写进配置',
                            onClick: () => sendFileOne(channel, name),
                          }, fileState.busy?.[tkey] === true ? '发送中…' : '发个文件')
                        : null,
                      st === null || st.detail === undefined
                        ? null
                        : h('span', {
                            className: 'dph-testResult',
                            'data-tone': st.ok === true ? 'success' : st.ok === false ? 'error' : 'muted',
                          }, (st.ok === true ? '✓ ' : st.ok === false ? '✗ ' : '') + String(st.detail)),
                      fileState.note?.[tkey]
                        ? h('span', {
                            className: 'dph-testResult',
                            'data-tone': String(fileState.note[tkey]).startsWith('✗') ? 'error' : 'success',
                            title: '发文件结果（' + String(fileState.at?.[tkey] ?? '') + '）',
                          }, String(fileState.note[tkey]))
                        : null,
                    ),
                  ),
                ),
              ),
            ),
          )
        })

        const addBox = h('button', {
          type: 'button',
          className: 'dph-addBox',
          disabled: saving,
          onClick: () => addOwn(channel),
        }, rows.length === 0 ? '还没有自有机器人 —— 点这里手动添加，或用上面「扫码接入机器人」' : '+ 再接入一个机器人')

        return h('div', { className: 'dph-page' },
          pageHead,
          actions,
          summaryNote,
          rows.length > 0 ? h('ul', { className: 'dph-botList' }, cards) : null,
          addBox,
        )
      }

      // ── 渲染：扫码 / 导入 / 试发 / 代理 / 来源 ───────────────────────────
      const QR_HINTS = {
        feishu: '飞书开放平台扫码授权，成功后自动拿到 App ID / App Secret。',
        qq: 'QQ 开放平台扫码，成功后自动拿到 AppID / AppSecret。',
        wechat: '微信扫码登录 iLink，成功后自动拿到 bot token 与账号 ID。',
      }

      const qrRowTones = { success: 'success', error: 'error', scanned: 'warn' }
      const qrPhaseText = {
        waiting: '等待扫码',
        scanned: '已扫码',
        success: '已完成',
        error: '失败',
        expired: '已过期',
      }

      const qrRows = ['feishu', 'qq', 'wechat'].map((channel) => {
        const cap = qrCaps?.[channel] ?? {}
        const available = cap.available === true
        const running = qrSession !== null && qrSession.channel === channel
        return h('li', { key: channel },
          h('div', { className: 'dph-botCard' },
            h('div', { className: 'dph-botCardBody' },
              h('div', { className: 'dph-botCardTop' },
                h('div', { className: 'dph-botIdentity' },
                  logo(channel),
                  h('div', { className: 'dph-botName' },
                    h('h3', null, CHANNEL_TITLES[channel] ?? channel),
                    h('p', { style: { font: 'inherit', fontSize: 11.5, color: 'var(--dph-label-3)' } }, QR_HINTS[channel] ?? ''),
                  ),
                ),
                h('div', { className: 'dph-botCardTools' },
                  h('button', {
                    type: 'button',
                    className: available ? 'dph-btnPrimary' : 'dph-btn',
                    disabled: qrBusy || saving || !available || qrSession !== null,
                    onClick: () => startQr(channel),
                  }, running ? '扫码中…' : '扫码创建'),
                ),
              ),
              available ? null : h('div', { className: 'dph-hintRow', 'data-tone': 'warn', style: { marginLeft: 0 } }, String(cap.detail ?? '本机不可用')),
            ),
          ),
        )
      })

      const qrResult = qrSession === null ? null : h('div', { className: 'dph-card' },
        h('div', { className: 'dph-cardBody dph-qrWrap' },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 } },
            h('strong', null, (CHANNEL_TITLES[qrSession.channel] ?? qrSession.channel) + ' 扫码'),
            badge(qrRowTones[qrSession.phase] ?? 'muted', qrPhaseText[qrSession.phase] ?? '等待扫码'),
          ),
          qrSession.message ? h('p', { className: 'dph-cardNote', style: { margin: 0 } }, String(qrSession.message)) : null,
          qrSession.qr ? h('img', { className: 'dph-qrImg', src: String(qrSession.qr), alt: '登录二维码' }) : null,
          qrSession.phase === 'success'
            ? h('p', { className: 'dph-cardNote', style: { margin: 0, color: 'var(--dph-success)' } }, qrBusy ? '正在自动保存…' : '已完成，已自动保存')
            : h('button', { type: 'button', className: 'dph-btn', disabled: qrBusy, onClick: cancelQr }, '关闭'),
        ),
      )

      const qrDetail = h('div', { className: 'dph-page' },
        h('div', { className: 'dph-pageHead' },
          h('div', { className: 'dph-pageHeadText' },
            h('h2', { className: 'dph-pageTitle' }, '扫码接入'),
            h('p', { className: 'dph-pageHint' }, '点一下、扫一下，凭据自动填进对应通道的账号列表。Telegram 没有扫码协议，只能在通道里手填 BotFather 给的 token。'),
          ),
        ),
        h('ul', { className: 'dph-botList' }, qrRows),
        qrResult,
      )

      // 代理：只有 Telegram 一定需要，其它通道国内直连就行，所以做成逐通道开关。
      const PROXY_HINTS = {
        telegram: 'api.telegram.org 在国内直连必超时，这个开关要打开。',
        wechat: '国内直连，一般不用开。',
        feishu: '开放平台国内直连，一般不用开。',
        dingtalk: '国内直连，一般不用开。',
        wecom: '国内直连，一般不用开。',
        wecom_app: '国内直连，一般不用开。',
        qq: '国内直连，一般不用开。',
        slack: 'slack.com 在国内多数网络直连不通，走不通就把这个打开。',
        discord: 'discord.com 在国内直连不通，基本都要打开。',
        matrix: '看你用哪个 homeserver：matrix.org 在国内不稳，自建的在国内就直连。',
        synology_chat: 'NAS 在你的局域网里，开代理反而连不上，保持关闭。',
        email: 'SMTP 服务器（QQ 邮箱 / 163 / Gmail）多数国内直连，只有 Gmail 之类才要开。',
      }

      const setProxyUrl = (value) => setProxy((prev) => ({ ...prev, url: value }))

      const toggleProxy = (channel) => setProxy((prev) => {
        const chans = prev?.channels !== null && typeof prev?.channels === 'object' ? prev.channels : {}
        return { ...prev, channels: { ...chans, [channel]: chans?.[channel] !== true } }
      })

      const proxyRows = CHANNEL_ORDER.map((channel) => {
        const on = proxy?.channels?.[channel] === true
        return h('li', { key: channel },
          h('div', { className: 'dph-botCard' },
            h('div', { className: 'dph-botCardBody' },
              h('div', { className: 'dph-botCardTop' },
                h('div', { className: 'dph-botIdentity' },
                  logo(channel),
                  h('div', { className: 'dph-botName' },
                    h('h3', null, CHANNEL_TITLES[channel] ?? channel),
                    h('p', { style: { font: 'inherit', fontSize: 11.5, color: 'var(--dph-label-3)' } }, PROXY_HINTS[channel] ?? ''),
                  ),
                ),
                h('div', { className: 'dph-botCardTools' },
                  h('label', { className: 'dph-check' },
                    h('input', { type: 'checkbox', checked: on, onChange: () => toggleProxy(channel) }),
                    on ? '走代理' : '直连',
                  ),
                  badge(on ? 'success' : 'muted', on ? '代理' : '直连'),
                ),
              ),
            ),
          ),
        )
      })

      const proxyDetail = h('div', { className: 'dph-page' },
        h('div', { className: 'dph-pageHead' },
          h('div', { className: 'dph-pageHeadText' },
            h('h2', { className: 'dph-pageTitle' }, '代理通道'),
            h('p', { className: 'dph-pageHint' }, '填一个代理地址，然后只给「走不通的通道」打开开关。关着的通道照旧直连，不会被代理影响。'),
          ),
        ),
        h('div', { className: 'dph-card' },
          h('div', { className: 'dph-cardBody' },
            field('代理地址',
              h('input', {
                className: 'dph-input',
                value: proxy?.url ?? '',
                placeholder: 'http://192.0.2.10:20808',
                onChange: (e) => setProxyUrl(e.target.value),
              }),
            ),
            h('div', { className: 'dph-hintRow' }, '支持 http:// 代理（CONNECT 隧道）。不写 http:// 会自动补上；留空则回落默认地址。'),
            h('div', { className: 'dph-dividerLine' }),
            h('div', { className: 'dph-sectionTitle', style: { margin: '8px 0 4px' } }, '哪些通道走代理'),
            h('ul', { className: 'dph-botList' }, proxyRows),
            h('div', { className: 'dph-hintRow', style: { marginLeft: 0, marginTop: 10 } },
              '改完即保存。想验证代理通不通：到对应通道里点某个账号的「检查凭据」——它会带着当前代理设置真连一次，返回 200 就说明这条链路是通的；超时则说明代理地址不对。'),
          ),
        ),
      )

      // ── 通道显示（v0.26.0）──────────────────────────────────────────────
      //
      // 只管「左侧列表显示哪些通道」。隐藏一个通道 ≠ 停用它：
      // 发送、接收、默认推送全都照旧，改这里不会让任何一条消息发不出去。
      // 所以这一段没有任何网络调用，纯本地 state。
      const VISIBILITY_MODES = [
        { id: 'all', label: '全部显示', hint: '12 个通道都列出来，不常用的可以单独关掉。' },
        { id: 'bound', label: '只显示已配置的', hint: '没填账号的通道直接不出现 —— 就是「绑定了账号的就显示，没绑定就隐藏」。' },
      ]

      const setVisMode = (mode) => setVisibility((prev) => ({ ...prev, mode: mode === 'bound' ? 'bound' : 'all' }))

      const toggleVisible = (channel) => setVisibility((prev) => {
        const hidden = Array.isArray(prev?.hidden) ? prev.hidden.map(String) : []
        const next = hidden.includes(channel)
          ? hidden.filter((name) => name !== channel)
          : [...hidden, channel]
        return { ...prev, hidden: next }
      })

      const visibilityRows = channelKeys.map((channel) => {
        const total = accountCountOf(channel)
        const hiddenOn = Array.isArray(visibility?.hidden) && visibility.hidden.includes(channel)
        const dimmedByMode = visMode === 'bound' && total === 0
        const visible = !hiddenOn && !dimmedByMode
        const hint = hiddenOn
          ? '你手动隐藏的，其它一切照旧。'
          : dimmedByMode
            ? '没有账号，被「只显示已配置的」这一档自动藏起来了。'
            : (total > 0 ? total + ' 个账号' : '还没填账号，但会显示在左侧列表里。')
        return h('li', { key: channel, 'data-hidden': visible ? 'false' : 'true' },
          h('div', { className: 'dph-botCard' },
            h('div', { className: 'dph-botCardBody' },
              h('div', { className: 'dph-botCardTop' },
                h('div', { className: 'dph-botIdentity' },
                  logo(channel),
                  h('div', { className: 'dph-botName' },
                    h('h3', null, CHANNEL_TITLES[channel] ?? channel),
                    h('p', { style: { font: 'inherit', fontSize: 11.5, color: 'var(--dph-label-3)' } }, hint),
                  ),
                ),
                h('div', { className: 'dph-botCardTools' },
                  h('label', { className: 'dph-check' },
                    h('input', { type: 'checkbox', checked: !hiddenOn, onChange: () => toggleVisible(channel) }),
                    '显示',
                  ),
                  badge(visible ? 'success' : 'muted', visible ? '看得见' : '已隐藏'),
                ),
              ),
            ),
          ),
        )
      })

      const visibilityDetail = h('div', { className: 'dph-page' },
        h('div', { className: 'dph-pageHead' },
          h('div', { className: 'dph-pageHeadText' },
            h('h2', { className: 'dph-pageTitle' }, '通道显示'),
            h('p', { className: 'dph-pageHint' }, '只改左侧列表显示哪些通道。隐藏一个通道不会停用它的发送与接收 —— 默认推送、收件箱、发文件全都照旧。'),
          ),
        ),
        h('div', { className: 'dph-card' },
          h('div', { className: 'dph-cardBody' },
            h('div', { className: 'dph-sectionTitle', style: { margin: '0 0 6px' } }, '先选一档'),
            h('div', { className: 'dph-actions', style: { marginTop: 0, marginBottom: 4 } },
              ...VISIBILITY_MODES.map((item) => h('button', {
                key: item.id,
                type: 'button',
                className: 'dph-btn',
                'data-variant': visMode === item.id ? 'primary' : undefined,
                onClick: () => setVisMode(item.id),
              }, item.label)),
            ),
            h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
              (VISIBILITY_MODES.find((item) => item.id === visMode) ?? VISIBILITY_MODES[0]).hint),
            h('div', { className: 'dph-hintRow', style: { marginLeft: 0, marginTop: 2 } },
              '两档是叠加的：先按这一档决定基础集合，再减去下面你手动关掉的那几条。'),
            h('div', { className: 'dph-dividerLine' }),
            h('div', { className: 'dph-sectionTitle', style: { margin: '8px 0 4px' } }, '逐个通道'),
            h('ul', { className: 'dph-botList' }, visibilityRows),
          ),
        ),
      )

      // ── 渲染：发送记录（v0.28.0） ───────────────────────────────────────
      // v0.32.0：流式会话。这一页是「看」不是「开」—— 开流要有人往里送进度，
      // 那是 Agent 侧的事；界面上给个按钮开一条流，开完就没人喂了，只会留一条
      // 卡在「正在处理…」的消息。
      const streamDetail = (() => {
        const live = Array.isArray(streamState.streams) ? streamState.streams : []
        const chans = Array.isArray(streamState.channels) ? streamState.channels : []
        const timeOf = (value) => {
          const at = Date.parse(String(value ?? ''))
          if (!Number.isFinite(at)) return ''
          const d = new Date(at)
          const pad = (n) => String(n).padStart(2, '0')
          return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
        }
        const items = live.length === 0
          ? [h('div', { key: 'none', className: 'dph-empty' }, '现在没有正在跑的流式会话。')]
          : live.map((one, index) => {
            const id = String(one?.id ?? '')
            const status = String(one?.status ?? '')
            const stats = one?.stats && typeof one.stats === 'object' ? one.stats : {}
            return h('div', { key: id === '' ? 'st' + index : id, className: 'dph-recvItem', 'data-kind': status === 'open' ? 'attachment' : 'message' },
              h('div', { className: 'dph-recvRow' },
                h('span', { className: 'dph-recvTagBtn' }, id === '' ? '（无 id）' : id),
                h('span', { className: 'dph-recvTagBtn' }, status === 'open' ? '进行中' : status),
                h('span', { className: 'dph-recvNote' }, '开了 ' + (timeOf(one?.createdAt) || '?')),
              ),
              h('div', { className: 'dph-recvText' },
                '改过 ' + String(Number(stats.edits ?? 0)) + ' 次，收过 ' + String(Number(stats.updates ?? 0)) + ' 份进度'
                + (Number(stats.failures ?? 0) > 0 ? '，失败 ' + String(Number(stats.failures ?? 0)) + ' 次' : '')),
            )
          })
        const reasonRows = chans.length === 0
          ? []
          : Object.entries(streamState.reasons && typeof streamState.reasons === 'object' ? streamState.reasons : {})
            .filter(([name]) => !chans.includes(name))
            .map(([name, why]) => h('div', { key: 'r-' + name, className: 'dph-hintRow', style: { marginLeft: 0 } },
              h('span', { className: 'dph-recvTagBtn' }, CHANNEL_TITLES[name] ?? name),
              h('span', { className: 'dph-recvNote' }, String(why))))
        return h('div', { className: 'dph-page' },
          h('h2', { className: 'dph-sectionTitle' }, '流式会话'),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            '做法：先发一条消息，之后反复改写同一条，直到定稿 —— 长回答不会刷屏，也不用盯着空白等。'
            + '同一时刻最多 64 条，超过 30 分钟没人收尾会自动清掉（只是不再记录，已经发出去的消息不受影响）。'),
          h('div', { className: 'dph-recvList' }, items),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            '能流的通道（' + String(chans.length) + '）：' + (chans.join(' / ') || '（无）')),
          reasonRows.length === 0 ? null : h('div', { className: 'dph-recvList' }, reasonRows),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            streamState.note === '' ? '给别人用：工具 push_hub_stream_open / push_hub_stream_update / push_hub_stream_finish。' : String(streamState.note)),
        )
      })()

      // v0.33.0：进度表情。这一页只做一件有用的事 —— 让你看见哪条忘了收尾。
      const progressDetail = (() => {
        const live = Array.isArray(progressState.items) ? progressState.items : []
        const chans = Array.isArray(progressState.channels) ? progressState.channels : []
        const fmt = (ts) => {
          const n = Number(ts ?? 0)
          if (!Number.isFinite(n) || n <= 0) return ''
          const d = new Date(n)
          const p = (v) => String(v).padStart(2, '0')
          return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
        }
        const items = live.length === 0
          ? [h('div', { className: 'dph-empty' }, '现在没有挂着的进度表情。')]
          : live.map((one) => h('div', { className: 'dph-recvItem', 'data-kind': 'message' },
              h('div', { className: 'dph-recvRow' },
                h('span', { className: 'dph-recvTagBtn' }, String(one?.channel ?? '')),
                h('span', { className: 'dph-recvMeta' }, String(one?.id ?? '')),
                h('span', { className: 'dph-recvMeta' }, fmt(one?.createdAt))),
              h('div', { className: 'dph-recvText' },
                '消息 ' + String(one?.messageId ?? '') + '：当前 ' + (String(one?.emoji ?? '') || '（无）')
                + '，挂上 ' + String(Number(one?.added ?? 0)) + ' 次、摘掉 ' + String(Number(one?.removed ?? 0)) + ' 次'
                + (Number(one?.errors ?? 0) > 0 ? '，失败 ' + String(Number(one?.errors ?? 0)) + ' 次' : '')
                + (one?.restored === true ? '，**重启前挂的**' : '')
                + (() => {
                  const ttl = Number(one?.ttlMs ?? 0)
                  const at = Number(one?.createdAt ?? 0)
                  if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isFinite(at) || at <= 0) return ''
                  const left = ttl - (Date.now() - at)
                  if (left <= 0) return '，已经超时，下次读列表就会被清掉'
                  return '，还有 ' + String(Math.max(1, Math.round(left / 60000))) + ' 分钟会被自动清掉'
                })()),
            ))
        const reasonRows = Object.entries(progressState.reasons && typeof progressState.reasons === 'object' ? progressState.reasons : {})
          .filter(([key]) => !chans.includes(key))
          .map(([key, why]) => h('div', { className: 'dph-recvItem', 'data-kind': 'note' },
            h('div', { className: 'dph-recvRow' }, h('span', { className: 'dph-recvTagBtn' }, key)),
            h('div', { className: 'dph-recvText' }, String(why ?? ''))))
        return h('div', { className: 'dph-page' },
          h('h2', { className: 'dph-sectionTitle' }, '进度表情'),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            '做法：发消息时带 progress:true，或者发完用 push_hub_progress_begin 补挂一个「进行中」，'
            + '跑完了用 push_hub_progress_end 换成成功 / 失败。**挂不上不影响消息本身**。'
            + '这一页只读 —— 挂与收尾都是发送方的事。'),
          h('div', { className: 'dph-recvList' }, items),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            '能挂的通道（' + String(chans.length) + '）：' + (chans.join(' / ') || '（无）')
            + (progressState.maxActive > 0 ? '；同时最多 ' + String(progressState.maxActive) + ' 条' : '')),
          reasonRows.length === 0 ? null : h('div', { className: 'dph-recvList' }, reasonRows),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            progressState.note === '' ? '给别人用：工具 push_hub_progress_begin / push_hub_progress_end / push_hub_progress_list。' : String(progressState.note)),
          (Array.isArray(progressState.swept) && progressState.swept.length > 0
            ? h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
              '这次读列表顺手清掉了 ' + String(progressState.swept.length) + ' 条超时的：' + progressState.swept.join(' / '))
            : null),
        )
      })()

      // v0.35.0：发送配额。只读 —— 配额在账号「高级」页改，这里回答「谁在等、等了多久、卡过几次」。
      const limitsDetail = (() => {
        const rows = Array.isArray(limitState.buckets) ? limitState.buckets : []
        const chans = Array.isArray(limitState.channels) ? limitState.channels : []
        const d = limitState.defaults && typeof limitState.defaults === 'object' ? limitState.defaults : {}
        const items = rows.length === 0
          ? [h('div', { className: 'dph-empty' }, '现在还没有任何限流桶 —— 说明这段时间里一次都没触发过配额检查（或者插件刚重启过，桶是易失的）。')]
          : rows.map((one) => h('div', { className: 'dph-recvItem', 'data-kind': 'message' },
              h('div', { className: 'dph-recvRow' },
                h('span', { className: 'dph-recvTagBtn' }, String(one?.perMinute ?? '') + ' 条/分钟'),
                h('span', { className: 'dph-recvMeta' }, String(one?.key ?? ''))),
              h('div', { className: 'dph-recvText' },
                '这一分钟用了 ' + String(Number(one?.used ?? 0)) + ' / ' + String(one?.perMinute ?? '?' )
                + '，等过 ' + String(Number(one?.waits ?? 0)) + ' 次'
                + (Number(one?.blocked ?? 0) > 0 ? '，**卡住 ' + String(Number(one.blocked)) + ' 次（一块都没发）**' : ''))
            ))
        const reasonRows = Object.entries(limitState.reasons && typeof limitState.reasons === 'object' ? limitState.reasons : {})
          .map(([key, why]) => h('div', { className: 'dph-recvItem', 'data-kind': 'note' },
            h('div', { className: 'dph-recvRow' }, h('span', { className: 'dph-recvTagBtn' }, key)),
            h('div', { className: 'dph-recvText' }, String(why ?? ''))))
        return h('div', { className: 'dph-page' },
          h('h2', { className: 'dph-sectionTitle' }, '发送配额'),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            '默认每分钟 ' + String(d.perMinute ?? 15) + ' 条（可改 ' + String(d.min ?? 1) + '~' + String(d.max ?? 30) + '，填 0 = 不限）。'
            + '**按「块」算，不是按「次」算** —— 一条两万字的正文切 10 块就扣 10 次，'
            + '所以块间延迟调得越快越容易撞配额。桶按「通道|账号|目标」分开算，重启即清空。'),
          h('div', { className: 'dph-recvList' }, items),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            '适用限流的通道（' + String(chans.length) + '）：' + (chans.join(' / ') || '（无）')),
          reasonRows.length === 0 ? null : h('div', { className: 'dph-recvList' }, reasonRows),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            limitState.note === '' ? '给别人用：工具 push_hub_limits / GET /send/limits。' : String(limitState.note)),
        )
      })()
      // v0.36.0：入站附件。这一页存在的理由只有一个 —— 让「对方发的图不见了」可被解释。
      // 三种可能必须能分开看到：平台本身不给（QQ/钉钉/企微）、超了单文件上限、被磁盘策略清掉了。
      const filesDetail = (() => {
        const rows = Array.isArray(inboundState.items) ? inboundState.items : []
        const policy = inboundState.policy && typeof inboundState.policy === 'object' ? inboundState.policy : {}
        const defaults = policy.defaults && typeof policy.defaults === 'object' ? policy.defaults : {}
        const reasons = inboundState.reasons && typeof inboundState.reasons === 'object' ? inboundState.reasons : {}
        const timeOf = (value) => {
          const at = Date.parse(String(value ?? ''))
          if (!Number.isFinite(at)) return ''
          const d = new Date(at)
          const pad = (n) => String(n).padStart(2, '0')
          return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
        }
        const savePolicy = async (patch) => {
          setInboundState((prev) => ({ ...prev, saving: true, busy: 'policy' }))
          try {
            const next = await call('POST', '/receive/files/policy', patch)
            setInboundState((prev) => ({
              ...prev,
              policy: next && typeof next === 'object' ? next : prev.policy,
              saving: false,
              busy: '',
              note: Array.isArray(next?.notes) && next.notes.length > 0 ? next.notes.join('；') : '策略已保存',
            }))
          } catch {
            setInboundState((prev) => ({ ...prev, saving: false, busy: '', note: '策略保存失败' }))
          }
        }
        const sweep = async () => {
          setInboundState((prev) => ({ ...prev, busy: 'sweep' }))
          try {
            const result = await call('POST', '/receive/files/sweep', {})
            setInboundState((prev) => ({ ...prev, busy: '', note: '清掉了 ' + String(Number(result?.removed ?? 0)) + ' 个文件，' + String(result?.detail ?? '') }))
            reload()
          } catch {
            setInboundState((prev) => ({ ...prev, busy: '', note: '清理失败' }))
          }
        }
        const numField = (label, key, hint, current, dflt) => h('div', { className: 'dph-inline', style: { marginBottom: 6 } },
          h('span', { className: 'dph-recvMeta', style: { minWidth: 110 } }, label),
          h('input', {
            className: 'dph-input',
            type: 'number',
            min: 0,
            style: { width: 110 },
            defaultValue: current === undefined || current === null ? '' : String(current),
            placeholder: '默认 ' + String(dflt),
            onChange: (e) => savePolicy({ [key]: e.target.value }),
          }),
          h('span', { className: 'dph-hintRow', style: { marginLeft: 8 } }, hint))
        const fileRows = rows.length === 0
          ? [h('div', { className: 'dph-empty' }, '硬盘上还没有下载过任何附件。收到带附件的消息时会自动下载，落盘位置见上方路径。')]
          : rows.map((one) => h('div', { className: 'dph-recvItem', 'data-kind': 'attachment' },
              h('div', { className: 'dph-recvRow' },
                h('span', { className: 'dph-recvTagFile' }, String(one?.human ?? '')),
                h('span', { className: 'dph-recvMeta' }, String(one?.day ?? '') + ' · ' + timeOf(one?.at))),
              h('div', { className: 'dph-recvText' }, String(one?.name ?? '')),
              h('div', { className: 'dph-recvNote' }, String(one?.path ?? '')),
            ))
        // 「下载不了」的通道要摆出来。不解释的话，用户会去反复重发同一张图。
        const reasonRows = Object.entries(reasons).map(([key, why]) => h('div', { className: 'dph-recvItem', 'data-kind': 'attachment' },
          h('div', { className: 'dph-recvRow' }, h('span', { className: 'dph-recvTagBtn' }, key)),
          h('div', { className: 'dph-recvNote' }, String(why ?? ''))))
        return h('div', { className: 'dph-page' },
          h('h2', { className: 'dph-sectionTitle' }, '入站附件'),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            '对方发来的图片 / 文件 / 语音会直接落到本机：' + String(inboundState.root !== '' ? inboundState.root : policy.root ?? '')
            + '。现在共 ' + String(Number(inboundState.count ?? rows.length)) + ' 个文件、'
            + String(inboundState.totalHuman !== '' ? inboundState.totalHuman : '0 B') + '。'),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0, marginTop: 4 } },
            '下载失败不影响收消息 —— 正文照常进收件箱，附件这一项会带上失败原因，可以稍后再补。'),
          h('h3', { className: 'dph-sectionTitle', style: { fontSize: 14, marginTop: 10 } }, '磁盘策略'),
          numField('单文件上限', 'maxFileMB', 'MB。0 = 不限；超上限的文件一个字节都不会去请求。', policy.maxFileMB, defaults.maxFileMB ?? 10),
          numField('保留天数', 'retainDays', '天。0 = 不按天数清。', policy.retainDays, defaults.retainDays ?? 7),
          numField('总量上限', 'maxTotalMB', 'MB。0 = 不限；超了从最老的开始删。', policy.maxTotalMB, defaults.maxTotalMB ?? 200),
          h('div', { className: 'dph-inline', style: { marginTop: 8 } },
            h('button', { type: 'button', className: 'dph-btn', disabled: inboundState.busy === 'sweep' || inboundState.saving, onClick: sweep },
              inboundState.busy === 'sweep' ? '清理中…' : '按策略清理一次'),
            h('button', { type: 'button', className: 'dph-btn', disabled: inboundState.busy === 'sweep' || inboundState.saving, onClick: () => reload() }, '刷新清单'),
            inboundState.saving ? h('span', { className: 'dph-recvMeta' }, '保存中…') : null),
          Array.isArray(policy.notes) && policy.notes.length > 0
            ? h('div', { className: 'dph-hintRow', 'data-tone': 'warn' }, policy.notes.join('；'))
            : null,
          h('h3', { className: 'dph-sectionTitle', style: { fontSize: 14, marginTop: 10 } }, '已下载（最近 ' + String(rows.length) + ' 个）'),
          h('div', { className: 'dph-recvList' }, fileRows),
          reasonRows.length === 0 ? null : h('h3', { className: 'dph-sectionTitle', style: { fontSize: 14, marginTop: 10 } }, '这些通道暂时取不到文件本体'),
          reasonRows.length === 0 ? null : h('div', { className: 'dph-recvList' }, reasonRows),
          h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
            inboundState.note === '' ? '给别人用：工具 push_hub_files（action = list / policy / setPolicy / sweep / fetch）。' : String(inboundState.note)),
        )
      })()

      const outboxDetail = (() => {
        const rows = Array.isArray(outboxState.entries) ? outboxState.entries : []
        const withIds = rows.filter((one) => Array.isArray(one?.messageIds) && one.messageIds.length > 0).length
        const timeOf = (value) => {
          const at = Date.parse(String(value ?? ''))
          if (!Number.isFinite(at)) return ''
          const d = new Date(at)
          const pad = (n) => String(n).padStart(2, '0')
          return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
        }
        // 每个 id 单独一行：长消息分块后每块在平台上都是独立消息，
        // 只给一个「改这条」会让人以为改一处就全改了。
        const idRows = (one, ids) => {
          const channel = String(one?.channel ?? '')
          const canEdit = editCaps.edit.includes(channel)
          const canDel = editCaps.del.includes(channel)
          // v0.30.0：表情能力同样由后端给，不在前端写死通道名。
          const canReact = Array.isArray(editCaps.react) && editCaps.react.includes(channel)
          const places = Array.isArray(one?.places) ? one.places : []
          const placeOf = (id) => {
            for (const p of places) {
              const list = Array.isArray(p?.messageIds) ? p.messageIds.map(String) : []
              if (list.includes(id)) return String(p?.id ?? '')
            }
            return ''
          }
          return ids.map((id) => h('div', { key: id, className: 'dph-hintRow', style: { marginLeft: 0, gap: 8 } },
            h('span', { className: 'dph-recvNote' }, '消息 id：' + id),
            canEdit
              ? h('button', { type: 'button', className: 'dph-btn', onClick: () => editSent(one, id, placeOf(id)) }, '改这条')
              : null,
            canDel
              ? h('button', { type: 'button', className: 'dph-btnDanger', onClick: () => deleteSent(one, id, placeOf(id)) }, '撤回')
              : null,
            canReact
              ? h('button', { type: 'button', className: 'dph-btn', onClick: () => reactSent(one, id, placeOf(id)) }, '加表情')
              : null,
            canReact
              ? h('button', { type: 'button', className: 'dph-btn', onClick: () => unreactSent(one, id, placeOf(id)) }, '去表情')
              : null,
          ))
        }
        const items = rows.map((one, index) => {
          const ids = Array.isArray(one?.messageIds) ? one.messageIds.map(String) : []
          const channel = String(one?.channel ?? '')
          const canAny = editCaps.edit.includes(channel) || editCaps.del.includes(channel)
            || (Array.isArray(editCaps.react) && editCaps.react.includes(channel))
          const why = ids.length === 0
            ? '这个通道的回包不给消息 id —— 这条以后改不了、撤不回、也加不了表情。'
            : !canAny
              ? '有 id，但这个通道不开放改 / 撤 / 表情：' + String(editCaps.editReasons?.[channel] ?? '平台没有对应接口')
              : ''
          return h('li', { key: String(one?.id ?? index), className: 'dph-recvItem', 'data-kind': ids.length > 0 ? 'attachment' : 'message' },
            h('div', { className: 'dph-recvMeta' },
              h('span', { className: 'dph-recvTagBtn' }, CHANNEL_TITLES[channel] ?? (channel === '' ? '?' : channel)),
              h('span', { className: 'dph-recvTagBtn' }, one?.kind === 'file' ? '文件' : '文字'),
              one?.account === null || one?.account === undefined ? null : h('span', { className: 'dph-recvNote' }, String(one.account)),
              h('span', { className: 'dph-recvNote' }, timeOf(one?.at)),
            ),
            h('p', { className: 'dph-recvText' }, String(one?.text ?? '')),
            why === '' ? null : h('div', { className: 'dph-recvNote', style: { marginTop: 4 } }, why),
            idRows(one, ids),
          )
        })
        return h('div', { className: 'dph-page' },
          h('div', { className: 'dph-pageHead' },
            h('div', { className: 'dph-pageHeadText' },
              h('h2', { className: 'dph-pageTitle' }, '发送记录'),
              h('p', { className: 'dph-pageHint' }, '最近真的发出去的那些（失败的没记 —— 它没有消息 id，记了也不能改不能撤）。记录只在本机，最多留 500 条。'),
            ),
          ),
          h('div', { className: 'dph-card' },
            h('div', { className: 'dph-cardBody' },
              h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
                outboxState.path === '' ? '还没读到记录文件。' : '文件：' + outboxState.path),
              outboxState.note === '' ? null : h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } }, String(outboxState.note)),
              h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
                '共 ' + rows.length + ' 条，其中 ' + withIds + ' 条带消息 id。能改 / 能撤 / 能加表情的通道：'
                + (editCaps.edit.join(' / ') || '（无）') + ' / '
                + (editCaps.del.join(' / ') || '（无）') + ' / '
                + ((Array.isArray(editCaps.react) ? editCaps.react.join(' / ') : '') || '（无）')
                + ' —— 其余通道即使有 id，也因为平台没有对应接口而只显示 id 不给按钮。'),
              h('div', { className: 'dph-dividerLine' }),
              items.length === 0
                ? h('div', { className: 'dph-empty' }, '还没有发送记录。发一条消息之后这里就会出现。')
                : h('ul', { className: 'dph-botList' }, items),
            ),
          ),
        )
      })()

      const testDetail = h('div', { className: 'dph-page' },
        h('div', { className: 'dph-pageHead' },
          h('div', { className: 'dph-pageHeadText' },
            h('h2', { className: 'dph-pageTitle' }, '试发一条'),
            h('p', { className: 'dph-pageHint' }, '按左侧勾选的「默认推送」通道群发。只想测某一个账号，请到对应通道里点它自己的「发条测试消息」。'),
          ),
        ),
        h('div', { className: 'dph-card' },
          h('div', { className: 'dph-cardBody' },
            h('div', { className: 'dph-field' },
              h('label', null, '正文'),
              h('input', {
                className: 'dph-input',
                value: testText,
                placeholder: '要发出去的测试文本',
                onChange: (e) => setTestText(e.target.value),
              }),
            ),
            h('div', { className: 'dph-field' },
              h('label', null, '按钮（可选，JSON）'),
              h('input', {
                className: 'dph-input',
                value: testButtons,
                placeholder: '[{"text":"通过","callback":"ok"},{"text":"拒绝","callback":"no"}]',
                onChange: (e) => setTestButtons(e.target.value),
              }),
              h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
                buttonChannels.length === 0
                  ? '正在读通道能力…'
                  : '只有 ' + buttonChannels.join(' / ') + ' 支持按钮；其它通道照常发文字，按钮会被丢弃并在结果里点名原因。callback 上限 64 字节（按 Telegram 最严的验，三家才都能发）。'),
            ),
            h('div', { className: 'dph-field' },
              h('label', null, '回复某条消息（可选，填消息 ID）'),
              h('input', {
                className: 'dph-input',
                value: replyTo,
                placeholder: '留空 = 当新消息发；收件箱每条消息右侧的 ID 可以直接抄过来',
                onChange: (e) => setReplyTo(e.target.value),
              }),
              h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } },
                replyChannels.length === 0
                  ? '正在读通道能力…'
                  : '只有 ' + replyChannels.join(' / ') + ' 支持引用回复；其它通道照常发新消息，引用会被丢弃并在结果里点名原因。Slack 的「回复」是进线程（thread_ts），不是引用条。'),
            ),
            h('div', { className: 'dph-actions' },
              h('button', { type: 'button', className: 'dph-btnSecondary', disabled: testing, onClick: () => runTest(true) }, '只看分块（不发）'),
              h('button', { type: 'button', className: 'dph-btnPrimary', disabled: testing, onClick: () => runTest(false) }, '真发一条'),
              testing ? h('span', { className: 'dph-testResult', 'data-tone': 'muted' }, '发送中…') : null,
            ),
            h('div', { className: 'dph-hintRow', style: { marginLeft: 0 } }, '微信服务端常返回 ret=-2（已知故障），不影响其它通道的判定。'),
            testResult === null ? null : h('pre', { className: 'dph-pre' }, JSON.stringify(testResult, null, 2)),
          ),
        ),
      )

      // ── 渲染：接收消息 ──────────────────────────────────────────────────
      const receiveDetail = (() => {
        const receivingOf = (channel) => recv.status.some((row) => String(row?.channel) === channel && String(row?.state) !== 'stopped')
        const blockedList = Object.keys(recv.blocked)
        const rows = recv.receivable.map((channel) => {
          const on = receivingOf(channel)
          const mine = recv.status.filter((row) => String(row?.channel) === channel)
          const received = mine.reduce((sum, row) => sum + (Number(row?.received) || 0), 0)
          const last = mine.map((row) => String(row?.updatedAt ?? '')).sort().pop() ?? ''
          // v0.39.0：循环活着但一直在重试时，旧文案照样写「正在收 · 已收 0 条」，
          // 用户会以为在工作、只是没人发消息 —— 而真相是接收权被别人占着。
          // 冲突次数来自 receiver 的 conflicts 计数（409 累加，抢回来归零计数不动）。
          const retrying = mine.some((row) => String(row?.state) === 'retrying')
          const conflicts = mine.reduce((sum, row) => sum + (Number(row?.conflicts) || 0), 0)
          const note = on === false
            ? '未开启 · ' + (RECEIVE_MODE[channel] ?? '主动拉取')
            : retrying === true
              ? '正在抢回接收权 · 同一个机器人已被别的轮询者占用 ' + conflicts + ' 次'
                + (last === '' ? '' : ' · ' + last.replace('T', ' ').slice(0, 19))
              : '正在收 · 已收 ' + received + ' 条' + (conflicts > 0 ? ' · 抢回 ' + conflicts + ' 次' : '')
                + (last === '' ? '' : ' · ' + last.replace('T', ' ').slice(0, 19))
          return h('div', { key: channel, className: 'dph-recvRow', 'data-tone': retrying === true ? 'warn' : undefined },
            h('div', { className: 'dph-recvMain' },
              h('strong', null, CHANNEL_TITLES[channel] ?? channel),
              h('span', { className: 'dph-recvNote' }, note),
            ),
            h('button', {
              type: 'button',
              className: 'dph-btn',
              disabled: recv.busy === channel,
              onClick: () => toggleReceive(channel, !on),
            }, on ? '停止接收' : '开始接收'),
          )
        })

        const blockedRows = blockedList.map((channel) => h('div', { key: channel, className: 'dph-recvRow', 'data-tone': 'muted' },
          h('div', { className: 'dph-recvMain' },
            h('strong', null, CHANNEL_TITLES[channel] ?? channel),
            h('span', { className: 'dph-recvNote' }, String(recv.blocked[channel] ?? '')),
          ),
        ))

        const boxRows = recv.messages.length === 0
          ? h('p', { className: 'dph-cardNote', style: { margin: 0 } }, '收件箱是空的。开一个通道的接收，对方发消息过来就会出现在这里。')
          : h('ul', { className: 'dph-recvList' }, recv.messages.slice(0, 100).map((msg) => {
            const isCallback = msg?.kind === 'callback'
            // v0.27.0：附件。正文里已经拼了摘要（`[图片 photo-a1b2.jpg 12 KB]`），
            // 但摘要是一整段文字，扫列表时看不出「这条带东西」。所以再给一个徽标。
            const attachCount = Array.isArray(msg?.attachments) ? msg.attachments.length : 0
            const attachKinds = attachCount === 0 ? '' : (() => {
              const kinds = new Set((msg.attachments ?? []).map((item) => String(item?.kind ?? 'file')))
              if (kinds.has('image')) return '图片'
              if (kinds.has('voice')) return '语音'
              return '文件'
            })()
            return h('li', { key: String(msg.id), className: 'dph-recvItem', 'data-kind': isCallback ? 'callback' : attachCount > 0 ? 'attachment' : 'message' },
              h('div', { className: 'dph-recvMeta' },
                h('span', { className: 'dph-recvTagBtn' }, CHANNEL_TITLES[String(msg.channel)] ?? String(msg.channel)),
                isCallback ? h('span', { className: 'dph-recvTagBtn' }, '按钮按下') : null,
                attachCount > 0 ? h('span', { className: 'dph-recvTagFile' }, attachKinds + (attachCount > 1 ? ' ×' + attachCount : '')) : null,
                h('span', { className: 'dph-recvNote' }, String(msg.account ?? '') + (String(msg.from ?? '') === '' ? '' : ' · ' + String(msg.from))),
                h('span', { className: 'dph-recvNote' }, String(msg.at ?? '').replace('T', ' ').slice(0, 19)),
              ),
              // 回调的「正文」是 callback 值（ok / no 这种），不是人说的话，标出来免得误读。
              // 正文里已经带摘要了（deliver 拼的），这里不再重复渲染附件清单。
              h('p', { className: 'dph-recvText' }, String(msg.text ?? '')),
            )
          }))

        return h('div', { className: 'dph-page' },
          h('div', { className: 'dph-pageHead' },
            h('div', { className: 'dph-pageHeadText' },
              h('h2', { className: 'dph-pageTitle' }, '接收消息'),
              h('p', { className: 'dph-pageHint' }, '宿主只监听 127.0.0.1，平台回调进不来 —— 所以接收方向是「本插件主动去平台拉」，不是一个 webhook 地址。'),
            ),
            h('button', { type: 'button', className: 'dph-btn', disabled: recv.loading, onClick: () => loadReceive() }, recv.loading ? '读取中…' : '刷新'),
          ),
          recv.note === '' ? null : h('div', { className: 'dph-banner', 'data-tone': 'warn' }, recv.note),
          h('div', { className: 'dph-card' },
            h('div', { className: 'dph-cardBody' },
              h('div', { className: 'dph-sectionTitle' }, '能收的通道'),
              h('p', { className: 'dph-cardNote', style: { margin: '2px 0 8px' } }, '五种接法：Telegram / 微信 / Matrix 与邮件是轮询（连着问「有新消息吗」，邮件每 30 秒开一次 IMAP 连接）；飞书 / Discord / QQ / 钉钉 / 企业微信自建应用都是 WebSocket 长连接（平台沿连接把事件推过来）；Slack 走 Socket Mode（要 App Token，不是 Bot Token）。五种都不需要公网地址、不需要端口映射，但都要求本机能出网（Telegram / Discord / QQ 通常要走代理）。注意钉钉与企业微信的「接收凭据」和「发送凭据」是两套：群机器人 webhook 只能发，收要用企业内部应用 / 智能机器人。'),
              rows.length === 0 ? h('p', { className: 'dph-cardNote' }, '（没有可接收的通道）') : rows,
              h('div', { className: 'dph-dividerLine' }),
              h('div', { className: 'dph-sectionTitle', style: { margin: '8px 0 6px' } }, '为什么另外这些收不了'),
              blockedRows,
            ),
          ),
          h('div', { className: 'dph-card', style: { marginTop: 12 } },
            h('div', { className: 'dph-cardBody' },
              h('div', { className: 'dph-cardHeadRow' },
                h('div', { className: 'dph-sectionTitle', style: { margin: 0 } }, '收件箱'),
                h('button', { type: 'button', className: 'dph-btn', disabled: recv.busy === 'inbox' || recv.messages.length === 0, onClick: clearInbox }, '清空'),
              ),
              h('p', { className: 'dph-cardNote', style: { margin: '2px 0 10px' } }, '落盘在 ', h('span', { className: 'dph-code' }, recv.inboxPath || '（未读取）'), '，最多留 500 条，重启不丢。'),
              boxRows,
            ),
          ),
        )
      })()

      const sourcesDetail = h('div', { className: 'dph-page' },
        h('div', { className: 'dph-pageHead' },
          h('div', { className: 'dph-pageHeadText' },
            h('h2', { className: 'dph-pageTitle' }, '来源与顺序'),
            h('p', { className: 'dph-pageHint' }, '同一通道的账号按下面顺序合并，越靠上越优先；下层只在对应字段留空时才生效。'),
          ),
        ),
        h('div', { className: 'dph-card' },
          h('div', { className: 'dph-cardBody' },
            h('ol', { className: 'dph-ordered' },
              h('li', null, '自有机器人（本插件配置，扫码 / 手填都进这一层）'),
            ),
            h('p', { className: 'dph-cardNote', style: { margin: '4px 0 0' } },
              'v0.10.0 起不再读 dsh-bridge / dsh-im-connect 的凭据（按你的要求切断，避免账号混乱）。',
              '每个通道只有「自有机器人」这一层，全部写在本插件自己的配置文件里。'),
            h('div', { className: 'dph-dividerLine' }),
            h('div', { className: 'dph-sectionTitle', style: { margin: '8px 0 4px' } }, '收消息不在本插件范围'),
            h('p', { className: 'dph-cardNote', style: { margin: 0 } },
              '本插件只负责「主动推出去」——不发也不收微信/Telegram 的消息，所以没有长连接、没有 webhook 回调。',
              h('br', null),
              '宿主只监听 127.0.0.1，公网回调进不来，因此「收消息再回复」这类需求不在本插件能力范围内。'),
            h('div', { className: 'dph-dividerLine' }),
            h('div', { className: 'dph-sectionTitle', style: { margin: '8px 0 4px' } }, '文件位置'),
            field('本插件配置', h('span', { className: 'dph-code' }, configPath || '（未读取）')),
          ),
        ),
      )

      // ── 渲染：头部 / 摘要 / 主体 ────────────────────────────────────────
      const saveLine = (() => {
        if (loading) return { text: '读取中…', tone: 'muted' }
        if (saving) return { text: '正在保存…', tone: 'muted' }
        if (saveStatus.state === 'failed') return { text: '保存失败：' + saveStatus.error, tone: 'error' }
        if (saveStatus.state === 'saved') return { text: '已自动保存 ' + saveStatus.at, tone: 'success' }
        return { text: '所有改动自动保存', tone: 'muted' }
      })()

      const header = h('div', null,
        h('div', { className: 'dph-head' },
          h('div', { className: 'dph-headMain' },
            h('h1', { className: 'dph-title' }, '推送中枢'),
            h('p', { className: 'dph-subtitle' }, '把消息主动推到 Telegram / 飞书 / QQ / 微信 / 群晖 Chat。改动即时保存，没有「保存」按钮。'),
          ),
          h('div', { className: 'dph-headTools' },
            qrUndo === null ? null : h('button', {
              type: 'button',
              className: 'dph-iconBtn',
              title: '撤销刚加的账号',
              disabled: qrBusy,
              onClick: undoQr,
            }, ICONS.undo()),
            h('button', {
              type: 'button',
              className: 'dph-iconBtn',
              title: '重新读取',
              disabled: saving || loading,
              onClick: reload,
            }, ICONS.reload()),
            h('button', {
              type: 'button',
              className: 'dph-iconBtn',
              title: '来源与顺序',
              'aria-current': view === 'sources' ? 'page' : undefined,
              onClick: () => setView('sources'),
            }, ICONS.help()),
          ),
        ),
        h('div', { className: 'dph-status' },
          h('span', { className: 'dph-statusText', 'data-tone': saveLine.tone }, saveLine.text),
          progress > 0 ? h('span', { className: 'dph-progress' }, h('span', { className: 'dph-progressFill', style: { width: Math.max(0, Math.min(100, Number(progress) || 0)) + '%' } })) : null,
        ),
        error !== '' ? h('div', { className: 'dph-banner', 'data-tone': 'error' }, '✗ ' + error) : null,
        notice !== '' ? h('div', { className: 'dph-banner', 'data-tone': 'success' }, '✓ ' + notice) : null,
      )

      // 插件详情页的摘要视图：只给最关键的三行。
      if (compact) {
        const ready = channels.filter((c) => Array.isArray(c.accounts) && c.accounts.length > 0).map((c) => CHANNEL_TITLES[c.name] ?? c.name)
        return h('div', { className: 'dph-root' },
          h('div', { className: 'dph-summary' },
            h('div', { className: 'dph-summaryRow' },
              h('span', { className: 'dph-summaryKey' }, '标题'),
              h('span', { className: 'dph-summaryVal', style: { fontWeight: 650 } }, '推送中枢'),
            ),
            h('div', { className: 'dph-summaryRow' },
              h('span', { className: 'dph-summaryKey' }, '已配账号'),
              h('span', { className: 'dph-summaryVal' }, ready.length > 0 ? ready.join('、') : '还没有任何通道配好账号'),
            ),
            h('div', { className: 'dph-summaryRow' },
              h('span', { className: 'dph-summaryKey' }, '默认推送'),
              h('span', { className: 'dph-summaryVal' }, picked.join('、') || '（未设置）'),
            ),
            error !== '' ? h('div', { className: 'dph-banner', 'data-tone': 'error' }, '✗ ' + error) : null,
            h('div', { className: 'dph-actions', style: { marginTop: 0 } },
              h('button', { type: 'button', className: 'dph-btn', onClick: reload }, '刷新'),
            ),
          ),
        )
      }

      const mainBody = (() => {
        if (loading) return h('div', { className: 'dph-loading' }, h('span', { className: 'dph-spinner' }), '读取中…')
        if (view === 'qr') return qrDetail
        if (view === 'test') return testDetail
        if (view === 'outbox') return outboxDetail
        if (view === 'stream') return streamDetail
        if (view === 'progress') return progressDetail
        if (view === 'limits') return limitsDetail
        if (view === 'files') return filesDetail
        if (view === 'proxy') return proxyDetail
        if (view === 'visibility') return visibilityDetail
        if (view === 'receive') return receiveDetail
        if (view === 'sources') return sourcesDetail
        if (Object.keys(ownFields).length === 0) {
          return h('div', { className: 'dph-banner', 'data-tone': 'warn' },
            '当前 host 没有返回可填字段（插件后端可能还是旧版本）。',
            h('br', null),
            '处理：设置 → 插件 → 找到 dsh-push-hub 点「禁用」再「启用」，或重启 DSH。',
          )
        }
        if (visibleChannelKeys.length === 0) {
          return h('div', { className: 'dph-page' },
            h('div', { className: 'dph-empty' }, '左侧通道全被隐藏了，右侧没有可配置的对象。'),
            h('div', { className: 'dph-hintRow', style: { textAlign: 'center', marginTop: 6 } },
              '去左侧「通道显示」里把要用的通道打开，或者把模式从「只显示已配置的」切回「全部显示」。'),
          )
        }
        if (effectiveSelected === '') return h('div', { className: 'dph-empty' }, '左边选一个通道开始配置。')
        return channelDetail(effectiveSelected)
      })()

      return h('div', { className: 'dph-root' },
        header,
        h('div', { className: 'dph-layout' },
          rail,
          h('div', { className: 'dph-divider', 'aria-hidden': 'true' }),
          h('div', { className: 'dph-panel' }, mainBody),
        ),
      )
    }

    /** 侧栏入口与主面板共用的固定 id（改名会让已固定在侧栏的项丢失）。 */
    const PANEL_ID = 'duma520-dsh-push-hub'

    /** 侧栏图标：16 网格描边，尺寸由宿主传入。 */
    function PushHubSidebarIcon({ size }) {
      const px = typeof size === 'number' && size > 0 ? size : 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: px,
        height: px,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { key: 'a', d: 'M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9Z' }),
      h('path', { key: 'b', d: 'M5.1 6.8h5.8M5.1 9.3h3.5' }))
    }

    /** 主面板：从侧栏点进来时整页渲染，外面补一层留白。 */
    function PushHubPanel() {
      return h('div', { className: 'dph-pageWrap' }, h(PushHubSettings, null))
    }

    /** 插件详情页里的「打开推送中枢」按钮：只在当前这个插件的详情里出现。 */
    function OpenPanelAction({ subject, packageName, onOpen }) {
      if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null
      if (subject.pkg?.name !== packageName) return null
      if (subject.kind === 'row' && subject.row?.moduleName !== packageName) return null
      return h('button', { type: 'button', className: 'dph-btn', onClick: onOpen }, '打开推送中枢')
    }

    /**
     * 除 slots 外不需要宿主预注入任何服务；layout 走下面的 ctx.inject(['layout']) 懒取，
     * 老宿主没有 ctx.inject 时那段整体跳过。
     */
    const inject = ['slots']

    /** 幂等注入样式表：已存在同 id 的 style 就不重复插，返回卸载函数。 */
    function installTheme() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-dph-css="' + THEME_ID + '"]')
      if (existing) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = '@duma520/dsh-push-hub'
      style.dataset.dphCss = THEME_ID
      style.textContent = THEME_CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    /**
     * 挂载两个入口。
     *
     * 写法对照已在本机跑通的 @duma520/dsh-composer-butler：
     *  - slots.inject(name, cb) 里再 slots.register(...)，外层套 ctx.effect 拿注销；
     *  - settings.section 的 label 必须是函数；
     *  - plugins.bundle.config 用 key = 裸包名，官方按 props.view 分 summary / page。
     */
    function apply(ctx) {
      ctx.effect(() => installTheme(), 'push-hub: 样式表')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'push-hub',
        order: 38,
        label: () => '推送中枢',
      }, () => h(PushHubSettings, null))), 'push-hub: 设置分区')

      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: '@duma520/dsh-push-hub',
      }, (props) => h(PushHubSettings, props ?? {}))), 'push-hub: 插件详情页配置区')

      ctx.effect(() => installPanelEntry(ctx), 'push-hub: 侧栏入口')
    }

    /**
     * 侧栏入口：主面板 + 侧栏图标 + 插件详情页里的「打开推送中枢」。
     *
     * 写法照 @xmanrui/dsh-im 的 plugin-src/client/plugin-page.js：
     *  1. 先 ctx.inject(['layout']) 拿 pageCtx，再在 pageCtx.slots 上注册 —— 侧栏与 main
     *     面板属于 layout 服务，不在设置服务的 slots 命名空间里；
     *  2. main 的 key 就是侧栏条的 id，两处必须一致，否则点侧栏切不过去；
     *  3. 老宿主没有 ctx.inject 时整体跳过，设置分区与插件详情页照旧可用。
     *
     * 任何一步失败都只丢侧栏入口，绝不让整个插件激活失败 —— 设置界面比侧栏重要。
     */
    function installPanelEntry(ctx) {
      if (typeof ctx.inject !== 'function') return () => {}
      try {
        return ctx.inject(['layout'], (pageCtx) => {
          if (!pageCtx || typeof pageCtx.slots?.inject !== 'function') return () => {}
          /** 三个 slot 的注销函数；任一注册抛错都已进不来（下面 catch 兜住）。 */
          const stops = []

          stops.push(pageCtx.slots.inject('main', () => pageCtx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, PushHubPanel)))

          stops.push(pageCtx.slots.inject('sidebar.panellist', () => pageCtx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => '推送中枢',
          }, PushHubSidebarIcon)))

          stops.push(pageCtx.slots.inject('plugins.detail.actions', () => pageCtx.slots.register({
            name: 'plugins.detail.actions',
            id: PANEL_ID + '-open',
            order: 20,
            inject: () => ({
              packageName: '@duma520/dsh-push-hub',
              onOpen: () => pageCtx.layout.selectPanel(PANEL_ID),
            }),
          }, OpenPanelAction)))

          return () => {
            for (const stop of stops) {
              try {
                if (typeof stop === 'function') stop()
              } catch {
                /* 卸载失败不影响其它入口 */
              }
            }
          }
        })
      } catch (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[push-hub] 侧栏入口注册失败，已跳过：' + (err?.message ?? err))
        }
        return () => {}
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = '@duma520/dsh-push-hub'
    exports.__test = { call, PANEL_ID }
    return module.exports
  },
})
