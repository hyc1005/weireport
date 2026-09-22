/**
 * UI 冒烟测试：在 Node 里把各主要组件首屏渲染一遍（不用开浏览器）
 * 用法：npm run verify:render
 */
import { renderToString } from "react-dom/server";
import "fake-indexeddb/auto";
import App from "../src/App";
import { Home } from "../src/components/Home";
import { ImportPreview } from "../src/components/ImportPreview";
import type { ImportParse } from "../src/docx/parse";
import { CoverPanel, CoverPreview } from "../src/components/CoverPanel";
import { BlockCard, type BlockApi } from "../src/components/BlockCard";
import { Outline } from "../src/components/Outline";
import { WizardBar } from "../src/components/WizardBar";
import { clearAuthorPrefs, createReport, readAuthorPrefs, saveAuthorPrefs, withStoredAuthor } from "../src/template";
import { afterBlock, insertBlock } from "../src/reportOps";
import { textBlock as makeTextBlock } from "../src/types";
import { deadlineChip, deadlineLabel, deadlineTone, flattenPages, planDeadline } from "../src/wizard";
import {
  MAX_SEQ,
  analyzeSequence,
  analyzeSequenceAcross,
  formatSeq,
  insertSequence,
  isListItemLine,
  parsePrefix,
} from "../src/numbering";
import type { ProjectSummary } from "../src/storage";
import type { Block } from "../src/types";

const noop = () => {};
const api: BlockApi = {
  patch: noop,
  remove: noop,
  move: noop,
  captureInto: noop,
  clipboardImageInto: noop,
  clipboardTextInto: noop,
  uploadInto: noop,
};

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

/** renderToString 会在相邻文本节点间插注释，比较文案前先去掉 */
function flat(node: unknown): string {
  return renderToString(node as never).replace(/<!--.*?-->/g, "");
}

/* ---------------- 首页 ---------------- */
const emptyHome = flat(
  <Home
    projects={[]}
    onOpen={noop}
    onNew={noop}
    onCreateFrom={noop}
    onDuplicate={noop}
    onDelete={noop}
    onRename={noop}
    onExportJson={noop}
    onImportJson={noop}
    onImportDocx={noop}
  />,
);
check("首页：空状态", emptyHome.includes("还没有任何工程") && emptyHome.includes("新建第一个工程"));
check("首页：只有标题行没有营销版块", emptyHome.includes("我的实验报告") && !emptyHome.includes("template-feature"));
check("首页：Word 导入先预览再建工程", emptyHome.includes("从 Word 导入结构") && emptyHome.includes("层级预览"));

/* ---------------- 顶层路由：没有工程时 App 本身也要渲染得出来 ---------------- */
let appErr = "";
let appHtml = "";
try {
  appHtml = flat(<App />);
} catch (e) {
  appErr = e instanceof Error ? e.message : String(e);
}
check(`App 首屏不崩${appErr ? `（${appErr}）` : ""}`, appErr === "");
check("App 首屏就是工程列表", appHtml.includes("新建工程") && appHtml.includes("从 Word 导入结构"));

/* ---------------- Word 导入预览 ---------------- */
const previewParsed: ImportParse = {
  items: [
    { index: 0, kind: "para", text: "实验目的", level: "section", prefix: "一、", evidence: ["样式「heading 2」是标题 2"], confidence: 0.95, coverGuess: false },
    { index: 1, kind: "para", text: "加载图层", level: "step", prefix: "（1）", evidence: ["手写编号"], confidence: 0.6, coverGuess: false },
    { index: 2, kind: "table", text: "1 行 × 3 列 · 图层", rows: [["图层", "来源", "用途"]], level: "body", prefix: "", evidence: ["表格：整块导入"], confidence: 1, coverGuess: false },
    {
      index: 3,
      kind: "image",
      text: "image3.png 320×240px",
      image: { dataUrl: "data:image/png;base64,AAAA", w: 320, h: 240, name: "image3.png", bytes: 20480 },
      level: "body",
      prefix: "",
      evidence: ["内嵌图片：按原文位置导入"],
      confidence: 1,
      coverGuess: false,
    },
  ],
  warnings: ["1 张内嵌图片没能导入（EMF/WMF 等格式、引用断了，或小得像装饰），位置会空着"],
  docTitle: "网络地理信息系统实验",
  sections: 1,
  steps: 1,
  tables: 1,
  images: 1,
  numbered: 0,
  skippedImages: 1,
};
const previewHtml = flat(
  <ImportPreview fileName="示例.docx" parsed={previewParsed} onClose={noop} onConfirm={noop} />,
);
check("导入预览：一行一项，级别可改", previewHtml.includes("实验目的") && (previewHtml.match(/<select/g)?.length ?? 0) === 4);
check("导入预览：编号去了哪看得见", previewHtml.includes("一、") && previewHtml.includes("（1）"));
check("导入预览：把握不足的行走黄底", previewHtml.includes("import-row low") && previewHtml.includes("1 行判定把握不足"));
check("导入预览：表格与漏读图片都报出来", previewHtml.includes("表格") && previewHtml.includes("没能读出"));
check(
  "导入预览：图片行带缩略图，且只能选正文或忽略",
  previewHtml.includes("import-thumb") && previewHtml.includes("张图片") && (previewHtml.match(/<option/g)?.length ?? 0) === 3 * 4 + 2,
);
check("导入预览：确认之前只有按钮", previewHtml.includes("确认导入") && previewHtml.includes("按纯文本导入") && !previewHtml.includes("已保存"));

const project: ProjectSummary = {
  id: "p1",
  name: "实验十一 属性查询",
  order: "十一",
  topic: "属性查询与空间查询",
  coverStyle: "hero",
  createdAt: Date.now(),
  updatedAt: Date.now() - 120000,
  done: 6,
  total: 7,
  due: "",
};
/** 距今 3 天的截止日期，用来验倒计时徽标 */
function isoIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const dueProject: ProjectSummary = { ...project, id: "p2", name: "实验十二 缓冲区分析", done: 2, total: 9, due: isoIn(3) };
const listHome = flat(
  <Home
    projects={[project, dueProject]}
    onOpen={noop}
    onNew={noop}
    onCreateFrom={noop}
    onDuplicate={noop}
    onDelete={noop}
    onRename={noop}
    onExportJson={noop}
    onImportJson={noop}
  />,
);
check("首页：工程卡片", listHome.includes("实验十一 属性查询") && listHome.includes("实验十一"));
check("首页：进度与封面标签", listHome.includes("6/7 项") && listHome.includes("正式风"));
check("首页：设了截止日期的卡片带倒计时", listHome.includes("剩 3 天") && listHome.includes("deadline-chip"));
check("首页：没设截止日期的卡片不显示倒计时", (listHome.match(/deadline-chip/g)?.length ?? 0) === 1);

/* ---------------- 截止日期反推：纯逻辑 ---------------- */
const monday = new Date(2026, 8, 19); // 2026-09-19 本地
const plan3 = planDeadline("2026-09-22", 12, monday)!;
check("倒计时：隔 3 天差 12 项 → 每天 4 项", plan3.daysLeft === 3 && plan3.perDay === 4);
check("倒计时：文案", deadlineLabel(plan3) === "剩 3 天 · 还差 12 项 → 每天 4 项");
check("倒计时：当天到期按今天算", planDeadline("2026-09-19", 5, monday)!.perDay === 5 && deadlineTone(planDeadline("2026-09-19", 5, monday)!) === "danger");
check("倒计时：逾期", planDeadline("2026-09-17", 2, monday)!.daysLeft === -2 && deadlineLabel(planDeadline("2026-09-17", 2, monday)!).startsWith("已逾期 2 天"));
check("倒计时：填满后不再催", deadlineLabel(planDeadline("2026-09-17", 0, monday)!).includes("内容已填满") && deadlineTone(planDeadline("2026-09-17", 0, monday)!) === "calm");
check("倒计时：31 天差 12 项也至少每天一项", planDeadline("2026-10-20", 12, monday)!.perDay === 1);
check("倒计时：没填或填坏就不显示", planDeadline("", 5, monday) === null && planDeadline("9/22", 5, monday) === null && planDeadline("2026-13-45", 5, monday) === null);
check("倒计时：短版本", deadlineChip(plan3) === "剩 3 天" && deadlineChip(planDeadline("2026-09-20", 1, monday)!) === "明天到期");
check("首页：卡片只留「打开 + ⋯」", listHome.includes("打开") && listHome.includes("更多操作") && !listHome.includes("重命名"));

/* ---------------- 封面预览三种风格 ---------------- */
const report = createReport({
  order: "十一",
  topic: "属性查询与空间查询",
  studentId: "1004245121",
  name_: "黄玉琛",
});

const plainCv = flat(<CoverPreview report={report} />);
check("封面·简洁风：标题 + 学号姓名", plainCv.includes("实验十一：属性查询与空间查询") && plainCv.includes("1004245121"));

const heroCv = flat(<CoverPreview report={{ ...report, cover: { ...report.cover, style: "hero" } }} />);
check("封面·正式风：大字标题 + 分页标记", heroCv.includes("cv-hero") && heroCv.includes("— 分页 —"));
check("封面·正式风：学号姓名分行", heroCv.includes("学号：1004245121") && heroCv.includes("姓名：黄玉琛"));

const refCv = flat(<CoverPreview report={{ ...report, cover: { ...report.cover, style: "reference" } }} />);
check("封面·课程报告：大字标题 + 学号姓名", refCv.includes("cv-reference") && refCv.includes("学号：1004245121"));

/* ---------------- 大标题在纸面上就地改（不再靠旁边的输入框） ---------------- */
const editCv = flat(
  <CoverPreview
    report={{ ...report, cover: { ...report.cover, style: "reference" } }}
    onTitle={noop}
  />,
);
check(
  "大标题就地可编辑：纸面上带 data-inplace 标题元素（点一下就地变输入框，不另开文本框）",
  editCv.includes('data-inplace="title"') && editCv.includes("点一下直接改"),
);
check(
  "大标题就地可编辑：就地元素带 reference-title 排版类（点一下才变输入框，平时与排版一致）",
  editCv.includes("reference-title"),
);
check(
  "纯预览不给 onTitle 时不出现就地编辑元素（导出/打印走的路仍是纯文字）",
  !refCv.includes('data-inplace="title"'),
);

/* ---------------- 学号姓名在本机记住 ---------------- */
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});
clearAuthorPrefs();
check(
  "记住学号姓名：写进去能读回来",
  saveAuthorPrefs({ studentId: " 1004245121 ", name: " 黄玉琛 " }) &&
    readAuthorPrefs()?.studentId === "1004245121" &&
    readAuthorPrefs()?.name === "黄玉琛",
);
check(
  "记住学号姓名：新建工程自动带上，不用再手填",
  createReport().meta.studentId === "1004245121" && createReport().meta.name === "黄玉琛",
);
check(
  "记住学号姓名：显式传入的值优先，不被本机记忆覆盖",
  createReport({ studentId: "999", name_: "别的同学" }).meta.studentId === "999" &&
    createReport({ studentId: "999", name_: "别的同学" }).meta.name === "别的同学",
);
const blankReport = createReport();
blankReport.meta.studentId = "";
blankReport.meta.name = "";
check(
  "记住学号姓名：老工程 / 导入件里空着的会补上",
  withStoredAuthor(blankReport).meta.studentId === "1004245121" &&
    withStoredAuthor(blankReport).meta.name === "黄玉琛",
);
const namedReport = createReport({ studentId: "111", name_: "已填过" });
check("记住学号姓名：已经填过的绝不覆盖", withStoredAuthor(namedReport).meta.studentId === "111");
clearAuthorPrefs();
check(
  "记住学号姓名：可以忘掉（忘掉后新建工程不再自动带）",
  readAuthorPrefs() === null && createReport().meta.studentId === "",
);

const panel = flat(<CoverPanel report={report} onCover={noop} />);
check(
  "封面面板：只剩 3 种预设（表格式已下线）",
  panel.includes("课程报告") && panel.includes("正式风") && panel.includes("简洁风") && !panel.includes("表格式"),
);
check("封面面板：标题/副标题输入", panel.includes("副标题 / 课程名") && panel.includes("显示学号姓名"));
check("封面面板：没有信息表编辑器", !panel.includes("加一行"));

/* ---------------- 四种块 ---------------- */
const textBlock: Block = { id: "t1", kind: "text", text: "（1）添加模块：", align: "center" };
const textCard = flat(<BlockCard block={textBlock} index={0} options={report.options} api={api} busy={null} />);
check("文字块：编辑区 + 水平居中", textCard.includes("（1）添加模块：") && textCard.includes("text-align:center"));
check("文字块：快捷粘贴", textCard.includes("粘贴到这里") && !textCard.includes("句式"));
check("文字块：对齐属性条", textCard.includes("segmented") && textCard.includes("首行缩进"));

/* 跨块连续：同一步骤里的第二个文字块要接着第一个块数 */
const blockA: Block = { id: "ta", kind: "text", text: "（1）打开 ArcMap\n（2）加载图层\n（3）设置符号", align: "left" };
const blockB: Block = { id: "tb2", kind: "text", text: "", align: "left" };
const stepBlocks = [
  { blockId: "ta", text: blockA.text },
  { blockId: "tb2", text: blockB.text },
];
const cardB = flat(
  <BlockCard block={blockB} index={1} options={report.options} api={api} busy={null} numbering={stepBlocks} />,
);
check(
  "文字块：序号跨块续上，第二块的下一个是（4）",
  /class="num-chip next" title="插入 （4）"/.test(cardB) && !/class="num-chip next" title="插入 （1）"/.test(cardB),
);
const cardSolo = flat(<BlockCard block={blockB} index={1} options={report.options} api={api} busy={null} />);
check("文字块：不传 numbering 时行为不变（下一个仍是（1））", /class="num-chip next" title="插入 （1）"/.test(cardSolo));

const codeBlock: Block = { id: "c1", kind: "code", lang: "js", code: "const a = 1;", showLang: true, boxed: true };
const codeCard = flat(<BlockCard block={codeBlock} index={1} options={report.options} api={api} busy={null} />);
check("代码块：语言选择 + 底纹开关", codeCard.includes("粘贴代码到光标处") && codeCard.includes("底纹边框") && codeCard.includes("显示语言标签"));

const imageBlock: Block = {
  id: "i1",
  kind: "image",
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  caption: "",
  align: "right",
  widthPct: 80,
  captionPos: "below",
  w: 100,
  h: 50,
};
const imageCard = flat(
  <BlockCard block={imageBlock} index={2} options={report.options} api={api} busy={null} figureNo={3} />,
);
check("图片块：截图/贴图按钮", imageCard.includes("截取当前窗口") && imageCard.includes("贴剪贴板图片"));
check("图片块：右对齐 + 宽度 + 图注编号", imageCard.includes("text-align:right") && imageCard.includes("图 3"));

const tableBlock: Block = {
  id: "tb1",
  kind: "table",
  headerRow: true,
  rows: [
    ["操作符", "含义"],
    ["Contains", "包含"],
  ],
};
const tableCard = flat(<BlockCard block={tableBlock} index={3} options={report.options} api={api} busy={null} />);
check("表格块：单元格可编辑 + 表头开关", tableCard.includes("操作符") && tableCard.includes("首行作为表头"));

/* ---------------- 导航与向导条 ---------------- */
const outline = flat(
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
check(
  "导航：封面 + 五个小节 + 加一步",
  ["封面", "一、实验目的", "三、实验步骤", "五、实验总结", "加一步", "加一个小节"].every((t) => outline.includes(t)),
);

const pages = flattenPages(report);
const bar = flat(
  <WizardBar
    index={0}
    total={pages.length}
    label={pages[0].label}
    filled
    busy={false}
    onPrev={noop}
    onNext={noop}
    onFinish={noop}
    onHome={noop}
  />,
);
check("向导条：进度 + 下一步 + 回首页", bar.includes("1/8") && bar.includes("下一步") && bar.includes("wizard-fill"));

/* ---------------- 分级序号：纯逻辑 ---------------- */
check(
  `四级序号字形（${formatSeq(1, 1)} ${formatSeq(2, 1)} ${formatSeq(3, 1)} ${formatSeq(4, 1)}）`,
  formatSeq(1, 1) === "（1）" && formatSeq(2, 1) === "a)" && formatSeq(3, 1) === "①" && formatSeq(4, 1) === "1)",
);
check("第 3 个二级序号是 c)", formatSeq(2, 3) === "c)");
check("第 27 个二级序号进位到 aa)", formatSeq(2, 27) === "aa)");
check(
  "序号能被反解出来",
  parsePrefix("（12）内容")?.level === 1 &&
    parsePrefix("（12）内容")?.n === 12 &&
    parsePrefix("c) 子项")?.level === 2 &&
    parsePrefix("c) 子项")?.n === 3 &&
    parsePrefix("③子项")?.level === 3 &&
    parsePrefix("③子项")?.n === 3 &&
    parsePrefix("7) 子项")?.level === 4 &&
    parsePrefix("7) 子项")?.n === 7 &&
    parsePrefix("普通文字") === null,
);

const lv = analyzeSequence("", 0);
check("空文本：只有一级可用", lv[0].available && !lv[1].available && !lv[2].available && !lv[3].available);
check("空文本：一级只给出 1 个", lv[0].chips.length === 1 && lv[0].next === 1);

const lv3 = analyzeSequence("（1）一\n（2）二\n（3）三\n", 12);
check("同一级用到第 3 个 → 自动多给出第 4 个", lv3[0].next === 4 && lv3[0].chips.join() === "1,2,3,4");
check("用过一级之后二级才出现", lv3[1].available);

const twoLv = analyzeSequence("（1）一\na) A\nb) B\n", 12);
check("二级用到第 2 个 → 给出第 3 个", twoLv[1].next === 3 && twoLv[1].chips.join() === "1,2,3");
check("二级已用但三级还没出现（三级需要二级）", twoLv[2].available && !analyzeSequence("（1）一\n", 6)[2].available);
check("没有一级时二级整行隐藏", !analyzeSequence("普通文字", 4)[1].available);

const reset = analyzeSequence("（1）一\na) A\n（2）二\n", 12);
check("换了一级父项，二级计数重新从 a) 开始", reset[1].next === 1 && reset[1].used.length === 0);

const many = analyzeSequence(Array.from({ length: 60 }, (_, i) => `（${i + 1}）x`).join("\n"), 9999);
check(`同级上限 49（实际 ${many[0].next}）`, many[0].next === MAX_SEQ);

/* 收紧后的「这是一条列表项」判定 */
check(
  "isListItemLine：正常写法都算",
  ["（12）内容", "（1）ArcMap 打开", "c) 子项", "③子项", "7) 子项", "（1）"].every(isListItemLine),
);
check(
  "isListItemLine：代码与数字串不算",
  ["20)26年", "a){", "50)%", "普通文字", "for (const s of x)"].every((l) => !isListItemLine(l)),
);
check("误判的四级行不算进已用序号", analyzeSequence("（1）一\n1)2年\n", 12)[3].used.length === 0);

/* 跨块分析 */
check(
  "analyzeSequenceAcross 与 analyzeSequence 在单块时逐字段相同",
  [
    ["", 0],
    ["（1）一\n（2）二\n", 5],
    ["（1）一\na) A\n①甲\n1) 细项\n", 999],
    ["普通文字", 4],
  ].every(
    ([t, c]) =>
      JSON.stringify(analyzeSequence(t as string, c as number)) ===
      JSON.stringify(analyzeSequenceAcross([{ blockId: "b", text: t as string }], "b", c as number)),
  ),
);
const across = analyzeSequenceAcross(
  [
    { blockId: "b1", text: "（1）一\n（2）二" },
    { blockId: "b2", text: "（3）三" },
    { blockId: "b3", text: "" },
  ],
  "b3",
  0,
);
check("第二块的序号接着第一块数（下一个是（4））", across[0].next === 4);
check("焦点块之后的块不参与计数（b1 光标位只看 b1）", analyzeSequenceAcross([{ blockId: "b1", text: "（1）一" }, { blockId: "b2", text: "（2）二" }], "b1", 2)[0].next === 2);

const ins1 = insertSequence("添加模块：", 5, 1, 1);
check("行首插入序号且光标停在原文末尾", ins1.text === "（1）添加模块：" && ins1.caret === 8);

const ins2 = insertSequence("（1）第一点", 6, 2, 1);
check("已有序号的行 → 另起一行加子级（带全角缩进）", ins2.text === "（1）第一点\n　a)" && ins2.caret === ins2.text.length);

const ins3 = insertSequence("（1）一\na) A", 10, 2, 2);
check("二级续写为 b)", ins3.text === "（1）一\na) A\n　b)");

const ins4 = insertSequence("", 0, 3, 1);
check("空块直接插入三级序号", ins4.text === "　　①" && ins4.caret === 3);

/* ---------- 落点：粘贴 / 截图插入要跟着选中块，而不是永远追到文章最后（C4） ---------- */
{
  const rep = createReport({ order: "1", topic: "落点" });
  const sec = rep.sections[2];
  const step = sec.steps[0];
  let r = insertBlock(rep, sec.id, step.id, makeTextBlock("A")).report;
  r = insertBlock(r, sec.id, step.id, makeTextBlock("B")).report;
  const texts = (x: typeof r) => x.sections[2].steps[0].blocks.map((b) => (b.kind === "text" ? b.text : "?")).join(",");
  check("不给落点时追加到末尾", texts(insertBlock(r, sec.id, step.id, makeTextBlock("末尾")).report) === "A,B,末尾");
  check("给落点时插在选中块之后", texts(insertBlock(r, sec.id, step.id, makeTextBlock("中间"), 1).report) === "A,中间,B");
  check("落点 0 插到最前", texts(insertBlock(r, sec.id, step.id, makeTextBlock("头"), 0).report) === "头,A,B");
  check("落点越界自动收边", texts(insertBlock(r, sec.id, step.id, makeTextBlock("超"), 99).report) === "A,B,超");
  check("插入不动原报表", texts(r) === "A,B");

  // 落点位置统一由 afterBlock 算：粘贴 / 截图 / ＋插入 / 快捷键共用一套语义
  const blocks = r.sections[2].steps[0].blocks;
  check("选中第一个块 → 落点 1", afterBlock(blocks, blocks[0].id) === 1);
  check("选中最后一个块 → 落点就是末尾", afterBlock(blocks, blocks[blocks.length - 1].id) === blocks.length);
  check("没选中块 → 落点 undefined（追加）", afterBlock(blocks, null) === undefined);
  check("选中的块不在这页（切页后的残留选中态）→ 追加，不是插到最前面", afterBlock(blocks, "别的页的块") === undefined);
  check(
    "落点回喂 insertBlock 结果一致",
    texts(insertBlock(r, sec.id, step.id, makeTextBlock("跟着B"), afterBlock(blocks, blocks[1].id) ?? blocks.length).report) === "A,B,跟着B",
  );
}

let fails = 0;
for (const [name, ok] of checks) {
  if (!ok) fails += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
}
console.log(fails === 0 ? "\nUI 冒烟检查全部通过 ✅" : `\n${fails} 项未通过 ❌`);
if (fails > 0) process.exitCode = 1;
