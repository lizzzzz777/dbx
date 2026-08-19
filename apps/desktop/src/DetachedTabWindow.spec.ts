import { describe, expect, it } from "vitest";
import capabilitiesJson from "../../../src-tauri/capabilities/default.json?raw";
import mainSource from "./main.ts?raw";
import detachedTabAppSource from "./DetachedTabApp.vue?raw";
import detachedPanelAppSource from "./DetachedPanelApp.vue?raw";
import appSource from "./App.vue?raw";
import queryStoreSource from "./stores/queryStore.ts?raw";

describe("detached tab window shell", () => {
  it("routes detached tab URLs to the detached tab shell", () => {
    expect(mainSource).toContain("getDetachedTabModeFromLocation()");
    expect(mainSource).toContain('detachedTabMode ? import("./DetachedTabApp.vue")');
  });

  it("renders the tab with window controls, a dock button, and a direct-close button", () => {
    expect(detachedTabAppSource).toContain("<DetachedWindowControls");
    expect(detachedTabAppSource).toContain("t('panelDetach.dock')");
    // dock 按钮保留：显式合并回主窗口，页签不丢。
    expect(detachedTabAppSource.match(/@click="dockToMainWindow"/g)?.length).toBe(1);
    // X 关闭按钮直接关闭（不合并回主窗口）：先移除 registry 快照，避免下次启动被当作崩溃残留恢复。
    expect(detachedTabAppSource).toContain('@click="closeWindowDirectly"');
    expect(detachedTabAppSource).toContain("removeDetachedTabEntry(tabId.value)");
    // 系统级关闭（Alt+F4/任务栏）转 dock 的拦截已注释停用：保留实现，后续扩展为设置项（独立窗口关闭行为）。
    expect(detachedTabAppSource).toContain("//   await win.onCloseRequested((event) => {");
  });

  it("reuses the main-window content area and execution composables locally", () => {
    expect(detachedTabAppSource).toContain('from "@/composables/useSqlExecution"');
    expect(detachedTabAppSource).toContain('from "@/composables/useDataGridActions"');
    expect(detachedTabAppSource).toContain("<ContentArea");
    expect(detachedTabAppSource).toContain("<EditorToolbar");
  });

  it("keeps the registry snapshot in sync and docks through the event bus", () => {
    expect(detachedTabAppSource).toContain("updateDetachedTabSnapshot(tabId.value, serializeDetachedTab(tabValue))");
    expect(detachedTabAppSource).toContain("requestDockDetachedTab(tabId.value)");
    expect(detachedTabAppSource).toContain('message.action === "detached-tab-assign"');
  });

  it("restores docked tabs in the main window and closes the child window", () => {
    expect(appSource).toContain("restoreDetachedTabSnapshot(entry.snapshot)");
    expect(appSource).toContain("queryStore.adoptDetachedTab(restored)");
    expect(appSource).toContain("closeDetachedTabWindow(entry.label)");
    expect(appSource).toContain("restoreDetachedTabsOnStartup();");
    expect(appSource).toContain("ensureWarmDetachedTabShell()");
  });

  it("grants window destroy so the docked child window actually closes", () => {
    // dock 流程中主窗口经 closeDetachedTabWindow 关闭子窗口；缺少 core:window:allow-close/
    // allow-destroy 时窗口无法销毁（页签已 dock 但窗口残留）。
    const capabilities = JSON.parse(capabilitiesJson) as { permissions: string[] };
    expect(capabilities.permissions).toContain("core:window:allow-close");
    expect(capabilities.permissions).toContain("core:window:allow-destroy");
  });

  it("detaches tabs without deleting the shared result cache", () => {
    expect(queryStoreSource).toContain("async function prepareTabDetachSnapshot(id: string)");
    expect(queryStoreSource).toContain("function finalizeTabDetach(id: string)");
    // prepare 写 IndexedDB 结果缓存（不清内存），而不是 closeTab 的 deleteTabResultSnapshot。
    const prepareStart = queryStoreSource.indexOf("async function prepareTabDetachSnapshot(id: string)");
    const finalizeStart = queryStoreSource.indexOf("function finalizeTabDetach(id: string)");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(finalizeStart).toBeGreaterThan(prepareStart);
    const prepareBody = queryStoreSource.slice(prepareStart, finalizeStart);
    expect(prepareBody).toContain("writeTabResultSnapshot(cacheKey, buildTabResultSnapshot(tab), tab.connectionId)");
    expect(prepareBody).not.toContain("deleteTabResultSnapshot");
    expect(prepareBody).not.toContain("clearResultPayload");
    // 快照必须走分离专用序列化：serializeOpenTabs 会对 data 页签剔除 resultCacheKey，
    // 导致子窗口读不回结果（页签显示"需要重新加载"且工具栏按钮缺失）。
    expect(prepareBody).toContain("return serializeDetachedTab(tab);");
    const finalizeBody = queryStoreSource.slice(finalizeStart, finalizeStart + 1200);
    expect(finalizeBody).not.toContain("deleteTabResultSnapshot");
    expect(finalizeBody).not.toContain("clearResultRunSnapshots");
  });

  it("never persists open-tabs from detached child windows", () => {
    expect(queryStoreSource).toContain('import { isDetachedChildWindow } from "@/lib/detached/detachedWindowContext"');
    expect(queryStoreSource.match(/isDetachedChildWindow\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("wraps detached shells in TooltipProvider like the main window", () => {
    // DataGrid/EditorToolbar 等使用 shadcn Tooltip（reka-ui），缺少 TooltipProvider 时
    // 子窗口挂载即抛 "Injection Symbol(TooltipProviderContext) not found" 崩溃。
    expect(appSource).toContain('<TooltipProvider :delay-duration="300">');
    expect(detachedTabAppSource).toContain('<TooltipProvider :delay-duration="300">');
    expect(detachedPanelAppSource).toContain('<TooltipProvider :delay-duration="300">');
    // toast 反馈 UI 只在主窗口渲染过；子窗口缺失时错误提示不可见（按钮"点了没反应"）。
    expect(detachedTabAppSource).toContain("toastVisible");
    expect(detachedPanelAppSource).toContain("toastVisible");
  });
});
