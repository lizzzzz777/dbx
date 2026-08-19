import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDetachedTabModeFromLocation,
  readDetachedTabEntry,
  removeDetachedTabEntry,
  updateDetachedTabSnapshot,
  writeDetachedTabEntry,
  listDetachedTabEntries,
  clearDetachedTabsRegistry,
  detachedTabPlacementKey,
  detachedTabWindowLabel,
  serializeDetachedTab,
  restoreDetachedTabSnapshot,
  type DetachedTabSnapshot,
} from "@/lib/detached/detachedTabs";
import type { QueryTab } from "@/types/database";

function stubLocationSearch(search: string) {
  vi.stubGlobal("window", { location: { search } });
}

function stubMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "query_1",
    connectionId: "conn-1",
    database: "postgres",
    sql: "select 1",
    isExecuting: false,
    mode: "query",
    ...overrides,
  } as QueryTab;
}

function makeSnapshot(overrides: Partial<DetachedTabSnapshot> = {}): DetachedTabSnapshot {
  return {
    id: "tab-1",
    title: "query_1",
    connectionId: "conn-1",
    database: "postgres",
    sql: "select 1",
    mode: "query",
    ...overrides,
  };
}

describe("detachedTabs window mode parsing", () => {
  it("parses direct tab url and shell url", () => {
    stubLocationSearch("");
    expect(getDetachedTabModeFromLocation()).toBeNull();
    stubLocationSearch("?detached-tab=tab-1");
    expect(getDetachedTabModeFromLocation()).toEqual({ kind: "tab", tabId: "tab-1" });
    stubLocationSearch("?detached-tab-shell=1");
    expect(getDetachedTabModeFromLocation()).toEqual({ kind: "shell" });
  });
});

describe("detachedTabs registry", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    clearDetachedTabsRegistry();
  });

  it("writes, reads, updates and removes entries", () => {
    writeDetachedTabEntry("tab-1", { snapshot: makeSnapshot(), label: "panel-tab-tab-1", title: "query_1", detachedAt: 1, updatedAt: 1 });
    expect(readDetachedTabEntry("tab-1")?.label).toBe("panel-tab-tab-1");
    expect(listDetachedTabEntries()).toHaveLength(1);

    updateDetachedTabSnapshot("tab-1", makeSnapshot({ sql: "select 2" }));
    const entry = readDetachedTabEntry("tab-1");
    expect(entry?.snapshot.sql).toBe("select 2");
    // 更新快照保留原 label/detachedAt。
    expect(entry?.label).toBe("panel-tab-tab-1");
    expect(entry?.detachedAt).toBe(1);

    removeDetachedTabEntry("tab-1");
    expect(readDetachedTabEntry("tab-1")).toBeNull();
    expect(listDetachedTabEntries()).toHaveLength(0);
  });

  it("updateDetachedTabSnapshot is a no-op for unknown tabs", () => {
    updateDetachedTabSnapshot("missing", makeSnapshot());
    expect(listDetachedTabEntries()).toHaveLength(0);
  });

  it("sanitizes window labels and scopes placement keys per tab", () => {
    expect(detachedTabWindowLabel("tab:objects/1")).toBe("panel-tab-tab-objects-1");
    expect(detachedTabPlacementKey("tab:objects/1")).toBe("tab-tab:objects/1");
  });
});

describe("detachedTabs snapshot round-trip", () => {
  it("carries structure draft and editor state through serialization", () => {
    const tab = makeTab({
      mode: "structure",
      structureTableName: "users",
      structureDraft: { comment: "draft" } as unknown as QueryTab["structureDraft"],
      tableInfoTab: "columns",
      editorViewport: { scrollTop: 10, scrollLeft: 0 },
      editorSelection: { anchor: 1, head: 2 },
    });
    const snapshot = serializeDetachedTab(tab);
    expect(snapshot.structureDraft).toEqual({ comment: "draft" });
    expect(snapshot.tableInfoTab).toBe("columns");
    expect(snapshot.editorViewport).toEqual({ scrollTop: 10, scrollLeft: 0 });
    expect(snapshot.editorSelection).toEqual({ anchor: 1, head: 2 });

    const restored = restoreDetachedTabSnapshot(snapshot);
    expect(restored?.structureDraft).toEqual({ comment: "draft" });
    expect(restored?.tableInfoTab).toBe("columns");
    expect(restored?.editorViewport).toEqual({ scrollTop: 10, scrollLeft: 0 });
    expect(restored?.editorSelection).toEqual({ anchor: 1, head: 2 });
    expect(restored?.isExecuting).toBe(false);
  });

  it("forces resultCacheKey + evicted marker for non-data tabs so restore reads from the result cache", () => {
    const tab = makeTab({ resultCacheKey: "cache-key-1" });
    const snapshot = serializeDetachedTab(tab);
    expect(snapshot.resultCacheKey).toBe("cache-key-1");
    expect(snapshot.resultEvicted).toBe(true);

    const restored = restoreDetachedTabSnapshot(snapshot);
    expect(restored?.resultCacheKey).toBe("cache-key-1");
    expect(restored?.resultCacheState).toBe("disk");
  });

  it("carries resultCacheKey for data tabs too so detached windows keep loaded data", () => {
    const tab = makeTab({ mode: "data", resultCacheKey: "cache-key-1" });
    const snapshot = serializeDetachedTab(tab);
    expect(snapshot.resultCacheKey).toBe("cache-key-1");
    expect(snapshot.resultEvicted).toBe(true);

    const restored = restoreDetachedTabSnapshot(snapshot);
    expect(restored?.resultCacheKey).toBe("cache-key-1");
    expect(restored?.resultCacheState).toBe("disk");
    expect(restored?.resultEvicted).toBe(true);
  });
});
