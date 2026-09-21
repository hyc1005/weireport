/**
 * 导出链路自检（离线，不需要浏览器）
 * 用法：npm run verify:export
 */
import JSZip from "jszip";
import fs from "node:fs/promises";
import path from "node:path";
import { buildReportBlob } from "../src/docx/build";
import { createReport, DEFAULT_OPTIONS, todayString } from "../src/template";
import { flattenPages, projectProgress } from "../src/wizard";
import { reportFileName } from "../src/markdown";
import { normalizeReport } from "../src/storage";
import type { Report } from "../src/types";

const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function sample(): Report {
  const r = createReport({
    order: "十一",
    topic: "属性查询与空间查询",
    studentId: "1004245121",
    name_: "黄玉琛",
  });
  const [purpose, content, steps, task, summary] = r.sections;

  purpose.steps[0].blocks = [
    {
      id: "b1",
      kind: "text",
      align: "left",
      text: "1. 掌握使用SQL语句对要素图层进行属性查询的方法\n（2）掌握使用空间关系对要素图层进行空间查询的方法\n补充说明一句",
    },
  ];
  content.steps[0].blocks = [
    { id: "b2", kind: "text", align: "center", text: "实验包含三个部分：SQL过滤、空间查询、SQL查询。" },
  ];

  steps.steps[0].title = "使用SQL查询要素图层";
  steps.steps[0].blocks = [
    { id: "b3", kind: "text", align: "left", text: "（1）创建要素图层，指定服务URL和输出字段：" },
    {
      id: "b4",
      kind: "code",
      lang: "js",
      showLang: true,
      boxed: true,
      code: 'const parcelQuery = {\n  where: "1=0", // 中文注释也要正常\n  outFields: ["APN"],\n};',
    },
    {
      id: "b5",
      kind: "image",
      dataUrl: PNG_1x1,
      caption: "查询结果",
      align: "center",
      widthPct: 60,
      captionPos: "below",
      w: 1,
      h: 1,
    },
  ];
  steps.steps[1].title = "空间关系判断";
  steps.steps[1].blocks = [
    {
      id: "b6",
      kind: "table",
      headerRow: true,
      rows: [
        ["操作符", "含义", "示例"],
        ["Contains", "几何1完全包含几何2", "a contains b"],
        ["Within", "几何1在几何2内部", "a within b"],
      ],
    },
  ];

  task.steps[0].title = "把饼图放到右上角";
  task.steps[0].blocks = [{ id: "b7", kind: "text", align: "right", text: "引入饼图组件，并加点击事件放大。" }];
  summary.steps[0].blocks = [
    {
      id: "b8",
      kind: "text",
      align: "justify",
      text: "通过本次实验，我掌握了三种查询方式。\n遇到的问题主要有：**definitionExpression** 与 outFields 的关系没理清。",
    },
  ];
  return r;
}

const checks: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, extra?: string) {
  checks.push([name, ok, extra]);
}

const outDir = path.resolve("scripts/out");
await fs.mkdir(outDir, { recursive: true });

async function render(report: Report) {
  const { blob } = await buildReportBlob(report);
  const buf = Buffer.from(await blob.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file("word/document.xml")!.async("string");
  const styles = await zip.file("word/styles.xml")!.async("string");
  return { buf, zip, doc, styles };
}

const base = sample();
const plain = await render(base);

/* ---------- 标题级别：字号递减 + 大纲级别 ---------- */
function styleInfo(styles: string, id: string) {
  const m = new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(styles);
  const seg = m?.[0] ?? "";
  return {
    size: Number(/<w:sz w:val="(\d+)"/.exec(seg)?.[1] ?? 0),
    outline: /<w:outlineLvl w:val="(\d+)"/.exec(seg)?.[1] ?? "",
    eastAsia: /w:eastAsia="([^"]+)"/.exec(seg)?.[1] ?? "",
    color: /<w:color w:val="([^"]+)"/.exec(seg)?.[1] ?? "",
  };
}

const h1 = styleInfo(plain.styles, "Heading1");
const h2 = styleInfo(plain.styles, "Heading2");
const h3 = styleInfo(plain.styles, "Heading3");

check("大标题用 Heading1", /w:pStyle w:val="Heading1"/.test(plain.doc));
check("小节用 Heading2", /w:pStyle w:val="Heading2"/.test(plain.doc));
check("步骤用 Heading3", /w:pStyle w:val="Heading3"/.test(plain.doc));
check(
  `字号严格递减（${h1.size} > ${h2.size} > ${h3.size} > 正文 ${DEFAULT_OPTIONS.bodySize}）`,
  h1.size > h2.size && h2.size > h3.size && h3.size > DEFAULT_OPTIONS.bodySize,
);
check(
  `大纲级别 0/1/2（实际 ${h1.outline}/${h2.outline}/${h3.outline}）`,
  h1.outline === "0" && h2.outline === "1" && h3.outline === "2",
);
check(`标题字体为黑体（${h1.eastAsia}）`, h1.eastAsia === "黑体" && h2.eastAsia === "黑体");
check(`标题是黑色不是 Word 蓝（${h1.color}）`, h1.color === "1A1A1A");
check("正文默认字体宋体", /w:eastAsia="宋体"/.test(plain.styles));

/* ---------- 块级对齐 ---------- */
check("左对齐段落", /<w:jc w:val="left"\/>/.test(plain.doc));
check("居中对齐段落", /<w:jc w:val="center"\/>/.test(plain.doc));
check("右对齐段落", /<w:jc w:val="right"\/>/.test(plain.doc));
check("两端对齐段落", /<w:jc w:val="both"\/>/.test(plain.doc));
check("正文首行缩进 2 字符", /w:firstLineChars="200"/.test(plain.doc));
const numberedPara = /<w:p>(?:(?!<\/w:p>)[\s\S])*?掌握使用空间关系[\s\S]*?<\/w:p>/.exec(plain.doc)?.[0] ?? "";
const plainPara = /<w:p>(?:(?!<\/w:p>)[\s\S])*?补充说明一句[\s\S]*?<\/w:p>/.exec(plain.doc)?.[0] ?? "";
check("带序号的行不加首行缩进", numberedPara.length > 0 && !numberedPara.includes("firstLineChars"));
check("普通行仍然首行缩进", plainPara.length > 0 && plainPara.includes("firstLineChars"));
check("正文行距 1.5 倍（line=360）", /w:line="360"/.test(plain.doc));

/* ---------- 代码块 ---------- */
check("代码用 Consolas", /w:ascii="Consolas"/.test(plain.doc));
check("代码中文注释走宋体", /w:eastAsia="宋体"/.test(plain.doc));
check("代码块有底纹", /w:fill="F6F7F9"/.test(plain.doc));

/* ---------- 图片 ---------- */
const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(plain.doc);
const imgWidthPx = ext ? Number(ext[1]) / 9525 : 0;
check(`图片按 60% 宽度输出（${imgWidthPx.toFixed(0)}px，期望 ${(650 * 0.6).toFixed(0)}px）`, Math.abs(imgWidthPx - 650 * 0.6) < 4);
check("图片已嵌入 media", Object.keys(plain.zip.files).some((f) => f.startsWith("word/media/")));
check("图注文字在文档里", plain.doc.includes("查询结果"));

/* ---------- 表格与行内格式 ---------- */
check("表格列宽已均分", /<w:gridCol w:w="3\d{3}"\/>/.test(plain.doc));
check("表格内容完整", plain.doc.includes("几何1在几何2内部"));
check("行内 **加粗** 生效", /<w:b\/>[\s\S]{0,300}definitionExpression/.test(plain.doc));

/* ---------- 封面预设 ---------- */
const hero = await render({ ...base, cover: { ...base.cover, style: "hero", subtitle: "WebGIS 开发" } });
check("正式风：有分页", /w:br w:type="page"/.test(hero.doc) || (hero.doc.match(/<w:sectPr/g) || []).length >= 2);
check("正式风：标题居中", hero.doc.includes('w:jc w:val="center"') && hero.doc.includes("实验十一：属性查询与空间查询"));
check("正式风：学号姓名", hero.doc.includes("1004245121") && hero.doc.includes("黄玉琛"));
check("正式风：封面与正文分成两节", (hero.doc.match(/<w:sectPr/g) || []).length >= 2);

const legacyTable = normalizeReport({ cover: { style: "table", fields: [{ id: "f1", label: "指导教师", value: "王老师" }] }, sections: [] });
check("旧「表格式」封面降级为正式风", legacyTable.cover.style === "hero");

/* ---------- 页码 / 目录 ---------- */
const extra = await render({ ...base, options: { ...base.options, pageNumber: true, toc: true } });
const footer = (await extra.zip.file("word/footer1.xml")?.async("string")) ?? "";
check("页脚有页码域", /PAGE/.test(footer));
check("目录域存在", /instrText[^>]*>\s*TOC/.test(extra.doc));
check(
  "updateFields 已写入 settings",
  ((await extra.zip.file("word/settings.xml")?.async("string")) ?? "").includes("updateFields"),
);

/* ---------- 老数据迁移 ---------- */
const legacy = normalizeReport({
  meta: { order: "十", topic: "图形图层" },
  sections: [
    {
      id: "s1",
      title: "一、实验目的",
      mode: "plain",
      steps: [{ id: "t1", blocks: [{ id: "x1", kind: "text", text: "旧数据没有 align 字段" }] }],
    },
  ],
});
const legacyBlock = legacy.sections[0].steps[0].blocks[0];
check("老草稿能读进来", legacy.sections.length === 1 && legacyBlock?.kind === "text");
check("缺失字段被补全", legacyBlock?.kind === "text" && legacyBlock.align === "left");
check("封面/排版选项被补全", legacy.cover.style === "plain" && legacy.options.bodySize === 24);

/* ---------- 向导页与进度 ---------- */
const pages = flattenPages(base);
const prog = projectProgress(base);
check("向导第 1 页是封面", pages[0].kind === "cover");
check(`共 8 页（封面 + 1 + 1 + 3 + 1 + 1，实际 ${pages.length}）`, pages.length === 8);
check(`进度统计（${prog.done}/${prog.total}，第 3 个步骤故意留空）`, prog.total === 7 && prog.done === 6);
check("默认导出文件名", reportFileName(base) === "实验十一_1004245121_黄玉琛_属性查询与空间查询.docx");
check(
  "自定义导出文件名",
  reportFileName({ ...base, options: { ...base.options, fileNamePattern: "{order}-{title}-{date}" } }) ===
    `十一-属性查询与空间查询-${todayString().replace(/\//g, "_")}.docx`,
);

/* ---------- 图片进不了 Word 时必须吱声（不能让交出去的文件静悄悄少内容） ---------- */
{
  const broken = sample();
  broken.sections[2].steps[0].blocks = [
    { id: "x1", kind: "image", dataUrl: "asset:deadbeef", caption: "图 1 查询结果", align: "center", widthPct: 0, captionPos: "below", w: 400, h: 300 },
    { id: "x2", kind: "image", dataUrl: "", caption: "", align: "center", widthPct: 0, captionPos: "below", w: 0, h: 0 },
  ];
  const r = await buildReportBlob(broken);
  check("读不出来的图片会给出导出警告", r.warnings.length === 1 && r.warnings[0].includes("1 张图片"), r.warnings.join("；"));
  check(
    "警告说得出是哪一页的哪张图",
    r.warnings[0].includes("使用SQL查询要素图层") && r.warnings[0].includes("查询结果"),
    r.warnings[0],
  );
  const zip = await JSZip.loadAsync(Buffer.from(await r.blob.arrayBuffer()));
  const doc = await zip.file("word/document.xml")!.async("string");
  check("图没导出去，图注至少留在文件里", doc.includes("图 1 查询结果"));
  check("故意留空的图片块整块跳过，不算丢内容", r.warnings.length === 1);
  check("正常工程不瞎报", (await buildReportBlob(sample())).warnings.length === 0);
}

/* ---------- 脏尺寸不能写出 cx="0" / NaN（Word 里会成坏图） ---------- */
{
  const dirty = sample();
  dirty.sections[2].steps[0].blocks = [
    { id: "d1", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: 0.05, captionPos: "below", w: 400, h: 300 },
    { id: "d2", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: NaN, captionPos: "below", w: NaN, h: NaN },
    { id: "d3", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: -50, captionPos: "below", w: 400, h: 300 },
    { id: "d4", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: 999999, captionPos: "below", w: 400, h: 300 },
    { id: "d5", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: 100, captionPos: "below", w: 400, h: 300 },
  ];
  const r = await buildReportBlob(dirty);
  const zip = await JSZip.loadAsync(Buffer.from(await r.blob.arrayBuffer()));
  const doc = await zip.file("word/document.xml")!.async("string");
  const ext = [...doc.matchAll(/<wp:extent cx="(-?\d+)" cy="(-?\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  check("脏尺寸仍各出一张图", ext.length === 5, `${ext.length}`);
  check("cx / cy 不出 0、负数和 NaN", ext.every(([cx, cy]) => cx > 0 && cy > 0), JSON.stringify(ext));
  check("widthPct 极小时仍然看得见", ext[0][0] >= 1, `${ext[0][0]}`);
  check("尺寸全 NaN 时按纸面宽度回退", ext[1][0] > 3000000 && ext[1][1] > 1, JSON.stringify(ext[1]));
  check("负 widthPct 退回原始宽度", ext[2][0] === 400 * 9525, `${ext[2][0]}`);
  check("超出纸面的宽度收到内容宽（与 100% 一致）", ext[3][0] === ext[4][0], `${ext[3][0]} vs ${ext[4][0]}`);
  check("脏尺寸不是丢内容，不该报警告", r.warnings.length === 0, r.warnings.join("；"));
}

/* ---------- 超宽截图：夹到版心后必须保持原比例（旧写法夹宽不夹高，会被横向压扁） ---------- */
{
  const wide = sample();
  wide.sections[2].steps[0].blocks = [
    { id: "w1", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: 0, captionPos: "below", w: 1920, h: 1080 },
    { id: "w2", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: 60, captionPos: "below", w: 1920, h: 1080 },
    { id: "w3", kind: "image", dataUrl: PNG_1x1, caption: "", align: "center", widthPct: 0, captionPos: "below", w: 1080, h: 1920 },
  ];
  const r = await buildReportBlob(wide);
  const zip = await JSZip.loadAsync(Buffer.from(await r.blob.arrayBuffer()));
  const doc = await zip.file("word/document.xml")!.async("string");
  const ext = [...doc.matchAll(/<wp:extent cx="(-?\d+)" cy="(-?\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const near = ([cx, cy]: number[], ratio: number) => Math.abs(cy / cx - ratio) < 0.01;
  check("1920×1080 原尺寸导出仍是 16:9", near(ext[0], 1080 / 1920), `cy/cx=${(ext[0][1] / ext[0][0]).toFixed(3)}`);
  check("1920×1080 选 60% 宽也是 16:9", near(ext[1], 1080 / 1920), `cy/cx=${(ext[1][1] / ext[1][0]).toFixed(3)}`);
  check("竖图 1080×1920 夹宽后按高瘦长比输出", near(ext[2], 1920 / 1080), `cy/cx=${(ext[2][1] / ext[2][0]).toFixed(3)}`);
  check("超宽图确实被夹进版心", ext[0][0] / 9525 <= 651, `${(ext[0][0] / 9525).toFixed(0)}px`);
}

/* ---------- 输出 ---------- */
await fs.writeFile(path.join(outDir, "plain.docx"), plain.buf);
await fs.writeFile(path.join(outDir, "hero.docx"), hero.buf);
await fs.writeFile(path.join(outDir, "verify.styles.xml"), plain.styles, "utf8");
await fs.writeFile(path.join(outDir, "verify.document.xml"), plain.doc, "utf8");

let fails = 0;
for (const [name, ok, extraInfo] of checks) {
  if (!ok) fails += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${extraInfo ? `  (${extraInfo})` : ""}`);
}
console.log(
  `\n输出：scripts/out/plain.docx (${(plain.buf.length / 1024).toFixed(1)} KB)、hero.docx`,
);
console.log(fails === 0 ? "导出检查全部通过 ✅" : `${fails} 项未通过 ❌`);
if (fails > 0) process.exitCode = 1;
