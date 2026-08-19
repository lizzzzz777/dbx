import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");
// 表信息面板的页签/数据加载逻辑已抽取到共享组件（内嵌侧栏与分离子窗口共用）。
const tableInfoPanelSource = readFileSync(new URL("../TableInfoPanel.vue", import.meta.url), "utf8");

function functionBody(name: string, from: string = source): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, "m").exec(from);
  if (!signature) throw new Error(`Missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < from.length; index += 1) {
    if (from[index] === "{") depth += 1;
    else if (from[index] === "}") depth -= 1;
    if (depth === 0) return from.slice(bodyStart, index);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe("ObjectBrowser table metadata refresh", () => {
  it("refreshes the object list and the open table-info tab from the toolbar", () => {
    const refresh = functionBody("refresh");

    expect(refresh).toContain("void reload();");
    expect(refresh).toContain("void refreshActiveTableInfo();");
    expect(source).toContain('@click="refresh"');
  });

  it("invalidates stale requests and reloads only the active metadata surface", () => {
    // ObjectBrowser 侧只做模式判断并委托给 TableInfoPanel。
    const refreshWrapper = functionBody("refreshActiveTableInfo");
    expect(refreshWrapper).toContain('sidePanelMode.value !== "table-info" || !sidePanelRow.value');

    const refreshTableInfo = functionBody("refreshActiveTableInfo", tableInfoPanelSource);

    expect(refreshTableInfo).toContain("sidePanelGuard.bump();");
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "ddl"[\s\S]*?tableDdlContent\.value = "";[\s\S]*?await fetchTableDdl\(\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "columns"[\s\S]*?tableColumns\.value = \[\];[\s\S]*?await fetchTableColumns\(\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "indexes"[\s\S]*?tableIndexes\.value = \[\];[\s\S]*?await fetchTableIndexes\(\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "foreignKeys"[\s\S]*?tableForeignKeys\.value = \[\];[\s\S]*?await fetchTableForeignKeys\(\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "triggers"[\s\S]*?tableTriggers\.value = \[\];[\s\S]*?await fetchTableTriggers\(\);/);
  });

  it("keeps automatic object reloads free of extra metadata requests", () => {
    expect(functionBody("reload")).not.toContain("refreshActiveTableInfo");
  });
});
