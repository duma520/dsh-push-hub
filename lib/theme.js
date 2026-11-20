'use strict'

/**
 * dsh-push-hub / lib/theme.js — 设置界面样式（宿主半身不加载它，只给浏览器半身用）。
 *
 * 为什么单独成文件：CSS 有 400 多行，混在 client.js 里会让逻辑淹没在样式里。
 * 但浏览器 bundle 不能 import 相对路径模块（ModuleLoader 只认宿主提供的 'react'），
 * 所以 client.js 用 scaffold/build_client.mjs 把它内联进 factory。
 *
 * 视觉规范照抄 @xmanrui/dsh-im（MIT）的 settings 面板：
 *   左 174px 通道卡栏 + 1px 分隔线 + 右详情；卡片 14px 圆角；主色 #3370ff；
 *   机器人行卡默认折叠，点右侧蓝色齿轮才展开表单。
 *
 * @module theme.js
 */

export const THEME_ID = 'duma520-dsh-push-hub'

export const THEME_CSS = String.raw`
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

/** 幂等注入：已存在同 id 的 style 就不重复插，返回卸载函数。 */
export function installTheme() {
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
