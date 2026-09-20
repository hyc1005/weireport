/**
 * Word（.docx）导入解析
 *
 *   只做一件事：把 document.xml 读成「一行一项 + 建议等级」的扁平清单，交给导入预览确认。
 *   等级判定分三层，按学生报告里的实际情况排优先级：
 *     1 样式名 / outlineLvl —— Word 里真设了标题样式，直接信；
 *     2 w:numPr + word/numbering.xml —— Word 自动编号在文件里是不存文字的，
 *       这里把编号算回文字，否则整份清单会掉字；
 *     3 中文手写编号 + 排版启发式 —— 「一、」「（1）」「1.」这类，
 *       命中的模式按首次出现顺序 rank-compress 成真实层级，
 *       所以只用「1、」一层编号的文档也能拿到合理结构。
 *
 *   铁律：不静悄悄地下沉、不丢字。置信度 < 0.75 的标题照样给出建议等级，
 *   只是标成低置信度，由预览里的人来定；没变成结构的编号一律折回正文文字里。
 *
 *   内嵌图片按原文位置读成清单里的「图片」项：media 里的原始字节先原样交给上层，
 *   由上层（浏览器）压成 WebP 再入库 —— 这里不碰 canvas，保持能在 node 里跑自检。
 */
import JSZip from "jszip";
import { encodeDataUrl } from "../base64";
import { alpha, circled } from "../numbering";
import { chineseNumber, romanize } from "../headings";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type ItemLevel = "section" | "step" | "body" | "ignore";

export const LEVEL_LABEL: Record<ItemLevel, string> = {
  section: "小节",
  step: "步骤",
  body: "正文",
  ignore: "忽略",
};

export interface ImportImage {
  /** 原始字节的 dataURL，由上层压缩后才入库 */
  dataUrl: string;
  /** 纸面显示尺寸（px，由 EMU 换算）；量不到时为 0 */
  w: number;
  h: number;
  /** media/image3.png 里的文件名，预览和排错用 */
  name: string;
  bytes: number;
}

export interface ImportItem {
  /** 文档顺序下标，也是覆盖表的稳定 key */
  index: number;
  kind: "para" | "table" | "image";
  /** para：剥掉编号后的正文；table：「n 行 × m 列 · 表头」摘要；image：文件名 + 尺寸 */
  text: string;
  rows?: string[][];
  image?: ImportImage;
  level: ItemLevel;
  /** 认定为标题时从原文剥下来的编号，预览里看得见它去了哪 */
  prefix: string;
  /** 判定依据，人话 */
  evidence: string[];
  confidence: number;
  coverGuess: boolean;
}

export interface ImportParse {
  items: ImportItem[];
  warnings: string[];
  /** 第一级标题被当作文档标题，不再占一个小节 */
  docTitle: string;
  sections: number;
  steps: number;
  tables: number;
  /** 读成「图片」项的内嵌图片张数 */
  images: number;
  /** Word 自动编号落成文字的处数 */
  numbered: number;
  /** 没能导入的图片张数（格式不支持、太小当装饰、引用断了） */
  skippedImages: number;
}

/* ---------------- XML 小工具 ---------------- */

function els(node: Element, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS(W, name));
}

function childEls(node: Element, name: string): Element[] {
  const out: Element[] = [];
  for (const n of Array.from(node.childNodes)) {
    const e = n as Element;
    if (n.nodeType === 1 && e.localName === name && e.namespaceURI === W) out.push(e);
  }
  return out;
}

function val(node: Element | null | undefined, attr = "val"): string {
  return node?.getAttributeNS(W, attr) ?? "";
}

function num(node: Element | null | undefined, attr = "val"): number | null {
  const raw = val(node, attr);
  return raw === "" || Number.isNaN(Number(raw)) ? null : Number(raw);
}

/** 段落文字：w:t 按文档顺序拼，制表符/换行保留，域代码与被删除文字不算 */
function collectText(node: Element): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += child.nodeValue ?? "";
      continue;
    }
    if (child.nodeType !== 1) continue;
    const e = child as Element;
    if (e.namespaceURI !== W) continue; // 数学式里的 m:t 不是正文
    switch (e.localName) {
      case "t":
        out += e.textContent ?? "";
        break;
      case "tab":
        out += "    ";
        break;
      case "br":
      case "cr":
        out += "\n";
        break;
      case "instrText":
      case "delText":
        break;
      default:
        out += collectText(e);
    }
  }
  return out.replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "").trim();
}

/* ---------------- 内嵌图片 ---------------- */

/** 浏览器 <img> 认得了的格式；EMF/WMF 这类矢量图元不认，只能跳过 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

/** 单张原始字节超过这个数就别搬了，压缩前会整个吃进内存 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** 没填尺寸或短边小于这个数（≈0.5cm）的多半是项目符号、水印和对勾 */
const MIN_IMAGE_EDGE = 48;
const MIN_IMAGE_BYTES = 900;

const EMU_PER_PX = 9525;

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}

/** rels 里的 Target 是相对 word/ 的，也可能写成包内绝对路径 */
function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const stack = ["word"];
  for (const seg of target.split("/")) {
    if (seg === "..") stack.pop();
    else if (seg && seg !== ".") stack.push(seg);
  }
  return stack.join("/");
}

/** word/_rels/document.xml.rels：rId → 包内路径；外部链接（TargetMode="External"）不算 */
function readRels(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml.trim()) return out;
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  for (const rel of Array.from(dom.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target || rel.getAttribute("TargetMode") === "External") continue;
    out.set(id, resolveTarget(target));
  }
  return out;
}

/** 纸面显示尺寸：wp:extent（图文框）优先，其次图元自己的 a:ext */
function extentPx(node: Element): { w: number; h: number } {
  const box = node.getElementsByTagNameNS(WP, "extent")[0] ?? node.getElementsByTagNameNS(A, "ext")[0];
  if (!box) return { w: 0, h: 0 };
  const cx = Number(box.getAttribute("cx"));
  const cy = Number(box.getAttribute("cy"));
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) return { w: 0, h: 0 };
  return { w: Math.round(cx / EMU_PER_PX), h: Math.round(cy / EMU_PER_PX) };
}

/**
 * 一段里的图片引用。
 * mc:AlternateContent 会把同一张图写两遍（Choice 的 drawing + Fallback 的 pict），按 rId 去重；
 * 一段里重复用同一张图也只算一次。
 */
function paragraphPics(p: Element): { pics: Array<{ id: string; w: number; h: number }>; dead: number } {
  const seen = new Set<string>();
  const pics: Array<{ id: string; w: number; h: number }> = [];
  let dead = 0;
  const nodes = [...els(p, "drawing"), ...els(p, "pict")];
  for (const node of nodes) {
    const size = extentPx(node);
    const ids: string[] = [];
    for (const blip of Array.from(node.getElementsByTagNameNS(A, "blip"))) {
      ids.push(blip.getAttributeNS(R, "embed") || blip.getAttributeNS(R, "link") || "");
    }
    for (const data of Array.from(node.getElementsByTagName("imagedata"))) {
      ids.push(data.getAttributeNS(R, "id") || data.getAttribute("r:id") || "");
    }
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      pics.push({ id, ...size });
    }
    // 引用得到 rId 就算这份图找到了（哪怕它只是 Fallback 里的重复写法）；一个都没有才是真丢
    if (!ids.some(Boolean)) dead += 1;
  }
  return { pics, dead };
}

function imageItem(index: number, image: ImportImage): ImportItem {
  const size = image.w && image.h ? ` ${image.w}×${image.h}px` : "";
  return {
    index,
    kind: "image",
    text: `${image.name}${size}`,
    image,
    level: "body",
    prefix: "",
    evidence: ["内嵌图片：按原文位置导入"],
    confidence: 1,
    coverGuess: false,
  };
}

/* ---------------- 第 2 层：Word 自动编号 ---------------- */

interface LvlDef {
  fmt: string;
  text: string;
  start: number;
}

function fmtNumber(kind: string, n: number): string {
  switch (kind) {
    case "decimalZero":
      return String(n).padStart(2, "0");
    case "lowerLetter":
      return alpha(n);
    case "upperLetter":
      return alpha(n).toUpperCase();
    case "lowerRoman":
      return romanize(n).toLowerCase();
    case "upperRoman":
      return romanize(n);
    case "chineseCounting":
    case "chineseCountingThousand":
    case "chineseLegalSimplified":
      return chineseNumber(n);
    case "decimalEnclosedCircle":
      return circled(n);
    case "decimalEnclosedParen":
      return `${n})`;
    case "bullet":
    case "none":
      return "";
    default:
      return String(n);
  }
}

/** numId → 编号定义，并按文档顺序计数（.docx 里不存编号文字，只能自己算回来） */
class NumberingTable {
  private levels = new Map<string, Map<number, LvlDef>>();
  private byId = new Map<string, string>();
  private counters = new Map<string, number[]>();

  constructor(xml: string) {
    if (!xml.trim()) return;
    const root = new DOMParser().parseFromString(xml, "application/xml").documentElement;
    if (!root) return;
    for (const abs of childEls(root, "abstractNum")) {
      const map = new Map<number, LvlDef>();
      for (const lvl of childEls(abs, "lvl")) {
        const ilvl = num(lvl, "ilvl") ?? map.size;
        map.set(ilvl, {
          fmt: val(els(lvl, "numFmt")[0]) || "decimal",
          text: val(els(lvl, "lvlText")[0]) || `%${ilvl + 1}.`,
          start: num(els(lvl, "start")[0]) ?? 1,
        });
      }
      this.levels.set(val(abs, "abstractNumId"), map);
    }
    for (const n of childEls(root, "num")) {
      const abs = childEls(n, "abstractNumId")[0];
      if (abs) this.byId.set(val(n, "numId"), val(abs));
    }
  }

  /** 取这一段自动编号该显示成什么文字；每调一次推进一格 */
  next(numId: string, ilvl: number): string {
    const def = this.levels.get(this.byId.get(numId) ?? "");
    const lvl = def?.get(ilvl);
    if (!def || !lvl) return "";
    const hist = this.counters.get(numId) ?? [];
    hist[ilvl] = (hist[ilvl] ?? lvl.start - 1) + 1;
    for (let deeper = ilvl + 1; deeper < hist.length; deeper += 1) {
      hist[deeper] = (def.get(deeper)?.start ?? 1) - 1; // 上级换了，下级从头再来
    }
    this.counters.set(numId, hist);
    return lvl.text.replace(/%(\d+)/g, (_, d: string) => {
      const at = Number(d) - 1;
      const sub = def.get(at);
      return fmtNumber((sub ?? lvl).fmt, hist[at] ?? sub?.start ?? 1);
    });
  }
}

/**
 * 剥掉「被手打重复」的自动编号前缀。
 * 只有前缀后面紧跟空白/分隔符、或者整行就是编号本身时才剥：
 * 编号算出来是 "3" 而正文写着 "3000 米" 时，无条件 slice 会把真实数字啃掉。
 */
function stripTypedPrefix(text: string, auto: string): string {
  if (!text.startsWith(auto)) return text;
  const rest = text.slice(auto.length);
  if (rest && !/^[\s.、．)）:：\-]/.test(rest)) return text;
  return rest.trim() || text;
}

/* ---------------- 第 3 层：中文手写编号 + 排版启发式 ---------------- */
const PREFIX_TIERS: Array<{ key: string; re: RegExp; label: string }> = [
  { key: "cn-dun", re: /^([一二三四五六七八九十百]{1,4}[、.．])(?!\s*$)/, label: "中文序号" },
  { key: "cn-paren", re: /^([（(][一二三四五六七八九十]{1,3}[）)])/, label: "中文括号" },
  { key: "ar-dot", re: /^(\d{1,2}[.、．])(?![\d%/.=])/, label: "数字序号" },
  { key: "ar-paren", re: /^([（(]\d{1,2}[）)])/, label: "数字括号" },
  { key: "alpha", re: /^([A-Z][.、)])(?![A-Za-z])/, label: "字母序号" },
  { key: "roman", re: /^([IVXLCDM]{2,5}[.、)])/, label: "罗马数字" },
  { key: "circled", re: /^([①-⑳㉑-㉟㊱-㊿])/, label: "带圈数字" },
];

interface PrefixHit {
  prefix: string;
  rest: string;
  key: string;
  label: string;
}

function splitPrefix(text: string): PrefixHit | null {
  for (const tier of PREFIX_TIERS) {
    const m = tier.re.exec(text);
    if (!m) continue;
    return {
      prefix: m[1],
      rest: text.slice(m[1].length).replace(/^[\s　]+/, ""),
      key: tier.key,
      label: tier.label,
    };
  }
  return null;
}

interface ParaLook {
  styleId: string;
  styleName: string;
  outline: number | null;
  bold: boolean;
  size: number | null;
  eastAsiaFont: string;
  firstLineChars: number;
  numId: string;
  ilvl: number;
  pageBreak: boolean;
}

function inspect(p: Element, styleNames: Map<string, string>): ParaLook {
  const styleId = val(els(p, "pStyle")[0]);
  const sizes = els(p, "sz").map((e) => num(e) ?? 0).filter((x) => x > 0);
  const b = els(p, "b")[0];
  return {
    styleId,
    styleName: styleNames.get(styleId) ?? "",
    outline: num(els(p, "outlineLvl")[0]),
    bold: !!b && !/^(0|none|false)$/i.test(val(b)),
    size: sizes.length ? Math.max(...sizes) : null,
    eastAsiaFont: val(els(p, "rFonts")[0], "eastAsia"),
    firstLineChars: num(els(p, "ind")[0], "firstLineChars") ?? 0,
    numId: val(els(p, "numId")[0]),
    ilvl: num(els(p, "ilvl")[0]) ?? 0,
    pageBreak: els(p, "br").some((e) => val(e, "type") === "page"),
  };
}

/** 第 1 层：样式名 / outlineLvl */
function fromStyle(look: ParaLook): { level: "section" | "step"; confidence: number; evidence: string } | null {
  const id = `${look.styleId} ${look.styleName}`.toLowerCase();
  const head = /heading\s*([1-9])|标题\s*([1-9])|^h([1-9])/.exec(id);
  const n = head ? Number(head[1] ?? head[2] ?? head[3]) : 0;
  if (n === 1 || n === 2) return { level: "section", confidence: 0.95, evidence: `样式「${look.styleName || look.styleId}」是标题 ${n}` };
  if (n >= 3) return { level: "step", confidence: 0.9, evidence: `样式「${look.styleName || look.styleId}」是标题 ${n}` };
  if (look.outline !== null) {
    return look.outline <= 1
      ? { level: "section", confidence: 0.85, evidence: `大纲级别 ${look.outline + 1}` }
      : { level: "step", confidence: 0.8, evidence: `大纲级别 ${look.outline + 1}` };
  }
  return null;
}

/** 读起来像句子而不像标题：长过一行，或者以句末标点收尾 */
function readsLikeSentence(text: string): boolean {
  return text.length > 60 || /[。；，]$/.test(text);
}

/** 第 3 层的把握度：短、粗、字号大、黑体加分；首行缩进、句末句号减分（长句根本不会走到这里） */
function confidenceOf(text: string, look: ParaLook, modeSize: number, prefix: string): number {
  let c = 0.55;
  if (text.length <= 24) c += 0.2;
  if (look.bold) c += 0.1;
  if ((look.size ?? 0) > modeSize) c += 0.1;
  if (/黑体|微软雅黑|SimHei|Heiti/i.test(look.eastAsiaFont)) c += 0.05;
  if (look.firstLineChars >= 150) c -= 0.25;
  if (/[。；]$/.test(text)) c -= 0.15;
  if (!/[.、]$/.test(prefix)) c -= 0.05;
  return Math.max(0.3, Math.min(0.95, Number(c.toFixed(2))));
}

/* ---------------- 主入口 ---------------- */

export async function parseDocx(input: File | Blob | ArrayBuffer): Promise<ImportParse> {
  const bytes =
    input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(await (input as Blob).arrayBuffer());
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string) => (await zip.file(path)?.async("string")) ?? "";

  const [documentXml, stylesXml, numberingXml, relsXml] = await Promise.all([
    read("word/document.xml"),
    read("word/styles.xml"),
    read("word/numbering.xml"),
    read("word/_rels/document.xml.rels"),
  ]);
  if (!documentXml.trim()) throw new Error("这个 .docx 里没有 word/document.xml，确认它是 Word 文档而不是改了扩展名的文件？");

  const dom = new DOMParser().parseFromString(documentXml, "application/xml");
  const body = dom.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("document.xml 里没有 body 节点");

  const styleNames = new Map<string, string>();
  if (stylesXml.trim()) {
    const sdom = new DOMParser().parseFromString(stylesXml, "application/xml");
    for (const style of Array.from(sdom.getElementsByTagNameNS(W, "style"))) {
      const id = style.getAttributeNS(W, "styleId") ?? "";
      if (id) styleNames.set(id, style.getElementsByTagNameNS(W, "name")[0]?.getAttributeNS(W, "val") ?? "");
    }
  }
  const numbering = new NumberingTable(numberingXml);
  const rels = readRels(relsXml);
  /** 没能导入的图片（格式不支持 / 引用断了 / 小到像装饰）与成功导入的张数 */
  let skippedImages = 0;
  let importedImages = 0;

  /** 同一张 media 被多处引用时只解一次码 */
  const mediaCache = new Map<string, ImportImage | null>();
  async function loadMedia(path: string, size: { w: number; h: number }): Promise<ImportImage | null> {
    const key = `${path}|${size.w}`;
    const cached = mediaCache.get(key);
    if (cached !== undefined) return cached;
    let out: ImportImage | null = null;
    const file = zip.file(path);
    const mime = IMAGE_MIME[extOf(path)];
    if (file && mime) {
      const raw = await file.async("uint8array");
      if (raw.byteLength >= MIN_IMAGE_BYTES && raw.byteLength <= MAX_IMAGE_BYTES) {
        out = { dataUrl: encodeDataUrl(mime, raw), w: size.w, h: size.h, name: path.split("/").pop() ?? path, bytes: raw.byteLength };
      }
    }
    mediaCache.set(key, out);
    return out;
  }

  /** 一组段落里的图片 → 待入清单的项（index 由调用方补）；不能导的只计数 */
  async function takePics(nodes: Element[]): Promise<ImportItem[]> {
    const out: ImportItem[] = [];
    let dead = 0;
    const collected: Array<{ id: string; w: number; h: number }> = [];
    for (const node of nodes) {
      const found = paragraphPics(node);
      collected.push(...found.pics);
      dead += found.dead;
    }
    for (const pic of collected) {
      const path = rels.get(pic.id);
      const image = path ? await loadMedia(path, pic) : null;
      if (!image || image.w < MIN_IMAGE_EDGE || image.h < MIN_IMAGE_EDGE) dead += 1;
      else out.push(imageItem(0, image));
    }
    skippedImages += dead;
    importedImages += out.length;
    return out;
  }

  /* 文档顺序遍历：只看 body 的直接子节点，表格里的段落不再漏进正文 */
  const blocks: Array<{ p: Element } | { tbl: Element }> = [];
  const walk = (node: Element) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const e = child as Element;
      if (e.namespaceURI !== W) continue;
      if (e.localName === "p") blocks.push({ p: e });
      else if (e.localName === "tbl") blocks.push({ tbl: e });
      else if (e.localName === "sdt" || e.localName === "sdtContent") walk(e); // 内容控件要拆开看
    }
  };
  walk(body);

  /* 正文字号取中位数，比它大的就是「字变大 → 像标题」的证据 */
  const looks = new Map<number, ParaLook>();
  const allLooks = blocks
    .map((b) => ("p" in b ? inspect(b.p, styleNames) : null))
    .filter((x): x is ParaLook => !!x);
  const sizes = allLooks.map((x) => x.size ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
  const modeSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 21;
  /** 全文有没有真标题样式：有的话，编号列表就是「标题下面的内容」，级别要往下压一层 */
  const hasStyledHeading = allLooks.some((x) => fromStyle(x) !== null);

  const items: ImportItem[] = [];
  /** 图片项由 takePics 造出来时还没有位置，入列时按数组下标补 */
  const push = (item: ImportItem) => {
    item.index = items.length;
    items.push(item);
  };
  let autoNumbered = 0;
  let hasPageBreak = false;
  let ctx: "top" | "section" | "step" = "top";

  for (const block of blocks) {
    if ("tbl" in block) {
      // 单元格取全部后代段落：只取直接子 w:p 的话，格子里再套一层表时那份文字会整个消失
      const rows = childEls(block.tbl, "tr")
        .map((tr) => childEls(tr, "tc").map((tc) => els(tc, "p").map(collectText).filter(Boolean).join(" ")))
        .filter((r) => r.some((c) => c !== ""));
      const cellPics = els(block.tbl, "p");
      if (!rows.length) {
        for (const img of await takePics(cellPics)) push(img);
        continue;
      }
      push({
        index: items.length,
        kind: "table",
        text: `${rows.length} 行 × ${Math.max(...rows.map((r) => r.length))} 列 · ${rows[0][0] || rows[0].join(" / ")}`,
        rows,
        level: "body",
        prefix: "",
        evidence: ["表格：整块导入，不散成正文"],
        confidence: 1,
        coverGuess: false,
      });
      // 表格单元格里挂的图：整表读完后紧跟表格入列，不散进正文
      for (const img of await takePics(cellPics)) push(img);
      continue;
    }

    const p = block.p;
    const pics = await takePics([p]);
    const look = inspect(p, styleNames);
    hasPageBreak ||= look.pageBreak;
    const text = collectText(p);
    if (!text) {
      for (const img of pics) push(img);
      continue;
    }

    const index = items.length;
    looks.set(index, look);
    const item: ImportItem = { index, kind: "para", text, level: "body", prefix: "", evidence: [], confidence: 1, coverGuess: false };
    items.push(item);
    // 图和这段文字同段：图排在这段文字后面（图注通常在下一段，顺序不受影响）
    for (const img of pics) push(img);

    const styled = fromStyle(look);
    if (styled) {
      item.level = styled.level;
      item.confidence = styled.confidence;
      item.evidence.push(styled.evidence);
      ctx = styled.level;
      continue;
    }

    if (look.numId) {
      const auto = numbering.next(look.numId, look.ilvl);
      if (auto) {
        autoNumbered += 1;
        item.prefix = auto;
        // 极少数人会把编号又手打一遍：文字里已经带上算出来的编号就不重复加
        item.text = stripTypedPrefix(text, auto);
        item.evidence.push(`Word 自动编号 → 文字「${auto}」`);
        /* 列表是挂在标题下面的内容：全文有真标题样式时，编号层级从「当前挂在哪」往下数，
           而不是 ilvl 0 一律当小节 —— 否则「实验步骤：A：」里的 1./2./3. 会全变成小节。 */
        const base = !hasStyledHeading || ctx === "top" ? 0 : ctx === "section" ? 1 : 2;
        const depth = look.ilvl + base;
        item.level = readsLikeSentence(item.text) ? "body" : depth === 0 ? "section" : depth === 1 ? "step" : "body";
        item.confidence = depth <= 1 ? 0.85 : 0.95;
        if (depth >= 2) item.evidence.push(`挂在${ctx === "section" ? "小节" : "步骤"}下的列表第 ${look.ilvl + 1} 层，留在正文`);
        continue;
      }
    }
  }

  return finishImport(items, looks, modeSize, { skippedImages, images: importedImages, autoNumbered, hasPageBreak });
}

/** 第 3 层要通读全文才能给模式排序，所以放在第二遍做 */
function finishImport(
  items: ImportItem[],
  looks: Map<number, ParaLook>,
  modeSize: number,
  ctx: { skippedImages: number; images: number; autoNumbered: number; hasPageBreak: boolean },
): ImportParse {
  const hits = new Map<number, PrefixHit>();
  for (const item of items) {
    if (item.kind !== "para" || item.level !== "body" || item.prefix) continue;
    const hit = splitPrefix(item.text);
    if (hit) hits.set(item.index, hit);
  }

  // 命中的模式按首次出现顺序压成真实层级：第 1 个模式 = 小节，第 2 个 = 步骤，再深只当正文
  const order: string[] = [];
  for (const hit of hits.values()) if (!order.includes(hit.key)) order.push(hit.key);

  for (const [index, hit] of hits) {
    const item = items[index];
    const rank = order.indexOf(hit.key);
    // 句子样的行不做标题：以句号/分号收尾或长过一屏，就当正文，编号原样留在文字里
    if (rank > 1 || readsLikeSentence(hit.rest)) continue;
    const look = looks.get(index);
    item.prefix = hit.prefix;
    item.text = hit.rest;
    item.level = rank === 0 ? "section" : "step";
    item.evidence.push(`手写编号「${hit.prefix}」（${hit.label}）→ 全文第 ${rank + 1} 层模式`);
    item.confidence = look ? confidenceOf(item.text, look, modeSize, hit.prefix) : 0.6;
  }

  // 没变成结构的编号折回正文文字，保证一个字都不掉
  for (const item of items) {
    if (item.kind !== "para" || !item.prefix) continue;
    if (item.level === "body") {
      item.text = `${item.prefix} ${item.text}`.trim();
      item.prefix = "";
    }
  }

  /* 疑似封面：前 15 段里成对出现的学号 / 姓名 / 日期一类信息行 */
  const COVER_RE = /^(学\s*号|姓\s*名|指导教师|班\s*级|专\s*业|日\s*期|完成日期|课程名称|实验名称|题\s*目)/;
  const head = items.filter((i) => i.kind === "para").slice(0, 15);
  const coverHits = head.filter((i) => COVER_RE.test(i.text) && i.text.length <= 30);
  if (coverHits.length >= 2) {
    for (const hit of coverHits) {
      hit.coverGuess = true;
      hit.level = "ignore";
      hit.prefix = "";
      hit.evidence.push("疑似封面信息行");
      hit.confidence = Math.max(hit.confidence, 0.8);
    }
  }

  /* 开头那个大标题当作文档标题，不占一个小节 */
  let docTitle = "";
  const sections = items.filter((i) => i.level === "section");
  const first = sections[0];
  if (first && first.index <= 2 && sections.length > 1) {
    const look = looks.get(first.index);
    const styledTitle = !!look && /heading\s*1|标题\s*1/i.test(`${look.styleId} ${look.styleName}`);
    const bigText = !!look && (look.size ?? 0) > modeSize + 8;
    if (styledTitle || bigText) {
      docTitle = `${first.prefix}${first.text}`.trim();
      first.level = "ignore";
      first.prefix = "";
      first.evidence.push("作为文档标题，不再当小节");
      first.confidence = 0.9;
    }
  }

  const warnings: string[] = [];
  if (ctx.skippedImages > 0) {
    warnings.push(`${ctx.skippedImages} 张内嵌图片没能导入（EMF/WMF 等格式、引用断了，或小得像装饰），位置会空着`);
  }
  if (ctx.hasPageBreak) warnings.push("检测到分页符，已忽略；疑似封面的段落可在预览里整体选择导入或跳过");
  if (ctx.autoNumbered > 0) warnings.push(`${ctx.autoNumbered} 处 Word 自动编号已算成文字写回`);
  const low = items.filter((i) => i.level !== "body" && i.level !== "ignore" && i.confidence < 0.75).length;
  if (low > 0) warnings.push(`${low} 行标题的判定把握不足 75%，预览里已标出，等你确认`);

  return {
    items,
    warnings,
    docTitle,
    sections: items.filter((i) => i.level === "section").length,
    steps: items.filter((i) => i.level === "step").length,
    tables: items.filter((i) => i.kind === "table").length,
    images: ctx.images,
    numbered: ctx.autoNumbered,
    skippedImages: ctx.skippedImages,
  };
}

/** 预览里某一行最终采用的等级（人工覆盖优先） */
export function levelOfItem(overrides: Map<number, ItemLevel>, item: ImportItem): ItemLevel {
  return overrides.get(item.index) ?? item.level;
}

/** 预览里「跳过疑似封面段落」这个开关批量作用在封面行上 */
export function coverOverrides(parsed: ImportParse, skip: boolean): Map<number, ItemLevel> {
  const map = new Map<number, ItemLevel>();
  for (const item of parsed.items) if (item.coverGuess) map.set(item.index, skip ? "ignore" : "body");
  return map;
}
