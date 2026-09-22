/**
 * 标题编号一致性对拍（离线，不需要浏览器）
 *   同一份报告，把「目录 / 纸面 / 打印 / Markdown / 导出 Word」五个渲染点的
 *   编号序列抓出来，断言逐字符相同 —— 这是「左边 1/2、里面 A/B」那类问题的永久回归闸门。
 *
 *   抓取方式：五个点都用真实组件渲染，读 DOM 上的 data-no 与导出产物里的标题文字，
 *   不读测试自己的第二套算法，所以「实现改了测试没跟上」会直接红。
 * 用法：npm run verify:headings
 */
import { renderToStaticMarkup } from "react-dom/server";
import JSZip from "jszip";
import { buildReportBlob } from "../src/docx/build";
import { computeHeadings, formatHead, sectionsWithContinuedSteps, startsWithManualNumber } from "../src/headings";
import { createReport } from "../src/template";
import { reportToMarkdown } from "../src/markdown";
import { normalizeReport } from "../src/storage";
import { Outline } from "../src/components/Outline";
import { PrintDocument } from "../src/components/PrintDocument";
import { StepHeading } from "../src/components/PaperHeadings";
import { emptyBlock, sectionHasContent, type Block, type Report, type Section } from "../src/types";

const checks: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, extra?: string) {
  checks.push([name, ok, extra]);
}
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const shown = (v: string[]) => `[${v.join(",")}]`;
const noop = () => {};

function textOf(s: string): Block {
  return { id: `t_${Math.random().toString(36).slice(2)}`, kind: "text", align: "left", text: s };
}

/** 一个 plain 小节 + 两个 steps 小节；第二个 steps 小节里故意夹一个空占位步骤 */
function fixture(titles: string[], overrides: Partial<Report["options"]> = {}): Report {
  const r = createReport({ order: "十一", topic: "属性查询" });
  const sections: Section[] = r.sections;
  sections.length = 0;
  sections.push(
    { id: "sec-a", title: "实验目的", mode: "plain", required: true, steps: [{ id: "st-a", title: "", blocks: [textOf("掌握属性查询。")] }] },
    {
      id: "sec-b",
      title: "实验步骤",
      mode: "steps",
      required: true,
      steps: [
        { id: "b1", title: titles[0], blocks: [textOf("第一步。")] },
        { id: "b2", title: "", blocks: [emptyBlock("text")] }, // 空标题又没内容：不该占号
        { id: "b3", title: titles[1], blocks: [textOf("第三步。")] },
      ],
    },
    {
      id: "sec-c",
      title: "课堂任务",
      mode: "steps",
      required: false,
      steps: [{ id: "c1", title: titles[2], blocks: [textOf("任务。")] }],
    },
  );
  return { ...r, options: { ...r.options, ...overrides } };
}

const PLAIN = ["添加图形图层", "设置查询条件", "执行查询"];
const MANUAL = ["添加图形图层", "1. 我自己写了编号", "执行查询"];

/* ---------------- 期望值：只从 computeHeadings 取 ---------------- */

interface Expected {
  /** 小节编号本体，按文档顺序（不含被抑制的） */
  sectionNos: string[];
  /** 步骤编号本体，按文档顺序（不含被抑制的） */
  stepNos: string[];
  /** 步骤标题全文：编号 + 原标题 */
  stepWholes: string[];
  /** 小节标题全文 */
  sectionWholes: string[];
}

function expected(report: Report): Expected {
  const headings = computeHeadings(report);
  const e: Expected = { sectionNos: [], stepNos: [], stepWholes: [], sectionWholes: [] };
  for (const s of report.sections) {
    if (!s.title.trim() && !sectionHasContent(s)) continue; // 与导出/打印同一个「空节丢掉」规则
    const sl = headings.section(s.id);
    if (s.title.trim()) {
      e.sectionWholes.push(`${sl?.text ?? ""}${s.title.trim()}`.trimEnd());
      if (sl && sl.no) e.sectionNos.push(sl.no);
    }
    for (const st of s.steps) {
      const label = headings.step(`${s.id}:${st.id}`);
      if (!label) continue;
      if (label.no) e.stepNos.push(label.no);
      e.stepWholes.push(`${label.text}${st.title.trim()}`.trimEnd());
    }
  }
  return e;
}

/* ---------------- 抓取各渲染点 ---------------- */

/** 从真实 DOM 里分层抓编号：h2/section = 小节，h3/step = 步骤 */
function headsOf(html: string): { h2: string[]; h3: string[] } {
  const out = { h2: [] as string[], h3: [] as string[] };
  const push = (level: "h2" | "h3", no: string) => {
    if (no) out[level].push(no);
  };
  for (const m of html.matchAll(/<h([23])\b[^>]*?data-no="([^"]*)"/g)) push(m[1] === "2" ? "h2" : "h3", m[2]);
  for (const m of html.matchAll(/data-head="(section|step)"[^>]*?data-no="([^"]*)"/g)) push(m[1] === "section" ? "h2" : "h3", m[2]);
  return out;
}

function outlineHtml(report: Report): string {
  return renderToStaticMarkup(
    <Outline
      report={report}
      currentKey="cover"
      onJump={noop}
      onAddStep={noop}
      onRemoveStep={noop}
      onMoveStep={noop}
      onMoveSection={noop}
      onAddSection={noop}
      onRemoveSection={noop}
      onRenameSection={noop}
    />,
  );
}

/** 纸面：App.tsx 每次只渲染一页，标题用的就是 StepHeading，这里按文档顺序逐条渲染 */
function paperHtml(report: Report): string {
  const headings = computeHeadings(report);
  return report.sections
    .filter((s) => s.title.trim() || sectionHasContent(s))
    .flatMap((s) => s.steps.map((st) => ({ s, st })))
    .map(({ s, st }) =>
      renderToStaticMarkup(
        <StepHeading label={headings.step(`${s.id}:${st.id}`)} title={st.title} options={report.options} onTitle={noop} />,
      ),
    )
    .join("");
}

const unescapeXml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** 从 document.xml 里按大纲样式抓标题文字 */
async function docxHeadings(report: Report, style: string): Promise<string[]> {
  const { blob } = await buildReportBlob(report);
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const doc = await zip.file("word/document.xml")!.async("string");
  const paras = doc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  return paras
    .filter((p) => p.includes(`w:pStyle w:val="${style}"`))
    .map((p) => unescapeXml([...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join("")));
}

function markdownHeadings(md: string, level: string): string[] {
  return md
    .split("\n")
    .filter((l) => l.startsWith(`${level} `))
    .map((l) => l.slice(level.length + 1).trimEnd());
}

/** 五个渲染点：编号序列 + 标题全文，逐字符对齐 */
async function compareAll(name: string, report: Report) {
  const want = expected(report);
  const outline = headsOf(outlineHtml(report));
  const paper = headsOf(paperHtml(report));
  const print = headsOf(renderToStaticMarkup(<PrintDocument report={report} />));
  const md = reportToMarkdown(report);
  const mdH3 = markdownHeadings(md, "###");
  const mdH2 = markdownHeadings(md, "##");
  const [docxH3, docxH2] = await Promise.all([docxHeadings(report, "Heading3"), docxHeadings(report, "Heading2")]);

  check(
    `${name}：步骤编号 目录 = 纸面 = 打印`,
    same(outline.h3, paper.h3) && same(paper.h3, print.h3) && same(print.h3, want.stepNos),
    `目录${shown(outline.h3)} 纸面${shown(paper.h3)} 打印${shown(print.h3)} 期望${shown(want.stepNos)}`,
  );
  check(`${name}：小节编号 目录 = 打印`, same(outline.h2, print.h2) && same(print.h2, want.sectionNos), `目录${shown(outline.h2)} 打印${shown(print.h2)} 期望${shown(want.sectionNos)}`);
  check(
    `${name}：步骤标题全文 Markdown = 导出 Word`,
    same(mdH3, want.stepWholes) && same(docxH3, want.stepWholes),
    `MD${shown(mdH3)} DOCX${shown(docxH3)} 期望${shown(want.stepWholes)}`,
  );
  check(
    `${name}：小节标题全文 Markdown = 导出 Word`,
    same(mdH2, want.sectionWholes) && same(docxH2, want.sectionWholes),
    `MD${shown(mdH2)} DOCX${shown(docxH2)} 期望${shown(want.sectionWholes)}`,
  );
}

/* ---------------- 1. 基线：默认阿拉伯数字 + 默认「每小节重新」 ---------------- */
const base = fixture(PLAIN); // 不覆盖任何选项：走的就是 createReport 的默认值
check(
  "默认每小节重新：第二节从 1. 重来（不会出现「四的第一条是 3.」）",
  same(expected(base).stepNos, ["1.", "2.", "1."]),
  expected(base).stepNos.join(","),
);
check(
  "空标题又没内容的占位步骤不占号（编号序列既无空洞也无空位），且第一条恒为 1.",
  expected(base).stepWholes.length === 3 && expected(base).stepNos[0] === "1.",
  expected(base).stepWholes.join(" | "),
);
check("默认值就是每小节重新（不是全文连续）", base.options.stepRestart === "section", base.options.stepRestart);
await compareAll("默认设置（每节重新）", base);

/* ---------------- 1b. 显式选择「全文连续」：下一节接着数 ---------------- */
const docMode = fixture(PLAIN, { stepRestart: "document" });
check(
  "全文连续（显式选择）：空占位不占号，下一节接着数到 3.",
  same(expected(docMode).stepNos, ["1.", "2.", "3."]),
  expected(docMode).stepNos.join(","),
);
await compareAll("全文连续（显式选择）", docMode);
check(
  "设置里的「按小节重排」只在真的出现「本节第一条不是 1.」时才提示",
  sectionsWithContinuedSteps(docMode) === 1 && sectionsWithContinuedSteps(base) === 0,
  `全文连续=${sectionsWithContinuedSteps(docMode)} 每节重新=${sectionsWithContinuedSteps(base)}`,
);

/* ---------------- 2. 沿用作者自带编号：抑制显示但仍占号 ---------------- */
const manual = fixture(MANUAL);
const manualDoc = fixture(MANUAL, { stepRestart: "document" }); // 手写编号最容易被重计范围影响，两种都看
const b3 = computeHeadings(manual).step("sec-b:b3");
check("标题自己写了编号 → 判定为手写", startsWithManualNumber("1. 我自己写了编号") && !startsWithManualNumber("添加图形图层"));
check(
  "手写编号的那条不叠加系统编号，但仍占号（所以最后一条是 3.）",
  b3 !== null && b3.suppressed && b3.n === 2 && b3.no === "",
  b3 ? `n=${b3.n} suppressed=${b3.suppressed} no="${b3.no}"` : "null",
);
check(
  "全文连续 + 手写编号：抑制会让可见编号看起来跳号（1. 3.，导出结果与作者手写编号一致，这是取舍）",
  same(expected(manualDoc).stepNos, ["1.", "3."]),
  expected(manualDoc).stepNos.join(","),
);
check(
  "默认每节重新 + 手写编号：第二节的手写「1.」不再吞掉本节的 1. 号（可见 1. 1.，但两节都从 1. 起）",
  same(expected(manual).stepNos, ["1.", "1."]),
  expected(manual).stepNos.join(","),
);
check(
  "被抑制的标题原文一字不改地导出（不丢字）",
  expected(manual).stepWholes[1] === "1. 我自己写了编号",
  expected(manual).stepWholes.join(" | "),
);
await compareAll("含手写编号", manual);
await compareAll("含手写编号 + 全文连续", manualDoc);

/* ---------------- 3. 字形与重计范围 ---------------- */
const alphaDoc = fixture(PLAIN, { stepGlyph: "alpha", stepRestart: "document" });
const alphaSec = fixture(PLAIN, { stepGlyph: "alpha", stepRestart: "section" });
check(
  "全文连续：第二节接着数到 C.",
  same(expected(alphaDoc).stepNos, ["A.", "B.", "C."]),
  expected(alphaDoc).stepNos.join(","),
);
check(
  "每小节重新：第二节从 A. 重新开始",
  same(expected(alphaSec).stepNos, ["A.", "B.", "A."]),
  expected(alphaSec).stepNos.join(","),
);
await compareAll("字母字形", alphaDoc);
await compareAll("字母字形 + 每节重新", alphaSec);
check("第 26 个字母编号是 Z.", formatHead("alpha", 26) === "Z.");
check("第 27 个字母编号进位到 AA.（不再是 [）", formatHead("alpha", 27) === "AA.", formatHead("alpha", 27));
check("中文字形", formatHead("chinese", 1) === "一、" && formatHead("chinese", 11) === "十一、" && formatHead("chinese", 20) === "二十、");
check("罗马字形", formatHead("roman", 4) === "IV." && formatHead("roman", 9) === "IX.");
check("括号字形", formatHead("paren", 3) === "（3）");
check("none 字形不产生任何编号", formatHead("none", 3) === "");
await compareAll("中文字形", fixture(PLAIN, { stepGlyph: "chinese" }));
await compareAll("罗马字形", fixture(PLAIN, { stepGlyph: "roman" }));
await compareAll("完全不编号", fixture(PLAIN, { stepGlyph: "none" }));

/* ---------------- 4. 小节编号 ---------------- */
const secCn = fixture(PLAIN, { sectionGlyph: "chinese" });
check(
  "小节编号与步骤编号各算各的：小节 一、二、三，步骤每节从 1. 重来（1.2. 1.）",
  same(headsOf(renderToStaticMarkup(<PrintDocument report={secCn} />)).h2, ["一、", "二、", "三、"]) &&
    same(headsOf(renderToStaticMarkup(<PrintDocument report={secCn} />)).h3, ["1.", "2.", "1."]),
  JSON.stringify(headsOf(renderToStaticMarkup(<PrintDocument report={secCn} />))),
);
await compareAll("小节也编号", secCn);

const secDup = fixture(PLAIN, { sectionGlyph: "chinese" });
secDup.sections[0].title = "一、实验目的"; // 作者已经手写了小节编号
const dup = headsOf(renderToStaticMarkup(<PrintDocument report={secDup} />));
check(
  "小节标题里已手写编号 → 不重复叠加（第一条只剩作者自己的），后续仍占号",
  same(dup.h2, ["二、", "三、"]) && same(dup.h3, ["1.", "2.", "1."]),
  JSON.stringify(dup),
);
check("叠加后不会出现「一、一、实验目的」这种双编号", !renderToStaticMarkup(<PrintDocument report={secDup} />).includes("一、一、"));
await compareAll("小节含手写编号", secDup);

/* ---------------- 5. 空节 / 空步骤：五个点一起丢 ---------------- */
const withEmpty = fixture(PLAIN);
withEmpty.sections.push({ id: "sec-d", title: "", mode: "steps", required: false, steps: [{ id: "d1", title: "", blocks: [] }] });
withEmpty.sections.push({ id: "sec-e", title: "有标题但这一节还空着", mode: "steps", required: false, steps: [{ id: "e1", title: "", blocks: [emptyBlock("text")] }] });
await compareAll("含空节", withEmpty);

/* ---------------- 6. 老工程打开时补默认值 ---------------- */
const legacyPlain = normalizeReport({ cover: { style: "plain" }, sections: [] });
const legacyRef = normalizeReport({ cover: { style: "reference" }, sections: [] });
check(
  "新建工程默认：简洁封面 → 1. 2. 3.，每小节重新，小节不编号",
  createReport().options.stepGlyph === "arabic" &&
    createReport().options.stepRestart === "section" &&
    createReport().options.sectionGlyph === "none",
);
check(
  "老工程（缺失或非法值）补默认：简洁封面 → 1. 2. 3.，小节不编号",
  legacyPlain.options.stepGlyph === "arabic" && legacyPlain.options.stepRestart === "document" && legacyPlain.options.sectionGlyph === "none",
);
check(
  "老工程里存过的重计范围原样保留（不偷改用户选择）",
  normalizeReport({ options: { stepRestart: "section" }, sections: [] }).options.stepRestart === "section" &&
    normalizeReport({ options: { stepRestart: "document" }, sections: [] }).options.stepRestart === "document",
);
check(
  "老工程默认：课程报告封面 → A. B. C.（封面三元只活在默认值这一处）",
  legacyRef.options.stepGlyph === "alpha",
);
check(
  "非法字形值回落，不会渲染出 undefined.",
  normalizeReport({ cover: { style: "plain" }, options: { stepGlyph: "elvish" }, sections: [] }).options.stepGlyph === "arabic",
);
check(
  "存过的新设置不会被默认值覆盖",
  normalizeReport({ cover: { style: "reference" }, options: { stepGlyph: "chinese", stepRestart: "section" }, sections: [] }).options.stepGlyph === "chinese",
);

let fails = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) fails += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && extra ? `  (实际 ${extra})` : ""}`);
}
console.log(fails === 0 ? "\n标题编号对拍全部通过 ✅" : `\n${fails} 项未通过 ❌`);
if (fails > 0) process.exitCode = 1;
