/**
 * 存储层自检（离线，用内存版 IndexedDB）
 * 用法：npm run verify:storage
 */
import type { KV } from "../src/db";
import {
  __resetStorageCaches,
  __setBackupGap,
  __setKV,
  bundleMissingImages,
  bundleReports,
  cloneReport,
  clearBackups,
  deleteProject,
  exportAllJson,
  gcAssets,
  importReports,
  listBackups,
  listProjects,
  loadProject,
  memoryKV,
  migrateFromLocalStorage,
  normalizeReport,
  parseBackupBundle,
  parseReportJson,
  restoreBackup,
  saveProject,
  storageUsage,
} from "../src/storage";
import { createReport } from "../src/template";
import { dataUrlBytes, decodeDataUrl, encodeDataUrl, hashString } from "../src/base64";
import type { Block, Report } from "../src/types";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, extra?: string) => checks.push([name, ok, extra]);

const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** 造一张「大图」：1.5MB 的 base64（模拟压缩前的截图） */
function bigImage(seed: string, chars = 1_500_000): string {
  const body = (seed + "A".repeat(64)).repeat(Math.ceil(chars / 64)).slice(0, chars);
  return `data:image/webp;base64,${body}`;
}

function imageBlockOf(id: string, dataUrl: string): Extract<Block, { kind: "image" }> {
  return { id, kind: "image", dataUrl, caption: "", align: "center", widthPct: 0, captionPos: "below", w: 800, h: 600 };
}

function freshReport(name = "实验十一 属性查询"): Report {
  const r = createReport({ order: "十一", topic: "属性查询与空间查询", studentId: "1004245121", name_: "黄玉琛" });
  r.name = name;
  const steps = r.sections[2];
  steps.steps[0].title = "使用SQL查询要素图层";
  steps.steps[0].blocks = [
    { id: "t1", kind: "text", align: "left", text: "（1）添加模块：" },
    imageBlockOf("i1", PNG_1x1),
  ];
  return r;
}

function resetKV(): void {
  __resetStorageCaches();
  __setKV(memoryKV());
}

/* ---------------- 1. 存取往返 ---------------- */
resetKV();
{
  const report = freshReport();
  report.sections[4].steps[0].blocks = [{ id: "s1", kind: "text", align: "left", text: "通过本次实验，我掌握了三种查询方式。" }];
  await saveProject(report);

  const loaded = await loadProject(report.id);
  check("保存后能读回来", !!loaded);
  check("元信息完整", loaded?.meta.studentId === "1004245121" && loaded?.meta.topic === "属性查询与空间查询");
  check("正文完整", loaded?.sections[4].steps[0].blocks[0].kind === "text");
  check(
    "文字内容一致",
    loaded?.sections[2].steps[0].blocks[0].kind === "text" &&
      (loaded?.sections[2].steps[0].blocks[0] as { text: string }).text === "（1）添加模块：",
  );

  const img = loaded?.sections[2].steps[0].blocks[1];
  check("图片原样读回", img?.kind === "image" && img.dataUrl === PNG_1x1);

  const list = await listProjects();
  check("索引里有这个工程", list.length === 1 && list[0].id === report.id);

  const usage = await storageUsage();
  check(`图片单独计数（${usage.images} 张）`, usage.images === 1);
}

/* ---------------- 2. 图片不再塞进正文 ---------------- */
resetKV();
{
  const report = freshReport();
  const images = ["a", "b", "c", "d", "e"].map((s, i) => imageBlockOf(`big${i}`, bigImage(s)));
  report.sections[2].steps[0].blocks = [...report.sections[2].steps[0].blocks.filter((b) => b.kind !== "image"), ...images];
  await saveProject(report);

  const raw = await (async () => {
    // 直接看落库的项目记录（内存 KV 里就是对象）
    const kvStore = (await import("../src/db")).kv();
    return kvStore.get<{ json: Report; assetIds: string[] }>("projects", report.id);
  })();
  const jsonText = JSON.stringify(raw?.json ?? {});
  check(
    `正文 JSON 不含 base64 图片（${(jsonText.length / 1024).toFixed(1)} KB）`,
    jsonText.length < 50 * 1024,
  );
  check("正文里是 asset: 引用", jsonText.includes("asset:"));
  check(`5 张图都单独入库（assetIds=${raw?.assetIds.length}）`, (raw?.assetIds.length ?? 0) === 5);

  const loaded = await loadProject(report.id);
  const back = loaded?.sections[2].steps[0].blocks.filter((b) => b.kind === "image") as
    | Array<Extract<Block, { kind: "image" }>>
    | undefined;
  check("5 张图都能还原", back?.length === 5 && back.every((b) => b.dataUrl.startsWith("data:image/webp")));
  check(
    "还原后字节数一致",
    !!back && back.every((b, i) => decodeDataUrl(b.dataUrl)?.bytes.length === decodeDataUrl(images[i].dataUrl)?.bytes.length),
  );

  const usage = await storageUsage();
  check(`图片占用按二进制算（${(usage.imageBytes / 1024 / 1024).toFixed(1)} MB，约 5×1.07MB）`, Math.abs(usage.imageBytes - 5 * 1125000) < 5000);
}

/* ---------------- 3. 垃圾回收 ---------------- */
resetKV();
{
  // 关掉快照，验证"真的没人引用"时的回收
  __setBackupGap(Number.MAX_SAFE_INTEGER);
  const report = freshReport();
  report.sections[2].steps[0].blocks = [imageBlockOf("i1", bigImage("x")), imageBlockOf("i2", bigImage("y"))];
  await saveProject(report);
  let usage = await storageUsage();
  check(`回收前 2 张图`, usage.images === 2);

  // 删掉第二张图再存
  report.sections[2].steps[0].blocks = [imageBlockOf("i1", bigImage("x"))];
  await saveProject(report);
  const removed = await gcAssets();
  usage = await storageUsage();
  check(`没人引用的图片被清掉（清 ${removed} 张，剩 ${usage.images} 张）`, removed === 1 && usage.images === 1);
}

/* ---------------- 3b. 快照引用着的图片不能清（否则回滚就废了） ---------------- */
resetKV();
{
  __setBackupGap(0);
  const report = freshReport();
  report.sections[2].steps[0].blocks = [imageBlockOf("i1", bigImage("x")), imageBlockOf("i2", bigImage("y"))];
  await saveProject(report);
  report.sections[2].steps[0].blocks = [imageBlockOf("i1", bigImage("x"))];
  await saveProject(report);

  const backups = await listBackups(report.id);
  const removed = await gcAssets();
  const usage = await storageUsage();
  check(
    `快照还引用着旧图 → 不回收（快照 ${backups.length} 份，清 ${removed} 张，剩 ${usage.images} 张）`,
    backups.length >= 1 && removed === 0 && usage.images === 2,
  );
  const restored = await restoreBackup(report.id, backups[0].id);
  const imgs = restored?.sections[2].steps[0].blocks.filter((b) => b.kind === "image") ?? [];
  check("回滚后旧图还在", imgs.length === 2 && imgs.every((b) => b.kind === "image" && b.dataUrl.startsWith("data:")));
}

/* ---------------- 4. 配额失败必须抛错（不能静默），而且不能留半条数据 ---------------- */
resetKV();
{
  const base = memoryKV();
  const failing: KV = {
    ...base,
    write: async (ops) => {
      if (ops.some((o) => o.store === "projects")) {
        const err = new Error("QuotaExceededError: 存储空间不足");
        err.name = "QuotaExceededError";
        throw err;
      }
      return base.write(ops);
    },
  };
  __setKV(failing);

  const doomed = freshReport("写不进去的工程");
  let threw = false;
  try {
    await saveProject(doomed);
  } catch (e) {
    threw = e instanceof Error && e.name === "QuotaExceededError";
  }
  check("写入失败会抛错给界面（不再静默吞掉）", threw);
  // 正文和索引在同一个事务里：失败就不该出现「列表里有、正文没有」或反过来
  const index = await base.get<{ list: Array<{ id: string }> }>("meta", "index");
  check("失败的那次没留下半截索引", !(index?.list ?? []).some((s) => s.id === doomed.id));
  check("失败的那次也没留下正文", !(await base.get("projects", doomed.id)));
}

/* ---------------- 5. 快照与回滚 ---------------- */
resetKV();
{
  __setBackupGap(0);
  const report = freshReport();
  report.sections[4].steps[0].blocks = [{ id: "s1", kind: "text", align: "left", text: "第一版总结" }];
  await saveProject(report);

  const second = await loadProject(report.id);
  second!.sections[4].steps[0].blocks = [{ id: "s1", kind: "text", align: "left", text: "第二版总结（误删了内容）" }];
  await saveProject(second!);

  const backups = await listBackups(report.id);
  check(`自动留下快照（${backups.length} 份）`, backups.length >= 1);

  const restored = await restoreBackup(report.id, backups[0].id);
  const text = restored?.sections[4].steps[0].blocks[0];
  check("能回滚到上一版", text?.kind === "text" && text.text === "第一版总结");
  check("每个工程最多保留最近 3 份 JSON 快照", backups.length <= 3);
  await clearBackups(report.id);
  check("导出 PDF 后可清理本工程 JSON 快照", (await listBackups(report.id)).length === 0);
}

/* ---------------- 6. 从 localStorage 迁移 ---------------- */
{
  __resetStorageCaches();
  __setKV(memoryKV());

  const legacy = freshReport("旧草稿（localStorage）");
  const store = new Map<string, string>([
    ["labrw:index:v2", JSON.stringify([{ id: legacy.id }])],
    [`labrw:project:v2:${legacy.id}`, JSON.stringify(legacy)],
    ["lab-report-wizard:draft:v1", JSON.stringify({ report: freshReport("更老的草稿") })],
  ]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };

  const migrated = await migrateFromLocalStorage();
  check(`迁移了 ${migrated} 份老数据`, migrated === 2);
  const list = await listProjects();
  check("迁移后工程列表有 2 条", list.length === 2);
  const back = await loadProject(legacy.id);
  check("迁移后内容可读", back?.name === "旧草稿（localStorage）" && back.sections.length === 5);
  check("确认写成功后才清掉旧键", !store.has(`labrw:project:v2:${legacy.id}`) && !store.has("lab-report-wizard:draft:v1"));

  // 迁移后图片也应走 assets
  const usage = await storageUsage();
  check("迁移的图片也进了 assets", usage.images === 1);

  delete (globalThis as { localStorage?: unknown }).localStorage;
}

/* ---------------- 7. 索引丢了能自愈 ---------------- */
resetKV();
{
  const report = freshReport();
  await saveProject(report);
  const db = (await import("../src/db")).kv();
  await db.del("meta", "index");
  const list = await listProjects();
  check("索引丢失后能从正文重建", list.length === 1 && list[0].name === report.name);
}

/* ---------------- 8. 删除与克隆 ---------------- */
resetKV();
{
  const report = freshReport();
  await saveProject(report);
  const copy = cloneReport(report);
  check("副本换了新 id", copy.id !== report.id && copy.name.includes("副本"));
  check("副本的块 id 也换了", copy.sections[2].steps[0].blocks[0].id !== report.sections[2].steps[0].blocks[0].id);

  await saveProject(copy);
  check("两个工程并存", (await listProjects()).length === 2);

  await deleteProject(report.id);
  const list = await listProjects();
  check("删除后只剩一个", list.length === 1 && list[0].id === copy.id);

  const all = JSON.parse(await exportAllJson()) as { projects: unknown[] };
  check("导出全部工程可用", all.projects.length === 1);
}

/* ---------------- 9. 老数据缺字段也能读 ---------------- */
{
  const legacy = normalizeReport({ meta: { order: "十" }, sections: [{ id: "s", title: "目的", steps: [{ id: "t", blocks: [{ kind: "text", text: "x" }] }] }] });
  const block = legacy.sections[0].steps[0].blocks[0];
  check("缺字段被补全", block.kind === "text" && block.align === "left" && legacy.options.bodySize === 24);
  check("老数据没有截止日期字段", legacy.meta.due === "");
  const withDue = { ...legacy, meta: { ...legacy.meta, due: "2026-09-20" } };
  check("截止日期跟着工程存下来", normalizeReport(withDue).meta.due === "2026-09-20");
  await saveProject(withDue);
  check("首页索引里带截止日期", (await listProjects()).find((p) => p.id === withDue.id)?.due === "2026-09-20");
  await deleteProject(withDue.id);
}

/* ---------------- 9b. 老索引条目（先存的后端里根本没有 due 字段） ---------------- */
{
  const mem = memoryKV();
  __setKV(mem);
  await mem.put("meta", {
    key: "index",
    list: [
      { id: "old", name: "老工程", order: "", topic: "", coverStyle: "hero", createdAt: 1, updatedAt: 1, done: 0, total: 5 },
    ],
  });
  __resetStorageCaches();
  const legacyIndex = await listProjects();
  check("老索引条目读出时补上空截止日期", legacyIndex.length === 1 && legacyIndex[0].due === "", JSON.stringify(legacyIndex[0]));
  __setKV(memoryKV());
  __resetStorageCaches();
}

/* ---------------- 10. 哈希稳定（同一张图不会重复入库） ---------------- */
{
  const url = bigImage("z", 100_000);
  check("同一内容哈希一致", hashString(url) === hashString(url));
  check("不同内容哈希不同", hashString(url) !== hashString(bigImage("w", 100_000)));
  const round = encodeDataUrl("image/webp", decodeDataUrl(url)!.bytes);
  check("dataURL 编解码往返一致", round === url);
}

/* ---------------- 11. 真实 IndexedDB 封装（用 fake-indexeddb 打桩） ---------------- */
{
  await import("fake-indexeddb/auto");
  __resetStorageCaches();
  __setKV(null); // 换回真正的 idbKV（走 indexedDB.open / transaction）

  const report = freshReport("真实 IDB 往返");
  report.sections[2].steps[0].blocks = [
    { id: "t1", kind: "text", align: "left", text: "走真实事务写一次" },
    imageBlockOf("i1", PNG_1x1),
  ];
  await saveProject(report);

  const loaded = await loadProject(report.id);
  check("真实 IDB：写入后能读回", loaded?.name === "真实 IDB 往返");
  const img = loaded?.sections[2].steps[0].blocks[1];
  check(
    "真实 IDB：Uint8Array 存进去还能还原成 dataURL",
    img?.kind === "image" && img.dataUrl === PNG_1x1,
  );

  const list = await listProjects();
  check("真实 IDB：索引可读", list.some((p) => p.id === report.id));

  const usage = await storageUsage();
  check(`真实 IDB：图片计数正常（${usage.images} 张）`, usage.images === 1);

  await deleteProject(report.id);
  check("真实 IDB：删除生效", !(await listProjects()).some((p) => p.id === report.id));
}

/* ---------------- 12. 整套备份要带着图片，而且要能导回来（A1） ---------------- */
resetKV();
{
  const report = freshReport("带图备份");
  report.sections[2].steps[0].blocks = [imageBlockOf("i1", bigImage("k"))];
  await saveProject(report);

  const text = await exportAllJson();
  const bundle = parseBackupBundle(text);
  const inlined = Object.values(bundle?.assets ?? {});
  check("备份里内联了图片本身", inlined.length === 1 && inlined[0].startsWith("data:image/webp"));
  check("整套备份不会被当成单个工程（不会导入一个空壳）", parseReportJson(text) === null);
  check("备份里的图片没有引用不到的", !!bundle && bundleMissingImages(bundle) === 0);

  const [restored] = bundle ? bundleReports(bundle) : [];
  const pic = restored?.sections[2].steps[0].blocks[0];
  check("从备份取出的工程带着真图片", pic?.kind === "image" && pic.dataUrl.startsWith("data:image/webp"));

  // 换一台浏览器：库是空的，只能靠这份备份重建
  __setKV(memoryKV());
  __resetStorageCaches();
  for (const r of bundleReports(parseBackupBundle(text)!)) await saveProject(r);
  const rebuilt = await loadProject(report.id);
  const img = rebuilt?.sections[2].steps[0].blocks[0];
  check(
    "空库里按备份重建后图片还在",
    img?.kind === "image" && decodeDataUrl(img.dataUrl)?.bytes.length === decodeDataUrl(bigImage("k"))?.bytes.length,
  );

  // 老版备份（只有 assetIds、没带图片字节）也要能读，文字不丢
  const legacy = JSON.stringify({
    app: "lab-report-wizard",
    exportedAt: new Date().toISOString(),
    index: [],
    projects: [
      {
        id: "old",
        updatedAt: 1,
        report: normalizeReport({
          id: "old",
          name: "老备份",
          sections: [
            {
              id: "s",
              title: "目的",
              mode: "plain",
              required: false,
              steps: [{ id: "t", title: "", blocks: [{ id: "b", kind: "text", text: "文字还在", align: "left" }] }],
            },
          ],
        }),
      },
    ],
  });
  const oldBundle = parseBackupBundle(legacy);
  const [oldReport] = oldBundle ? bundleReports(oldBundle) : [];
  check("老版备份（没带图片）照样读得出工程", oldReport?.name === "老备份");
  if (oldBundle && oldReport) {
    const dangling: Report = {
      ...oldReport,
      sections: [{ id: "s", title: "目的", mode: "plain", required: false, steps: [{ id: "t", title: "", blocks: [imageBlockOf("b2", "asset:deadbeef")] }] }],
    };
    check("引用不到字节的图会被数出来", bundleMissingImages({ ...oldBundle, projects: [{ id: "old", updatedAt: 1, report: dangling }] }) === 1);
  }
}

/* ---------------- 13. 老快照字段不全也要能恢复（A2） ---------------- */
resetKV();
{
  const db = memoryKV();
  __setKV(db);
  const report = freshReport();
  await saveProject(report);

  // due 字段之前的快照：连 meta 都没有
  const legacyJson = JSON.parse(JSON.stringify(report)) as { meta?: unknown };
  delete legacyJson.meta;
  await db.put("backups", { id: "old-1", projectId: report.id, at: 1, json: legacyJson, assetIds: [] });

  const list = await listBackups(report.id);
  check("快照列表读得动缺字段的旧快照", list.length === 1 && list[0].total >= 1);
  const restored = await restoreBackup(report.id, "old-1");
  check("恢复出来的老快照字段是齐的", restored?.meta.due === "" && restored?.meta.order === "一" && !!restored?.name);
  check("恢复出来的快照带得上原来的块", restored?.sections.length === report.sections.length);
}

/* ---------------- 14. 索引对不上正文时自愈，且不被一条坏数据拖垮（A3 / A6） ---------------- */
resetKV();
{
  const db = memoryKV();
  __setKV(db);
  const good = freshReport("好的那个");
  await saveProject(good);

  // 索引整块丢了
  await db.put("projects", { id: "broken", json: { sections: [] }, assetIds: [], updatedAt: 5 });
  await db.del("meta", "index");
  const rebuilt = await listProjects();
  check("索引丢失后重建，缺 meta 的工程被补全而不是整体失败", rebuilt.length === 2 && rebuilt.some((p) => p.id === "broken" && p.due === ""));
  check("重建后正常工程还在", rebuilt.some((p) => p.id === good.id));

  // 索引还在、但少了一条（老版本分两次提交留下的洞）
  await db.put("projects", { id: "ghost", json: { id: "ghost", name: "看不见", meta: {}, sections: [] }, assetIds: [], updatedAt: 9 });
  const healed = await listProjects();
  check("正文有、索引没有的工程会被补回列表", healed.some((p) => p.id === "ghost" && p.name === "看不见"));
}

/* ---------------- 15. 图片字节解不开时不能留下空引用（A5） ---------------- */
resetKV();
{
  const report = freshReport("解不开的图");
  // mime 里带参数：decodeDataUrl 认不出来，写不进 assets 表
  const weird = "data:image/png;charset=utf-8;base64,AAAA";
  report.sections[2].steps[0].blocks = [imageBlockOf("i1", weird), imageBlockOf("i2", PNG_1x1)];
  await saveProject(report);

  const raw = await (await import("../src/db")).kv().get<{ json: Report; assetIds: string[] }>("projects", report.id);
  const urls = (raw?.json.sections[2].steps[0].blocks ?? []) as Array<{ dataUrl: string }>;
  check("解不开的图正文里保留原样，不留指向空记录的引用", urls[0]?.dataUrl === weird);
  check("同一份正文里别的图照常转成引用", urls[1]?.dataUrl.startsWith("asset:"));
  check("assetIds 只登记真正写进去的图", raw?.assetIds.length === 1);

  const loaded = await loadProject(report.id);
  const back = (loaded?.sections[2].steps[0].blocks ?? []) as Array<{ dataUrl: string }>;
  check("读回来两张图都还有内容", back[0]?.dataUrl === weird && back[1]?.dataUrl === PNG_1x1);
}

/* ---------------- 16. 导入撞号不能就地盖掉本地那份（I1） ---------------- */
resetKV();
{
  const mine = freshReport("正在写的工程");
  await saveProject(mine);
  const before = await loadProject(mine.id);

  // 备份文件里的工程和本地这份同一个 id（导出时就是它）
  const incoming = normalizeReport(JSON.parse(JSON.stringify(mine)));
  incoming.sections[0].steps[0].blocks = [{ id: "b1", kind: "text", align: "left", text: "三个月前的版本" }];

  const { imported, collided } = await importReports([incoming, freshReport("全新来的")]);
  const list = await listProjects();
  check("撞号的那份被算进 collided", collided === 1);
  check("库里是「本地那份 + 备份副本 + 新工程」三条", list.length === 3, `实际 ${list.length} 条`);
  check("本地那份的内容没被备份盖掉", (await loadProject(mine.id))?.sections[0].steps[0].blocks[0]?.kind === "text" &&
    JSON.stringify((await loadProject(mine.id))?.sections[0].steps[0].blocks) === JSON.stringify(before?.sections[0].steps[0].blocks));
  check("撞号的另存成新 id 并标出来源", imported[0].id !== mine.id && imported[0].name === "正在写的工程（备份导入）");
  check("不撞号的按原样落地", imported[1].name === "全新来的" && list.some((p) => p.id === imported[1].id));
}

/* ---------------- 17. 快照与图片的删除要走一个事务（I2） ---------------- */
resetKV();
{
  __setBackupGap(0);
  const stats = { backupWrites: 0, assetWrites: 0, singleDels: 0 };
  const base = memoryKV();
  const spy: KV = {
    ...base,
    del: async (store, key) => {
      if (store === "backups" || store === "assets") stats.singleDels += 1;
      return base.del(store, key);
    },
    write: async (ops) => {
      if (ops.some((o) => "del" in o && o.store === "backups")) stats.backupWrites += 1;
      if (ops.some((o) => "del" in o && o.store === "assets")) stats.assetWrites += 1;
      return base.write(ops);
    },
  };
  __setKV(spy);

  const report = freshReport("有快照的工程");
  // 快照 id 带毫秒，连着存太快会撞在同一个 id 上
  await saveProject(report);
  await new Promise((r) => setTimeout(r, 3));
  await saveProject(report);
  await new Promise((r) => setTimeout(r, 3));
  await saveProject(report);
  // 保存后会异步跑一次回收，等它跑完再开始计数，否则把它的删除算到我头上
  await new Promise((r) => setTimeout(r, 20));
  const ids = (await listBackups(report.id)).map((b) => b.id);
  check("前提：确实攒下了快照", ids.length >= 2, `快照 ${ids.length} 份`);

  stats.backupWrites = 0;
  stats.singleDels = 0;
  await clearBackups(report.id);
  check("清快照只发一次批量删除（中途失败不会剩半截列表）", stats.backupWrites === 1 && stats.singleDels === 0, `事务 ${stats.backupWrites} 次 / 单条 ${stats.singleDels} 次`);
  check("快照真的清空了", (await listBackups(report.id)).length === 0);

  // 让图片变成没人引用，再单独触发回收
  const raw = await base.get<{ assetIds: string[] }>("projects", report.id);
  const assetId = raw?.assetIds[0];
  await saveProject({ ...report, sections: report.sections.map((s) => ({ ...s, steps: s.steps.map((st) => ({ ...st, blocks: st.blocks.filter((b) => b.kind !== "image") })) })) });
  await new Promise((r) => setTimeout(r, 20));
  // 上一次保存顺手留下的快照还引用着这张图，先绕开回收逻辑把它清掉
  await base.clear("backups");
  stats.assetWrites = 0;
  stats.singleDels = 0;
  const removed = await gcAssets();
  check("回收图片也只发一次批量删除", removed >= 1 && stats.assetWrites === 1 && stats.singleDels === 0, `回收 ${removed} 张 / 事务 ${stats.assetWrites} 次 / 单条 ${stats.singleDels} 次`);
  check("被回收的图从库里没了", !!assetId && !(await base.get("assets", assetId)));
}

/* ---------------- 18. 「存过没有」以库为准，不看模块内存（I3） ---------------- */
resetKV();
{
  const db = memoryKV();
  __setKV(db);
  const report = freshReport("图片会被补写");
  await saveProject(report);
  const assetId = (await db.get<{ assetIds: string[] }>("projects", report.id))?.assetIds[0];
  check("第一次保存写进了图片", !!assetId && !!(await db.get("assets", assetId)));

  // 外部把字节抹掉了（清站点数据 / 另一个标签页回收），但眼前这份正文里还是真图片
  if (assetId) await db.del("assets", assetId);
  await saveProject(report);

  check("再次保存会把缺的字节补回库", !!assetId && !!(await db.get("assets", assetId)));
  const again = await loadProject(report.id);
  const img = again?.sections[2].steps[0].blocks.find((b) => b.kind === "image");
  check("补回来之后图片解得开", img?.kind === "image" && img.dataUrl.startsWith("data:image/png"));
}

/* ---------------- 19. GC 只要图片的 key，不该把整仓字节搬进内存 ---------------- */
resetKV();
{
  const db = memoryKV();
  __setKV(db);
  __setBackupGap(Number.MAX_SAFE_INTEGER); // 关掉快照，隔离出「真的没人引用」
  const report = freshReport("GC 不许读字节");
  report.sections[2].steps[0].blocks = [imageBlockOf("i1", bigImage("x"))];
  await saveProject(report);

  // 换成「一读图片仓就炸」的 KV，再让这张图失去引用
  // （保存内部触发的 GC 会因此失败并被吞掉，图留在库里，交给下面显式那次）
  const wrapped: KV = {
    ...db,
    getAll: <T>(store: Parameters<KV["getAll"]>[0]): Promise<T[]> =>
      store === "assets"
        ? Promise.reject(new Error("GC 读了整个图片仓的字节"))
        : db.getAll<T>(store),
  };
  __setKV(wrapped);
  report.sections[2].steps[0].blocks = [];
  await saveProject(report);
  let boom = false;
  let removed = 0;
  try {
    removed = await gcAssets(); // 保存内部的自动 GC 可能已经先收走，这里再点一次名
  } catch {
    boom = true;
  }
  const left = await db.keys("assets");
  check("GC 只取 key、不读图片字节", !boom && left.length === 0, `显式回收 ${removed} 张，库里剩 ${left.length} 张`);
  __setKV(db);
}

/* ---------------- 20. dataUrlBytes 数长度而不是解整图 ---------------- */
{
  let allOk = true;
  for (const s of [PNG_1x1, encodeDataUrl("image/png", new Uint8Array(5)), bigImage("x"), bigImage("y", 1_000_003), "data:image/png;base64,%%%", "not-a-url"]) {
    const ref = decodeDataUrl(s)?.bytes.length ?? 0;
    if (dataUrlBytes(s) !== ref) allOk = false;
  }
  check("dataUrlBytes 与整图解码逐一致（含填充 / 坏输入）", allOk);
}

/* ---------------- 结果 ---------------- */
let fails = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) fails += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${extra ? `  (${extra})` : ""}`);
}
console.log(fails === 0 ? "\n存储层检查全部通过 ✅" : `\n${fails} 项未通过 ❌`);
if (fails > 0) process.exitCode = 1;
