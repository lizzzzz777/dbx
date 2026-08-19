/**
 * 分离子窗口上下文判断。
 * 独立成无依赖模块，供 queryStore 等底层 store 使用（避免经由 detachedTabs 引入循环依赖）。
 */

export const DETACHED_PANEL_PARAM = "detached";
export const DETACHED_TAB_PARAM = "detached-tab";
export const DETACHED_TAB_SHELL_PARAM = "detached-tab-shell";

/** 判断当前窗口是否为分离子窗口（右侧面板/独立页签/预热 shell）。 */
export function isDetachedChildWindow(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.has(DETACHED_PANEL_PARAM) || params.has(DETACHED_TAB_PARAM) || params.has(DETACHED_TAB_SHELL_PARAM);
}
