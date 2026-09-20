/**
 * 分级序号工具
 *   一级 （1）   二级 a)   三级 ①   四级 1)
 * 规则：
 *   · 只有用过上一级，才会出现下一级的序号（最多 4 级）
 *   · 同一级里，已用到第 N 个就多给出第 N+1 个（上限 49）
 *   · 序号是纯文本，插到行首，不带任何后续文字
 */

export type Level = 1 | 2 | 3 | 4;

export const LEVELS: Level[] = [1, 2, 3, 4];
export const MAX_SEQ = 49;
export const LEVEL_NAME: Record<Level, string> = {
  1: "一级",
  2: "二级",
  3: "三级",
  4: "四级",
};

/* ---------------- 字形 ---------------- */

export function circled(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}

/** 第 n 个字母序号（n 从 1 开始）：a b … z aa ab … */
export function alpha(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || "a";
}

function alphaToNum(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n;
}

/** 某级第 n 个序号的文字形式 */
export function formatSeq(level: Level, n: number): string {
  switch (level) {
    case 1:
      return `（${n}）`;
    case 2:
      return `${alpha(n)})`;
    case 3:
      return circled(n);
    default:
      return `${n})`;
  }
}

/** 下级序号前面加的全角缩进 */
export function indentFor(level: Level): string {
  return "　".repeat(level - 1);
}

/* ---------------- 解析 ---------------- */

const CIRCLED_INDEX = new Map<string, number>();
for (let i = 1; i <= 50; i += 1) CIRCLED_INDEX.set(circled(i), i);

/** 解析一行行首的序号；没有则返回 null */
export function parsePrefix(line: string): { level: Level; n: number } | null {
  const t = line.replace(/^[\u3000\s]+/, "");
  let m: RegExpExecArray | null;

  if ((m = /^[（(](\d{1,2})[）)]/.exec(t))) return { level: 1, n: Number(m[1]) };
  if ((m = /^([a-z]{1,2})\)/.exec(t))) return { level: 2, n: alphaToNum(m[1]) };
  const first = t.slice(0, 2);
  const single = CIRCLED_INDEX.get(first.slice(0, 1));
  if (single !== undefined) return { level: 3, n: single };
  if ((m = /^(\d{1,2})\)/.exec(t))) return { level: 4, n: Number(m[1]) };
  return null;
}

/* ---------------- 状态分析 ---------------- */

export interface LevelState {
  level: Level;
  /** 上一级用过没有；false 表示这一级还出不来 */
  available: boolean;
  /** 当前父级下已用过的序号 */
  used: number[];
  /** 建议的下一个序号 */
  next: number;
  /** 这一级当前该显示的候选序号 1..next */
  chips: number[];
}

const CIRCLED_RE = /^[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]/;

const ITEM_PATTERNS: Array<{ level: Level; re: RegExp }> = [
  { level: 1, re: /^[（(]\d{1,2}[）)]/ },
  { level: 2, re: /^[a-z]{1,2}\)/ },
  { level: 3, re: CIRCLED_RE },
  { level: 4, re: /^\d{1,2}\)/ },
];

/** 序号标记后面允许跟什么：空格、字母数字、中文、常见标点，或干脆到行尾 */
const AFTER_MARKER = /^[\s\w\u4e00-\u9fff（(《】"'，。、：；！？-]/;

/**
 * 这一行是不是「一条列表项」。比 parsePrefix 严：标记后面必须跟正文，
 * 四级 `n)` 后面还不能是数字 / % / /。跨块聚合时一行误判会让后面所有块都解锁二三级，
 * 所以计数只认这里；`20)26年`、代码里的 `a){` 都不算，`（1）ArcMap`、`（12）内容` 仍然算。
 */
export function isListItemLine(line: string): boolean {
  const t = line.replace(/^[\u3000\s]+/, "");
  for (const { level, re } of ITEM_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const rest = t.slice(m[0].length);
    if (level === 4 && /^[\d%/.=]/.test(rest)) return false;
    return rest === "" || AFTER_MARKER.test(rest);
  }
  return false;
}

function caretLineIndex(text: string, caret: number): number {
  const upto = Math.max(0, Math.min(caret, text.length));
  return text.slice(0, upto).split("\n").length - 1;
}

/** 逐行扫到 caretLine 为止，算四级状态（父级键随上级序号重置） */
function scanLines(lines: string[], caretLine: number): LevelState[] {
  const used: Record<Level, Map<string, number[]>> = {
    1: new Map(),
    2: new Map(),
    3: new Map(),
    4: new Map(),
  };
  // key[l-1] = 第 l 级当前的父级键
  const key: string[] = ["", "", "", ""];

  for (let i = 0; i <= caretLine && i < lines.length; i += 1) {
    const p = isListItemLine(lines[i]) ? parsePrefix(lines[i]) : null;
    if (!p) continue;
    if (p.level === 1) {
      key[0] = String(p.n);
      key[1] = "";
      key[2] = "";
      key[3] = "";
    } else if (p.level === 2) {
      key[1] = `${key[0]}/${p.n}`;
      key[2] = "";
      key[3] = "";
    } else if (p.level === 3) {
      key[2] = `${key[1]}/${p.n}`;
      key[3] = "";
    } else {
      key[3] = `${key[2]}/${p.n}`;
    }
    const parent = p.level === 1 ? "" : key[p.level - 2];
    const list = used[p.level].get(parent) ?? [];
    if (!list.includes(p.n)) list.push(p.n);
    used[p.level].set(parent, list);
  }

  return LEVELS.map((level) => {
    const parent = level === 1 ? "" : key[level - 2];
    const available = level === 1 || parent !== "";
    const list = used[level].get(parent) ?? [];
    const max = list.length > 0 ? Math.max(...list) : 0;
    const next = Math.min(MAX_SEQ, max + 1);
    return {
      level,
      available,
      used: list,
      next,
      chips: Array.from({ length: next }, (_, i) => i + 1),
    };
  });
}

/**
 * 依据「光标所在位置之前的内容」算出四级序号各自的可用状态。
 * 二级/三级/四级的计数按当前父级重新开始（换了父级就从 a) 重来）。
 */
export function analyzeSequence(text: string, caret: number): LevelState[] {
  return scanLines(text.split("\n"), caretLineIndex(text, caret));
}

/** 一个文字块：块 id + 它的原始文字 */
export interface SeqLine {
  blockId: string;
  text: string;
}

/**
 * 跨块版：把同一步骤里所有文字块按文档顺序接成一条行流，扫到焦点块的光标行为止。
 *   analyzeSequence(t, c) === analyzeSequenceAcross([{ blockId: "b", text: t }], "b", c)
 * 于是第二个块的序号接着第一个块数（（3）→（4）），而不是每块都从（1）重来。
 */
export function analyzeSequenceAcross(sources: SeqLine[], focusBlockId: string, caret: number): LevelState[] {
  const flat: string[] = [];
  for (const src of sources) {
    const own = src.text.split("\n");
    if (src.blockId !== focusBlockId) {
      flat.push(...own);
      continue;
    }
    const offset = flat.length;
    flat.push(...own);
    return scanLines(flat, Math.min(offset + caretLineIndex(src.text, caret), flat.length - 1));
  }
  return scanLines(flat, flat.length - 1);
}

/* ---------------- 插入 ---------------- */

export interface InsertResult {
  text: string;
  caret: number;
}

/**
 * 把序号插进文字：
 *   · 该行还没有序号 → 插到行首（保留原有内容与光标相对位置）
 *   · 该行已有序号   → 在光标处另起一行再插
 */
export function insertSequence(text: string, caret: number, level: Level, n: number): InsertResult {
  const prefix = indentFor(level) + formatSeq(level, n);
  const pos = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nl = text.indexOf("\n", pos);
  const lineEnd = nl === -1 ? text.length : nl;
  const lineText = text.slice(lineStart, lineEnd);

  if (parsePrefix(lineText) === null) {
    return {
      text: text.slice(0, lineStart) + prefix + text.slice(lineStart),
      caret: pos + prefix.length,
    };
  }
  return {
    text: text.slice(0, lineEnd) + "\n" + prefix + text.slice(lineEnd),
    caret: lineEnd + 1 + prefix.length,
  };
}
