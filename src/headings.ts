/**
 * 标题编号的唯一来源
 *   小节标题（一、二、三）与步骤标题（1. / A.）都由 computeHeadings 一次算完；
 *   目录、纸面、打印、Markdown、Word 导出五个渲染点只读它的结果，不再各算一套。
 *
 *   与 numbering.ts 的分工：numbering.ts 管「段内」的 （1）/a)/①/1) 四级小序号，
 *   对象是文字行；本文件管「标题」，对象是步骤与小节，两者字形集与重计规则都不同。
 */
import { alpha } from "./numbering";
import { stepHasContent, type CoverStyle, type HeadGlyph, type HeadRestart, type Report, type Section, type Step } from "./types";

export type { HeadGlyph, HeadRestart };

export interface HeadLabel {
  /** 编号本体，如 "3." / "C." / "三、"；不显示时为空串 */
  no: string;
  /** 直接拼在标题前的片段（含尾随空格）；不显示时为空串 */
  text: string;
  /** 占用的序号，从 1 开始；该标题不计数时为 0 */
  n: number;
  /** true = 标题里已经手写了编号，系统不再叠加（但仍占号，所以不会跳号） */
  suppressed: boolean;
}

export interface Headings {
  /** key 为 `${sectionId}:${stepId}` */
  step(key: string): HeadLabel | null;
  section(id: string): HeadLabel | null;
}

export const HEAD_GLYPHS: HeadGlyph[] = ["none", "arabic", "paren", "alpha", "chinese", "roman"];

export const HEAD_GLYPH_LABEL: Record<HeadGlyph, string> = {
  none: "无",
  arabic: "1.",
  paren: "（1）",
  alpha: "A.",
  chinese: "一、",
  roman: "I.",
};

/** 封面风格只在这里影响一次默认值，不参与编号计算 */
export function defaultStepGlyph(coverStyle: CoverStyle): HeadGlyph {
  return coverStyle === "reference" ? "alpha" : "arabic";
}

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 阿拉伯数字 → 中文数字（1..99，导入 Word 时把 chineseCounting 落成文字要用） */
export function chineseNumber(n: number): string {
  if (n <= 0) return CN_DIGITS[0];
  if (n < 10) return CN_DIGITS[n];
  if (n === 10) return "十";
  if (n < 20) return `十${CN_DIGITS[n % 10]}`;
  if (n < 100) return `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ""}`;
  return String(n);
}

const ROMAN: Array<[number, string]> = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

/** 阿拉伯数字 → 罗马数字（导入 Word 的 upperRoman/lowerRoman 要落成文字） */
export function romanize(n: number): string {
  if (n <= 0 || n > 3999) return String(n);
  let rest = n;
  let out = "";
  for (const [value, sign] of ROMAN) {
    while (rest >= value) {
      out += sign;
      rest -= value;
    }
  }
  return out;
}

/** 第 n 个标题编号的字形本体；glyph 为 none 时返回空串 */
export function formatHead(glyph: HeadGlyph, n: number): string {
  switch (glyph) {
    case "arabic":
      return `${n}.`;
    case "paren":
      return `（${n}）`;
    case "alpha":
      return `${alpha(n).toUpperCase()}.`;
    case "chinese":
      return `${chineseNumber(n)}、`;
    case "roman":
      return `${romanize(n)}.`;
    default:
      return "";
  }
}

const CIRCLED = "\u2460-\u2473\u3251-\u325f\u32b1-\u32bf";

/** 标题是否已经自带手写编号（一、/（一）/1./（1）/①/A./I.） */
export function startsWithManualNumber(title: string): boolean {
  const t = title.replace(/^[\s　]+/, "");
  return (
    /^\d{1,2}[.、)](?!\d)/.test(t) ||
    /^[（(]\d{1,2}[）)]/.test(t) ||
    /^[一二三四五六七八九十]{1,3}[、.．]/.test(t) ||
    /^[（(][一二三四五六七八九十]{1,3}[）)]/.test(t) ||
    /^[A-Z][.、)](?![a-zA-Z])/.test(t) ||
    /^[IVXLCDM]{2,5}[.、)]/.test(t) ||
    new RegExp(`^[${CIRCLED}]`).test(t)
  );
}

/** 这个步骤是否占一个编号：空标题且没内容的占位步骤一律不占号，编号空洞从根上消失 */
export function countForNumbering(section: Section, step: Step): boolean {
  return section.mode === "steps" && (step.title.trim() !== "" || stepHasContent(step));
}

function makeLabel(glyph: HeadGlyph, n: number, suppressed: boolean): HeadLabel {
  const no = glyph === "none" || suppressed ? "" : formatHead(glyph, n);
  return { no, text: no ? `${no} ` : "", n, suppressed };
}

/** 走一遍 sections → steps，算出所有标题编号。五个渲染点共用这份结果。 */
export function computeHeadings(report: Report): Headings {
  const { stepGlyph, stepRestart, sectionGlyph } = report.options;
  const glyph: HeadGlyph = stepGlyph ?? "arabic";
  const restart: HeadRestart = stepRestart ?? "document";
  const secGlyph: HeadGlyph = sectionGlyph ?? "none";

  const stepMap = new Map<string, HeadLabel>();
  const sectionMap = new Map<string, HeadLabel>();
  let n = 0;

  for (const section of report.sections) {
    if (secGlyph !== "none" && section.title.trim()) {
      const suppressed = startsWithManualNumber(section.title);
      sectionMap.set(section.id, makeLabel(secGlyph, sectionMap.size + 1, suppressed));
    }
    if (restart === "section") n = 0;
    if (section.mode !== "steps") continue;
    for (const step of section.steps) {
      if (!countForNumbering(section, step)) continue;
      n += 1;
      const suppressed = startsWithManualNumber(step.title);
      stepMap.set(`${section.id}:${step.id}`, makeLabel(glyph, n, suppressed));
    }
  }

  return {
    step: (key) => stepMap.get(key) ?? null,
    section: (id) => sectionMap.get(id) ?? null,
  };
}
