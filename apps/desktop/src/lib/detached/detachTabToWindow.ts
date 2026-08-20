import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { openDetachedTabWindow, type DetachedTabOpenPlacement } from "@/lib/detached/detachedTabs";
import { tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import { useQueryStore } from "@/stores/queryStore";
import type { QueryTab } from "@/types/database";

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 分离失败原因：页签不存在 / 执行中（查询、取消、Explain）/ 未提交事务 / 子窗口创建或 adopt 失败。 */
export type DetachTabFailureReason = "tab-missing" | "busy-executing" | "busy-transaction" | "window-failed";

export type DetachTabToWindowResult = { ok: true; label: string } | { ok: false; reason: DetachTabFailureReason };

/**
 * 不可迁移状态检查：执行/取消/Explain 中的查询与未提交事务绑定主窗口的后端会话，
 * 无法随快照转移——存在时禁止分离（调用方据返回原因明确提示）。
 */
export function tabDetachBlockReason(tab: QueryTab): "busy-executing" | "busy-transaction" | null {
  if (tab.isExecuting || tab.isCancelling || tab.isExplaining) return "busy-executing";
  if (tab.txnSessionId) return "busy-transaction";
  return null;
}

/** 分离失败的用户提示文案。 */
export function detachTabFailureMessage(reason: DetachTabFailureReason, t: Translate): string {
  if (reason === "busy-executing") return t("contextMenu.detachTabExecuting");
  if (reason === "busy-transaction") return t("contextMenu.detachTabTransaction");
  return t("contextMenu.openInSeparateWindowFailed");
}

/**
 * 将主窗口指定页签分离到独立子窗口：prepare（结果写缓存+快照，页签不动）→
 * 子窗口创建/分配并确认 adopt 回执成功后 finalize 移除主窗口页签（确认前页签完整保留，
 * 失败/超时由 openDetachedTabWindow 回滚 registry 与半成品窗口）。
 * 执行中查询/未提交事务等不可迁移状态会拒绝分离（ok:false + 原因，调用方负责提示）。
 */
export async function detachTabToWindow(tabId: string, t: Translate, placement?: DetachedTabOpenPlacement): Promise<DetachTabToWindowResult> {
  if (!isTauriRuntime()) return { ok: false, reason: "window-failed" };
  const queryStore = useQueryStore();
  const tab = queryStore.tabs.find((item) => item.id === tabId);
  if (!tab) return { ok: false, reason: "tab-missing" };
  const blocked = tabDetachBlockReason(tab);
  if (blocked) return { ok: false, reason: blocked };
  const snapshot = await queryStore.prepareTabDetachSnapshot(tabId);
  if (!snapshot) return { ok: false, reason: "tab-missing" };
  const label = await openDetachedTabWindow({ tabId, title: tabDisplayTitle(tab, t), snapshot, placement });
  if (!label) return { ok: false, reason: "window-failed" };
  queryStore.finalizeTabDetach(tabId);
  return { ok: true, label };
}
