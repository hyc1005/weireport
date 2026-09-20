/**
 * Word 导入自检（离线，不需要浏览器）
 *   三份合成语料（套样式 / 纯手写编号 / Word 自动编号）＋ demo/ 里真实导出的报告，
 *   对手标答案验收四条硬线：
 *     · 层级判定 ≥90% 命中；
 *     · 自动编号项 0 丢失（每段编号都算回文字）；
 *     · 表格 0 散成正文；
 *     · 「永不掉字」——原文每个非空段落，都能在结果里找回来。
 * 用法：npm run verify:import
 */
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import fs from "node:fs/promises";
import path from "node:path";
import { buildReportBlob } from "../src/docx/build";
import { parseDocx, type ImportParse } from "../src/docx/parse";
import { MAX_LINES_PER_BLOCK, buildReportFromItems, makeImagePreparer, plainTextOverrides } from "../src/templateImport";
import { createReport } from "../src/template";
import type { Block, Report } from "../src/types";

// parse.ts 用浏览器全局 DOMParser，node 里补一个
(globalThis as unknown as { DOMParser: unknown }).DOMParser = XmlDomParser;

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const checks: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, extra?: string) {
  checks.push([name, ok, extra]);
}

/** 工程里所有图片块，摊平到一条列表上好用检查 */
function imageBlocks(report: Report) {
  return report.sections
    .flatMap((s) => s.steps.flatMap((st) => st.blocks))
    .filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image");
}

/* ---------------- 造 .docx ---------------- */

interface ParaOpts {
  style?: string;
  bold?: boolean;
  size?: number;
  font?: string;
  firstLineChars?: number;
  num?: { id: string; ilvl: number };
  pageBreak?: boolean;
  /** bare = 有 w:drawing 但引用断了；real = 一张能读出来的内嵌图 */
  drawing?: "bare" | "real";
}

const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** 96×96px 的图框（EMU）：既过了解析器「小得像装饰」那条线，也够预览画缩略图 */
const PIC_EMU = 914400;

const DRAWING_BARE = `<w:r><w:drawing><wp:inline xmlns:wp="${WP_NS}"/></w:drawing></w:r>`;
const DRAWING_REAL =
  `<w:r><w:drawing><wp:inline xmlns:wp="${WP_NS}"><wp:extent cx="${PIC_EMU}" cy="${PIC_EMU}"/><wp:docPr id="1" name="图片 1"/>` +
  `<a:graphic xmlns:a="${A_NS}"><a:graphicData uri="${PIC_NS}"><pic:pic xmlns:pic="${PIC_NS}">` +
  `<pic:blipFill><a:blip xmlns:r="${R_NS}" r:embed="rId100"/></pic:blipFill>` +
  `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

function para(text: string, o: ParaOpts = {}): string {
  const props: string[] = [];
  if (o.style) props.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.num) props.push(`<w:numPr><w:ilvl w:val="${o.num.ilvl}"/><w:numId w:val="${o.num.id}"/></w:numPr>`);
  if (o.firstLineChars) props.push(`<w:ind w:firstLineChars="${o.firstLineChars}"/>`);
  const rpr = [
    o.bold ? "<w:b/>" : "",
    o.size ? `<w:sz w:val="${o.size}"/>` : "",
    o.font ? `<w:rFonts w:eastAsia="${o.font}"/>` : "",
  ].join("");
  const runText = text ? `<w:r>${rpr}<w:t xml:space="preserve">${text}</w:t></w:r>` : "";
  const drawing = o.drawing === "real" ? DRAWING_REAL : o.drawing === "bare" ? DRAWING_BARE : "";
  return `<w:p><w:pPr>${props.join("")}</w:pPr>${o.pageBreak ? '<w:r><w:br w:type="page"/></w:r>' : ""}${drawing}${runText}</w:p>`;
}

function table(rows: string[][], picInLastCell = false): string {
  return `<w:tbl>${rows
    .map((r, ri) =>
      `<w:tr>${r
        .map(
          (c, ci) =>
            `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r>${
              picInLastCell && ri === rows.length - 1 && ci === r.length - 1 ? DRAWING_REAL : ""
            }</w:p></w:tc>`,
        )
        .join("")}</w:tr>`,
    )
    .join("")}</w:tbl>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>
</w:styles>`;

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimalEnclosedCircle"/><w:lvlText w:val="%3"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

async function makeDocx(
  body: string,
  extra: { styles?: string; numbering?: string; media?: boolean } = {},
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  if (extra.styles) zip.file("word/styles.xml", extra.styles);
  if (extra.numbering) zip.file("word/numbering.xml", extra.numbering);
  if (extra.media) {
    // 解析器只看引用和体积，不解码像素，所以这里塞一坨够大的字节就相当于一张真图
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId100" Type="${R_NS}/image" Target="media/image1.png"/></Relationships>`);
    zip.file("word/media/image1.png", new Uint8Array(4096).fill(7));
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

/* ---------------- 校验工具 ---------------- */

const norm = (s: string) => s.replace(/[\s\u3000]+/g, "");

/** 原文每个非空段落必须能在解析结果里找回来（标题允许「编号 + 正文」两段拼出来） */
async function missingParagraphs(bytes: ArrayBuffer, parsed: ImportParse): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const hay = norm(
    parsed.items
      .map((i) => `${i.prefix}${i.text}${i.rows ? i.rows.flat().join("") : ""}`)
      .join("\n"),
  );
  const out: string[] = [];
  for (const p of Array.from(dom.getElementsByTagNameNS(W, "p"))) {
    const text = norm(Array.from(p.getElementsByTagNameNS(W, "t")).map((t) => t.textContent ?? "").join(""));
    if (text && !hay.includes(text)) out.push(text);
  }
  return out;
}

/** 手标答案：段落原文 → 期望等级 */
type Expect = Array<[string, string]>;

function levelAccuracy(parsed: ImportParse, expect: Expect) {
  const byText = new Map<string, string>();
  for (const [text, level] of expect) byText.set(norm(text), level);
  let hit = 0;
  let total = 0;
  const wrong: string[] = [];
  for (const item of parsed.items) {
    const want = byText.get(norm(item.kind === "table" ? item.text : `${item.prefix}${item.text}`));
    const want2 = want ?? byText.get(norm(item.text));
    if (!want2) continue; // 语料里没标的行（自动编号原文没文字等）不参与评分
    total += 1;
    if (want2 === item.level) hit += 1;
    else wrong.push(`${item.text.slice(0, 18)}：期望 ${want2} 实际 ${item.level}`);
  }
  return { ratio: total ? hit / total : 0, wrong, total };
}

/* ---------------- 语料 A：套了 Word 标题样式 ---------------- */

const corpusA = [
  para("网络地理信息系统实验报告", { style: "Heading1", size: 44, bold: true }),
  para("学号：1004245121"),
  para("姓名：黄玉琛"),
  para("一、实验目的", { style: "Heading2", bold: true }),
  para("掌握图层加载与属性查询的方法。"),
  para("（1）加载要素图层", { style: "Heading3", bold: true }),
  para("打开 ArcMap，通过 Catalog 连接发布好的地图服务，把图层加进来。"),
  table([["图层", "来源", "用途"], ["道路", "地图服务", "缓冲区分析"]], true),
  para("", { drawing: "real" }),
  para("二、实验步骤", { style: "Heading2", bold: true, pageBreak: true }),
  para("（2）设置符号系统", { style: "Heading3", bold: true }),
];

const expectA: Expect = [
  ["网络地理信息系统实验报告", "ignore"],
  ["学号：1004245121", "ignore"],
  ["姓名：黄玉琛", "ignore"],
  ["一、实验目的", "section"],
  ["（1）加载要素图层", "step"],
  ["二、实验步骤", "section"],
  ["（2）设置符号系统", "step"],
];

const bytesA = await makeDocx(corpusA.join(""), { styles: STYLES_XML, media: true });
const parsedA = await parseDocx(bytesA);

{
  const acc = levelAccuracy(parsedA, expectA);
  check(`A 样式语料：层级命中 ${(acc.ratio * 100).toFixed(0)}%`, acc.ratio >= 0.9, acc.wrong.join("；"));
  check("A 样式语料：文档标题拿掉了", parsedA.docTitle === "网络地理信息系统实验报告", parsedA.docTitle);
  check("A 样式语料：表格没有散成正文", parsedA.tables === 1 && !parsedA.items.some((i) => i.kind === "para" && i.text.includes("Catalog 连接") && i.text === "图层"));
  check("A 样式语料：表格内容完整", parsedA.items.some((i) => i.kind === "table" && i.rows?.[0]?.[0] === "图层" && i.rows?.[0]?.[2] === "用途"));
  check(
    "A 样式语料：内嵌图片读成图片项（正文 1 张 + 单元格 1 张）",
    parsedA.images === 2 && parsedA.items.filter((i) => i.kind === "image").length === 2,
    `images=${parsedA.images}`,
  );
  const pics = parsedA.items.filter((i) => i.kind === "image");
  check(
    "A 样式语料：图片项带原始字节与尺寸",
    pics.every((i) => i.image?.dataUrl.startsWith("data:image/png;base64,") && i.image.w === 96 && i.image.h === 96),
    JSON.stringify(pics.map((i) => i.text)),
  );
  check(
    "A 样式语料：表格单元格里的图紧跟在表格后面，不混进正文",
    (() => {
      const t = parsedA.items.findIndex((i) => i.kind === "table");
      return parsedA.items[t + 1]?.kind === "image";
    })(),
  );
  check("A 样式语料：分页符不再报错", parsedA.warnings.some((w) => w.includes("分页符")));
  check("A 样式语料：封面行被认出来", parsedA.items.filter((i) => i.coverGuess).length === 2);
  const missing = await missingParagraphs(bytesA, parsedA);
  check("A 样式语料：一个字都没掉", missing.length === 0, missing.join(" / "));
}

/* ---------------- 语料 B：全篇手写编号，没有任何样式 ---------------- */

const corpusB = [
  para("1. 实验目的", { bold: true }),
  para("本次实验要掌握属性查询与空间查询两类方法。"),
  para("（1）加载图层", { bold: true }),
  para("（2）设置符号", { bold: true }),
  para("2. 实验步骤", { bold: true }),
  para("a) 打开软件"),
  para("一、实验总结"),
  para("3. 这一步会在地图上得到一组高亮要素。"),
  para(`4. ${"先把数据源切换到本地地理数据库，再检查要素类的坐标系是否与服务端一致，".repeat(2)}`),
];

const expectB: Expect = [
  ["实验目的", "section"],
  ["加载图层", "step"],
  ["设置符号", "step"],
  ["实验步骤", "section"],
  ["a) 打开软件", "body"],
  ["一、实验总结", "body"],
  ["3. 这一步会在地图上得到一组高亮要素。", "body"],
];

const bytesB = await makeDocx(corpusB.join(""));
const parsedB = await parseDocx(bytesB);

{
  const acc = levelAccuracy(parsedB, expectB);
  check(`B 手写编号语料：层级命中 ${(acc.ratio * 100).toFixed(0)}%`, acc.ratio >= 0.9, acc.wrong.join("；"));
  check("B 手写编号语料：没样式也给得出小节/步骤", parsedB.sections === 2 && parsedB.steps === 2);
  check(
    "B 手写编号语料：变成结构的标题剥掉编号",
    parsedB.items[0].prefix === "1." && parsedB.items[0].text === "实验目的",
    `${parsedB.items[0].prefix}|${parsedB.items[0].text}`,
  );
  check(
    "B 手写编号语料：没变成结构的编号折回正文",
    parsedB.items.some((i) => i.level === "body" && norm(`${i.prefix}${i.text}`) === norm("a) 打开软件")),
  );
  check(
    "B 手写编号语料：第 3 种编号模式不抬成结构",
    parsedB.items.every((i) => (i.text.includes("打开软件") ? i.level === "body" && i.prefix === "" : true)),
  );
  check("B 手写编号语料：句子样的编号行留在正文", parsedB.items.some((i) => i.level === "body" && i.text.startsWith("3. 这一步")));
  check("B 手写编号语料：超过 60 字的编号行不做标题", parsedB.items.some((i) => i.level === "body" && i.text.startsWith("4. 先把数据源") && i.text.length > 60));
  const missing = await missingParagraphs(bytesB, parsedB);
  check("B 手写编号语料：一个字都没掉", missing.length === 0, missing.join(" / "));
}

/* ---------------- 语料 C：Word 自动编号（文件里不存编号文字） ---------------- */

const corpusC = [
  para("实验目的", { num: { id: "1", ilvl: 0 } }),
  para("用一段话说明这次实验要做什么。"),
  para("加载图层", { num: { id: "1", ilvl: 1 } }),
  para("设置符号", { num: { id: "1", ilvl: 1 } }),
  para("实验步骤", { num: { id: "1", ilvl: 0 } }),
  para("细节一项", { num: { id: "1", ilvl: 2 } }),
];

const bytesC = await makeDocx(corpusC.join(""), { numbering: NUMBERING_XML });
const parsedC = await parseDocx(bytesC);

{
  const auto = parsedC.items.filter((i) => i.evidence.some((e) => e.includes("自动编号")));
  check("C 自动编号语料：编号一项没丢", auto.length === 5, `${auto.length}/5`);
  check(
    "C 自动编号语料：编号算回了文字且顺序正确",
    auto.filter((i) => i.prefix).map((i) => i.prefix).join(",") === "1.,a),b),2.",
    auto.map((i) => i.prefix || "(折回正文)").join(","),
  );
  check("C 自动编号语料：ilvl 0/1/2 分别是小节/步骤/正文", auto[0].level === "section" && auto[2].level === "step" && auto[4].level === "body");
  check("C 自动编号语料：深层编号折回正文文字", auto[4].level === "body" && norm(auto[4].text) === norm("① 细节一项"), auto[4].text);
  const accC = levelAccuracy(parsedC, [["实验目的", "section"], ["加载图层", "step"], ["实验步骤", "section"]]);
  check(`C 自动编号语料：层级命中 ${(accC.ratio * 100).toFixed(0)}%`, accC.ratio >= 0.9, accC.wrong.join("；"));
  const missing = await missingParagraphs(bytesC, parsedC);
  check("C 自动编号语料：一个字都没掉", missing.length === 0, missing.join(" / "));
}

/* ---------------- 语料 E：编号算出来正好是正文的开头（前缀剥多了会吃字） ---------------- */

const NUMBERING_EDGE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="6">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="7">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="7"><w:abstractNumId w:val="6"/></w:num>
  <w:num w:numId="8"><w:abstractNumId w:val="7"/></w:num>
</w:numbering>`;

const corpusE = [
  para("汇水面分析", { num: { id: "7", ilvl: 0 } }),
  para("河网提取", { num: { id: "7", ilvl: 0 } }),
  para("3000 米以上的区域才参与计算", { num: { id: "7", ilvl: 0 } }),
  para("1. 这一条把编号又手打了一遍", { num: { id: "8", ilvl: 0 } }),
];

const bytesE = await makeDocx(corpusE.join(""), { numbering: NUMBERING_EDGE_XML });
const parsedE = await parseDocx(bytesE);

{
  const digits = parsedE.items.find((i) => i.text.includes("区域才参与计算") || i.text.includes("000 米以上"));
  check("E 边界语料：编号是纯数字时不吃掉正文开头的数字", digits?.text === "3000 米以上的区域才参与计算", digits?.text);
  const typed = parsedE.items.find((i) => i.text.includes("手打"));
  check(
    "E 边界语料：真的重复了编号还是照剥",
    typed?.prefix === "1." && typed?.text === "这一条把编号又手打了一遍",
    `${typed?.prefix}|${typed?.text}`,
  );
  const missing = await missingParagraphs(bytesE, parsedE);
  check("E 边界语料：一个字都没掉", missing.length === 0, missing.join(" / "));
}

/* ---------------- 清单 → 工程 ---------------- */

{
  const report = await buildReportFromItems(parsedB, new Map(), "手写编号.docx");
  const stepBlocks = report.sections.flatMap((s) => s.steps.flatMap((st) => st.blocks));
  check("建工程：小节数与预览一致", report.sections.length === parsedB.sections, `${report.sections.length}`);
  check("建工程：标题里不带手写编号", report.sections[0].title === "实验目的", report.sections[0].title);
  check("建工程：正文合并进文字块而不是每段一块", stepBlocks.length <= 4, `${stepBlocks.length}`);
  const all = JSON.stringify(report);
  check("建工程：段落文字全在块里", norm(parsedB.items.filter((i) => i.level === "body").map((i) => i.text).join("")).length > 0 && norm(parsedB.items.filter((i) => i.level === "body").map((i) => i.text).join("")).split("").length <= all.length);
  const withPic = await buildReportFromItems(parsedA, new Map(), "样式.docx");
  const picBlocks = imageBlocks(withPic);
  check("建工程：表格成为表格块", withPic.sections.some((s) => s.steps.some((st) => st.blocks.some((b) => b.kind === "table"))));
  check("建工程：内嵌图片成为图片块", picBlocks.length === 2, `${picBlocks.length}`);
  const coverOff = await buildReportFromItems(parsedA, plainTextOverrides(parsedA), "样式.docx");
  check("建工程：预览关掉封面开关后封面行才进正文", coverOff.sections.length === 1);

  const prepared = await buildReportFromItems(parsedA, new Map(), "样式.docx", async (image) => ({
    dataUrl: image.dataUrl.replace("image/png", "image/webp"),
    w: Math.round(image.w / 2),
    h: Math.round(image.h / 2),
  }));
  const preparedPics = imageBlocks(prepared);
  check(
    "建工程：压缩钩子给出的字节与尺寸才入库",
    preparedPics.length === 2 &&
      preparedPics.every((b) => b.dataUrl.startsWith("data:image/webp") && b.w === 48 && b.h === 48),
    preparedPics.map((b) => `${b.dataUrl.slice(5, 15)} ${b.w}`).join(" / "),
  );

  const dropped = await buildReportFromItems(parsedA, new Map(), "样式.docx", async () => null);
  check(
    "建工程：压不动的图片丢掉，文字照旧导入",
    imageBlocks(dropped).length === 0 && dropped.sections.some((s) => s.steps.some((st) => st.blocks.some((b) => b.kind === "table"))),
  );

  // 浏览器那边传进来的钩子（App.tsx 用的就是它）：字节换掉，显示尺寸不许跟着换
  const undecodable: string[] = [];
  const viaPreparer = await buildReportFromItems(
    parsedA,
    new Map(),
    "样式.docx",
    makeImagePreparer(
      async (dataUrl) => ({ dataUrl: dataUrl.replace("image/png", "image/webp"), w: 1400, h: 1050 }),
      () => undecodable.push("坏图"),
    ),
  );
  const keptPics = imageBlocks(viaPreparer);
  check(
    "导入图片：压缩只换字节，Word 里排的显示尺寸保留",
    keptPics.length === 2 && keptPics.every((b) => b.dataUrl.startsWith("data:image/webp") && b.w === 96 && b.h === 96),
    keptPics.map((b) => `${b.w}×${b.h}`).join(" / "),
  );
  check("导入图片：能解的图不计数报错", undecodable.length === 0);
  const broken = await makeImagePreparer(
    async () => {
      throw new Error("图片解码失败");
    },
    () => undecodable.push("坏图"),
  )({ dataUrl: "data:application/x-emf;base64,AA", w: 96, h: 96, name: "image2.emf", bytes: 4096 });
  check("导入图片：浏览器解不了的图返回 null 并计入提醒", broken === null && undecodable.length === 1);
  const noDisplaySize = await makeImagePreparer(async () => ({ dataUrl: "data:image/webp;base64,AA", w: 1400, h: 1050 }), () => undefined)({
    dataUrl: "data:image/png;base64,AA",
    w: 0,
    h: 0,
    name: "image3.png",
    bytes: 8,
  });
  check("导入图片：Word 里量不到显示尺寸时退回压缩后的尺寸", noDisplaySize?.w === 1400 && noDisplaySize?.h === 1050);

  const long = await makeDocx(Array.from({ length: MAX_LINES_PER_BLOCK * 2 + 5 }, (_, i) => para(`第 ${i + 1} 行正文`)).join(""));
  const parsedLong = await parseDocx(long);
  const chunked = await buildReportFromItems(parsedLong, plainTextOverrides(parsedLong), "长文.docx");
  const textBlocks = chunked.sections.flatMap((s) => s.steps.flatMap((st) => st.blocks)).filter((b) => b.kind === "text");
  check(`建工程：${parsedLong.items.length} 段合并成 ${textBlocks.length} 个块（每块上限 ${MAX_LINES_PER_BLOCK} 行）`, textBlocks.length === 3);
  const lines = textBlocks.reduce((n, b) => n + (b.kind === "text" ? b.text.split("\n").length : 0), 0);
  check("建工程：合并后行数不缩水", lines === parsedLong.items.length, `${lines}`);
}

/* ---------------- 格子里再套一层表：那份文字不能凭空消失 ---------------- */

{
  const nested =
    "<w:tbl><w:tr><w:tc>" +
    "<w:p><w:r><w:t>操作符</w:t></w:r></w:p>" +
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>嵌套层：Contains 判定</w:t></w:r></w:p></w:tc>" +
    "<w:tc><w:p><w:r><w:t>嵌套层第二格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
    "<w:p><w:r><w:t>格子尾部</w:t></w:r></w:p>" +
    "</w:tc><w:tc><w:p><w:r><w:t>普通格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
  const parsed = await parseDocx(await makeDocx(nested));
  const cell = parsed.items.find((i) => i.kind === "table");
  const flat = JSON.stringify(cell?.rows ?? []);
  check("格中格：外层仍然当一个表块，不散成正文", !!cell && (cell.rows?.length ?? 0) === 1, `${cell?.rows?.length}`);
  check("格中格：嵌套表里的文字拉平进格子，不会整块蒸发", flat.includes("嵌套层：Contains 判定") && flat.includes("嵌套层第二格"));
  check("格中格：同格的直接段落与嵌套内容按文档顺序都在", flat.includes("操作符") && flat.includes("格子尾部"));
  check("格中格：普通格不受影响", flat.includes("普通格"));
}

/* ---------------- 真实导出件往返：导出 → 再导入 ---------------- */

function roundTripReport(): Report {
  const r = createReport({ order: "十一", topic: "属性查询与空间查询" });
  const [purpose, content, steps] = r.sections;
  purpose.steps[0].blocks = [{ id: "rp1", kind: "text", align: "left", text: "掌握 SQL 查询与空间查询。" }];
  content.steps[0].blocks = [{ id: "rp2", kind: "text", align: "left", text: "包含三部分。" }];
  steps.mode = "steps";
  steps.steps = [
    { id: "rp-s1", title: "使用SQL查询要素图层", blocks: [{ id: "rp3", kind: "text", align: "left", text: "（1）打开 ArcMap" }] },
    { id: "rp-s2", title: "使用空间关系查询", blocks: [{ id: "rp4", kind: "text", align: "left", text: "（2）选择要素" }] },
  ];
  return r;
}

{
  const { blob } = await buildReportBlob(roundTripReport());
  const bytes = await blob.arrayBuffer();
  const parsed = await parseDocx(bytes);
  const source = roundTripReport();
  const titles = source.sections.flatMap((s) => [s.title, ...s.steps.map((st) => st.title)]).filter((t) => t.trim());
  const lost = titles.filter((t) => !parsed.items.some((i) => norm(i.text).includes(norm(t))));
  check("往返：导出的每个标题都能被重新认出来", lost.length === 0, lost.join(" / "));
  check("往返：标题被认成结构而不是正文", parsed.sections >= 3, `小节 ${parsed.sections}`);
  const missing = await missingParagraphs(bytes, parsed);
  check("往返：导出→导入不丢字", missing.length === 0, missing.join(" / "));
}

/* ---------------- demo/ 里的真实报告 ---------------- */

const demoDir = path.resolve("demo");
const demoFiles = (await fs.readdir(demoDir)).filter((f) => f.endsWith(".docx"));
check("demo/ 里有真实导出件可测", demoFiles.length >= 3, demoFiles.join("、"));
for (const f of demoFiles) {
  const buf = await fs.readFile(path.join(demoDir, f));
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const parsed = await parseDocx(bytes);
  const missing = await missingParagraphs(bytes, parsed);
  check(`${f}：解析出 ${parsed.sections} 小节 / ${parsed.steps} 步骤，不丢字`, missing.length === 0 && parsed.items.length > 0, missing.slice(0, 2).join(" / "));
  const report = await buildReportFromItems(parsed, new Map(), f);
  check(`${f}：能建出可编辑工程`, report.sections.length > 0 && report.sections.every((s) => s.steps.length > 0));
  check(
    `${f}：内嵌图片按位置搬进工程（${parsed.images} 张）`,
    parsed.images === 0 || imageBlocks(report).length === parsed.images,
    `清单 ${parsed.images} / 块 ${imageBlocks(report).length}`,
  );
}

/* ---------------- 兜底与错误路径 ---------------- */

{
  let msg = "";
  try {
    await parseDocx(await makeDocx(""));
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  check("空文档不再抛「必须有封面」那类错", msg.includes("没有 body") || msg === "", msg);

  const bad = await new JSZip().generateAsync({ type: "arraybuffer" });
  let err = "";
  try {
    await parseDocx(bad);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check("改了扩展名的假 docx 会明确报错", err.includes("document.xml"), err);

  const noText = await makeDocx(para("", { drawing: "bare" }));
  const parsedEmpty = await parseDocx(noText);
  check("只有图片的文档：清单为空，交给上层提示", parsedEmpty.items.length === 0 && parsedEmpty.skippedImages === 1);
}

/* ---------------- 汇总 ---------------- */

let fails = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) fails += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && extra ? ` —— ${extra}` : ""}`);
}
console.log(`\n${checks.length - fails}/${checks.length} 通过`);
if (fails > 0) process.exitCode = 1;
