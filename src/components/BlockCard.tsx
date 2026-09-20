import { useEffect, useRef, useState, type CSSProperties } from "react";
import { estimateDataUrlBytes, formatBytes } from "../capture";
import {
  LEVELS,
  LEVEL_NAME,
  MAX_SEQ,
  analyzeSequenceAcross,
  formatSeq,
  insertSequence,
  parsePrefix,
  type Level,
  type SeqLine,
} from "../numbering";
import type { Align, Block, BlockKind, ReportOptions } from "../types";

export interface BlockApi {
  patch: (blockId: string, patch: Partial<Block>) => void;
  remove: (blockId: string) => void;
  move: (blockId: string, delta: -1 | 1) => void;
  captureInto: (blockId: string | null) => void;
  clipboardImageInto: (blockId: string | null) => void;
  clipboardTextInto: (blockId: string | null) => void;
  uploadInto: (file: File, blockId: string | null) => void;
}

interface Props {
  block: Block;
  index: number;
  options: ReportOptions;
  api: BlockApi;
  busy: string | null;
  /** 图片在全文中是第几张，用于图 N 编号 */
  figureNo?: number;
  /** 同一步骤里的全部文字块（文档顺序），让序号跨块接着数 */
  numbering?: SeqLine[];
  selected?: boolean;
  onSelect?: (blockId: string) => void;
}

const KIND_LABEL: Record<BlockKind, string> = {
  text: "文字",
  code: "代码",
  image: "图片",
  table: "表格",
};

const ALIGNS: Array<{ value: Align; label: string }> = [
  { value: "left", label: "左" },
  { value: "center", label: "中" },
  { value: "right", label: "右" },
  { value: "justify", label: "两端" },
];

function AutoTextarea({
  value,
  onChange,
  onCaret,
  placeholder,
  style,
  mono,
  minRows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  onCaret?: (pos: number) => void;
  placeholder?: string;
  style?: CSSProperties;
  mono?: boolean;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, minRows * 22)}px`;
  }, [value, minRows]);

  const report = () => onCaret?.(ref.current?.selectionStart ?? 0);

  return (
    <textarea
      ref={ref}
      className={`ta${mono ? " mono" : ""}`}
      style={style}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        onChange(e.target.value);
        onCaret?.(e.target.selectionStart ?? 0);
      }}
      onSelect={report}
      onClick={report}
      onKeyUp={report}
      onFocus={report}
    />
  );
}

/** 分级序号工具：纯序号，一级用了才出二级，同级用到第 N 个就给出第 N+1 个；同一步骤内的多个文字块接着数 */
function NumberingTool({
  sources,
  blockId,
  caret,
  onInsert,
}: {
  sources: SeqLine[];
  blockId: string;
  caret: number;
  onInsert: (level: Level, n: number) => void;
}) {
  const states = analyzeSequenceAcross(sources, blockId, caret);
  const visible = states.filter((s) => s.available);
  const allLevels = visible.length === LEVELS.length;
  const atMax = visible.some((s) => s.chips.length >= MAX_SEQ);

  return (
    <div className="numbering">
      {visible.map((s) => (
        <div className="numbering-row" key={s.level}>
          <span className="numbering-label">{LEVEL_NAME[s.level]}</span>
          <span className="numbering-chips">
            {s.chips.map((n) => (
              <button
                key={n}
                className={`num-chip${n === s.next ? " next" : ""}${s.used.includes(n) ? " used" : ""}`}
                title={`插入 ${formatSeq(s.level, n)}`}
                onClick={() => onInsert(s.level, n)}
              >
                {formatSeq(s.level, n)}
              </button>
            ))}
          </span>
        </div>
      ))}
      <div className="numbering-tip muted">
        {allLevels
          ? "四级都出现了，点一下序号就插到行首"
          : `点一下序号插到行首；用了${visible[visible.length - 1] ? LEVEL_NAME[visible[visible.length - 1].level] : "一级"}，下一级才会出现`}
        {atMax && "；同级最多 49 个"}
      </div>
    </div>
  );
}

/** 文字块：纸面按段落渲染（所见即所得）+ 分级序号工具 */
function TextBlockEditor({
  block,
  o,
  api,
  numbering,
}: {
  block: Extract<Block, { kind: "text" }>;
  o: ReportOptions;
  api: BlockApi;
  /** 同一步骤内的全部文字块；不传就只看自己这一块 */
  numbering?: SeqLine[];
}) {
  const text = block.text;
  const [editing, setEditing] = useState(false);
  const [caret, setCaret] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const align = block.align === "justify" ? "justify" : block.align;
  const indentOn = (block.indent ?? o.firstLineIndent) && block.align !== "center" && block.align !== "right";
  const baseStyle: CSSProperties = {
    fontFamily: o.bodyFont,
    fontSize: `${o.bodySize / 2}pt`,
    lineHeight: o.lineSpacing,
    textAlign: align,
  };

  // 进入编辑态后把光标放到该放的位置
  useEffect(() => {
    if (!editing || pendingCaret.current === null) return;
    const ta = rootRef.current?.querySelector("textarea");
    if (!ta) return;
    const pos = Math.min(pendingCaret.current, ta.value.length);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    setCaret(pos);
    pendingCaret.current = null;
  }, [editing, text]);

  // 点到块外才退出编辑态（避免点序号按钮时闪一下）
  useEffect(() => {
    if (!editing) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setEditing(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const open = () => apply({ text, caret: text.length });
    el.addEventListener("block-edit", open);
    return () => el.removeEventListener("block-edit", open);
  }, [text]);

  function apply(result: { text: string; caret: number }) {
    pendingCaret.current = result.caret;
    api.patch(block.id, { text: result.text });
    setEditing(true);
  }

  function lineOffset(index: number): number {
    const lines = text.split("\n");
    let acc = 0;
    for (let i = 0; i < index && i < lines.length; i += 1) acc += lines[i].length + 1;
    return acc + (lines[index]?.length ?? 0);
  }

  const lines = text.split("\n");

  return (
    <div className="tb" ref={rootRef}>
      {editing ? (
        <AutoTextarea
          value={text}
          style={{ ...baseStyle, textIndent: indentOn ? "2em" : undefined }}
          placeholder="写说明文字。序号用下面的工具点一下就行"
          onCaret={setCaret}
          onChange={(v) => api.patch(block.id, { text: v })}
        />
      ) : (
        <div className="tb-view" onClick={(e) => e.stopPropagation()}>
          {lines.length === 0 || text.trim() === "" ? (
            <span className="tb-placeholder">点击这里写文字，或直接 Ctrl+V 粘贴</span>
          ) : (
            lines.map((line, i) => {
              const prefixed = parsePrefix(line) !== null;
              return (
                <div
                  key={i}
                  className="tb-line"
                  style={{ ...baseStyle, textIndent: indentOn && !prefixed ? "2em" : undefined }}
                  onClick={(e) => {
                    e.stopPropagation();
                    apply({ text, caret: lineOffset(i) });
                  }}
                >
                  {line === "" ? "\u00a0" : line}
                </div>
              );
            })
          )}
        </div>
      )}

      <NumberingTool
        sources={numbering ?? [{ blockId: block.id, text }]}
        blockId={block.id}
        caret={caret}
        onInsert={(level, n) => apply(insertSequence(text, caret, level, n))}
      />

      <div className="chips">
        <button className="chip paste" onClick={() => api.clipboardTextInto(block.id)}>
          粘贴到这里
        </button>
      </div>
    </div>
  );
}

export function BlockCard({ block, index, options: o, api, busy, figureNo, numbering, selected, onSelect }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className={`block${selected ? " selected" : ""}`} ref={cardRef} data-block={block.id} onClick={() => onSelect?.(block.id)} onDoubleClick={() => { onSelect?.(block.id); cardRef.current?.querySelector<HTMLElement>(".tb")?.dispatchEvent(new CustomEvent("block-edit")); cardRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); }}>
      <div className="block-side">
        <span className="block-no">{index + 1}</span>
        <span className={`block-tag tag-${block.kind}`}>{KIND_LABEL[block.kind]}</span>
        <span className="block-side-tools">
          <button className="icon" title="上移" onClick={() => api.move(block.id, -1)}>
            ↑
          </button>
          <button className="icon" title="下移" onClick={() => api.move(block.id, 1)}>
            ↓
          </button>
          <button className="icon danger" title="删除" onClick={() => api.remove(block.id)}>
            ✕
          </button>
        </span>
      </div>

      <div className="block-body">
        {block.kind === "text" && <TextBlockEditor block={block} o={o} api={api} numbering={numbering} />}

        {block.kind === "code" && (
          <>
            <div className="code-head">
              <select value={block.lang} onChange={(e) => api.patch(block.id, { lang: e.target.value })}>
                {["js", "html", "css", "json", "bash", "纯文本"].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <span className="muted">{block.code.split("\n").length} 行</span>
              <span className="spacer" />
              <button className="chip paste" onClick={() => api.clipboardTextInto(block.id)}>
                粘贴代码到光标处
              </button>
            </div>
            <AutoTextarea
              mono
              minRows={4}
              value={block.code}
              placeholder="直接 Ctrl+V 粘贴代码，缩进会原样保留"
              onChange={(v) => api.patch(block.id, { code: v })}
            />
          </>
        )}

        {block.kind === "image" && (
          <>
            {block.dataUrl ? (
              <div className="shot" style={{ textAlign: block.align === "justify" ? "center" : block.align }}>
                <img
                  src={block.dataUrl}
                  alt={block.caption || "截图"}
                  style={block.widthPct > 0 ? { width: `${block.widthPct}%` } : undefined}
                />
              </div>
            ) : (
              <div className="shot-empty">还没有图片</div>
            )}

            <div className="chips">
              <button className="chip primary" disabled={!!busy} onClick={() => api.captureInto(block.id)}>
                {busy === "capture" ? "截取中…" : "截取当前窗口"}
              </button>
              <button className="chip" disabled={!!busy} onClick={() => api.clipboardImageInto(block.id)}>
                贴剪贴板图片
              </button>
              <button className="chip" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                ⬆ 上传
              </button>
              {block.dataUrl && (
                <>
                  <span className="muted">{formatBytes(estimateDataUrlBytes(block.dataUrl))}</span>
                  <button className="chip" onClick={() => api.patch(block.id, { dataUrl: "" })}>
                    清空图片
                  </button>
                </>
              )}
            </div>

            {block.captionPos === "below" && (
              <input
                className="line-input"
                value={block.caption}
                placeholder={`图注，留空则自动为「图 ${figureNo ?? 1}」`}
                onChange={(e) => api.patch(block.id, { caption: e.target.value })}
              />
            )}
          </>
        )}

        {block.kind === "table" && (
          <div className="table-edit">
            <table>
              <tbody>
                {/* 格子是受控输入，按位置复用就是对的内容；行没有 id 可比 */}
                {block.rows.map((row, ri) => {
                  const cols = Math.max(1, ...block.rows.map((x) => x.length));
                  return (
                    <tr key={ri}>
                      {Array.from({ length: cols }, (_, ci) => (
                        <td key={ci} className={ri === 0 && block.headerRow ? "head" : ""}>
                          <input
                            value={row[ci] ?? ""}
                            placeholder={ri === 0 ? `表头${ci + 1}` : ""}
                            onChange={(e) => {
                              const next = block.rows.map((x, xi) =>
                                xi === ri
                                  ? Array.from({ length: cols }, (_, c) => (c === ci ? e.target.value : x[c] ?? ""))
                                  : Array.from({ length: cols }, (_, c) => x[c] ?? ""),
                              );
                              api.patch(block.id, { rows: next });
                            }}
                          />
                        </td>
                      ))}
                      <td className="row-tool">
                        <button
                          className="icon danger"
                          title="删除该行"
                          onClick={() => api.patch(block.id, { rows: block.rows.filter((_, xi) => xi !== ri) })}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="chips">
              <button
                className="chip"
                onClick={() =>
                  api.patch(block.id, {
                    rows: [...block.rows, Array.from({ length: Math.max(1, ...block.rows.map((r) => r.length)) }, () => "")],
                  })
                }
              >
                ＋行
              </button>
              <button className="chip" onClick={() => api.patch(block.id, { rows: block.rows.map((r) => [...r, ""]) })}>
                ＋列
              </button>
              <button
                className="chip"
                onClick={() => api.patch(block.id, { rows: block.rows.map((r) => r.slice(0, -1)) })}
                disabled={Math.max(...block.rows.map((r) => r.length)) <= 1}
              >
                －列
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="block-attrs">
        {block.kind === "text" && (
          <>
            <Segmented
              value={block.align}
              onChange={(v) => api.patch(block.id, { align: v })}
            />
            <label className="mini-check">
              <input
                type="checkbox"
                checked={block.indent ?? o.firstLineIndent}
                onChange={(e) => api.patch(block.id, { indent: e.target.checked })}
              />
              首行缩进
            </label>
          </>
        )}

        {block.kind === "code" && (
          <>
            <label className="mini-check">
              <input
                type="checkbox"
                checked={block.showLang}
                onChange={(e) => api.patch(block.id, { showLang: e.target.checked })}
              />
              显示语言标签
            </label>
            <label className="mini-check">
              <input
                type="checkbox"
                checked={block.boxed}
                onChange={(e) => api.patch(block.id, { boxed: e.target.checked })}
              />
              底纹边框
            </label>
          </>
        )}

        {block.kind === "image" && (
          <>
            <Segmented value={block.align} onChange={(v) => api.patch(block.id, { align: v })} />
            <label className="mini-field">
              宽度
              <select
                value={block.widthPct}
                onChange={(e) => api.patch(block.id, { widthPct: Number(e.target.value) })}
              >
                <option value={0}>原始</option>
                <option value={100}>100%</option>
                <option value={80}>80%</option>
                <option value={60}>60%</option>
                <option value={40}>40%</option>
              </select>
            </label>
            <label className="mini-check">
              <input
                type="checkbox"
                checked={block.captionPos === "below"}
                onChange={(e) => api.patch(block.id, { captionPos: e.target.checked ? "below" : "none" })}
              />
              显示图注
            </label>
          </>
        )}

        {block.kind === "table" && (
          <label className="mini-check">
            <input
              type="checkbox"
              checked={block.headerRow}
              onChange={(e) => api.patch(block.id, { headerRow: e.target.checked })}
            />
            首行作为表头
          </label>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) api.uploadInto(f, block.id);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Segmented({ value, onChange }: { value: Align; onChange: (v: Align) => void }) {
  return (
    <span className="segmented">
      {ALIGNS.map((a) => (
        <button
          key={a.value}
          className={value === a.value ? "on" : ""}
          onClick={() => onChange(a.value)}
          title={`${a.label}对齐`}
        >
          {a.label}
        </button>
      ))}
    </span>
  );
}
