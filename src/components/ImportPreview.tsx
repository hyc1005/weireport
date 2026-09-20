/**
 * Word 导入预览：确认之前不落库。
 *   一行一项：原文摘要 | 级别下拉 | 判定依据 | 置信度色条。
 *   把握不足 75% 的行会被标出来 —— 结构猜错了在这里看得见，而不是导入后才发现丢了小节。
 *   图片行只能选「正文 / 忽略」，确认后由 App 压一遍 WebP 再入库。
 */
import { useMemo, useState } from "react";
import { plainTextOverrides } from "../templateImport";
import {
  LEVEL_LABEL,
  coverOverrides,
  levelOfItem,
  type ImportParse,
  type ItemLevel,
} from "../docx/parse";

const LEVELS: ItemLevel[] = ["section", "step", "body", "ignore"];
/** 图片不是文字，谈不上级别 */
const IMAGE_LEVELS: ItemLevel[] = ["body", "ignore"];
const LOW = 0.75;

interface Props {
  fileName: string;
  parsed: ImportParse;
  /** 正在压图：按钮全禁用，别让人连点 */
  busy?: boolean;
  onClose: () => void;
  onConfirm: (overrides: Map<number, ItemLevel>) => void;
}

function summarize(parsed: ImportParse, overrides: Map<number, ItemLevel>) {
  let sections = 0;
  let steps = 0;
  let bodies = 0;
  let ignored = 0;
  let tables = 0;
  let images = 0;
  let prefixed = 0;
  let low = 0;
  for (const item of parsed.items) {
    const level = levelOfItem(overrides, item);
    if (level === "ignore") ignored += 1;
    else if (item.kind === "table") tables += 1;
    else if (item.kind === "image") images += 1;
    else if (level === "section") sections += 1;
    else if (level === "step") steps += 1;
    else bodies += 1;
    if (item.prefix) prefixed += 1;
    if ((level === "section" || level === "step") && item.confidence < LOW) low += 1;
  }
  const pending = bodies ? Math.ceil(bodies / 30) : 0;
  return { sections, steps, bodies, ignored, tables, images, prefixed, low, pending };
}

export function ImportPreview({ fileName, parsed, busy = false, onClose, onConfirm }: Props) {
  const coverCount = parsed.items.filter((i) => i.coverGuess).length;
  const [skipCover, setSkipCover] = useState(coverCount > 0);
  const [edited, setEdited] = useState<Map<number, ItemLevel>>(new Map());

  const overrides = useMemo(() => {
    const map = coverCount ? coverOverrides(parsed, skipCover) : new Map<number, ItemLevel>();
    for (const [k, v] of edited) map.set(k, v);
    return map;
  }, [parsed, skipCover, edited, coverCount]);

  const stat = summarize(parsed, overrides);

  function change(index: number, level: ItemLevel) {
    setEdited((prev) => {
      const next = new Map(prev);
      next.set(index, level);
      return next;
    });
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>导入预览 · {fileName}</span>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="import-summary">
          <span>
            将生成 <b>{stat.sections}</b> 个小节 / <b>{stat.steps}</b> 个步骤 / <b>{stat.tables}</b> 个表格
            {stat.images > 0 && <> / <b>{stat.images}</b> 张图片</>}，
            正文 <b>{stat.bodies}</b> 段（合并成约 {stat.pending} 个文字块）
          </span>
          <span>
            编号 <b>{parsed.numbered}</b> 处自动编号已转文字，<b>{stat.prefixed}</b> 处手写编号已移入结构
            {parsed.skippedImages > 0 && <>，另有 <b>{parsed.skippedImages}</b> 张图片没能读出（格式不支持或太小）</>}
          </span>
          {stat.low > 0 && <span className="import-low">{stat.low} 行判定把握不足，已用黄底标出</span>}
          {coverCount > 0 && (
            <label className="import-check">
              <input type="checkbox" checked={skipCover} onChange={(e) => setSkipCover(e.target.checked)} />
              跳过 {coverCount} 行疑似封面信息（学号 / 姓名 / 日期）
            </label>
          )}
        </div>

        {parsed.warnings.length > 0 && (
          <ul className="import-warns">
            {parsed.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <div className="modal-body import-list">
          <div className="import-row import-row-head">
            <span>原文</span>
            <span>作为</span>
            <span>依据</span>
            <span>把握</span>
          </div>
          {parsed.items.map((item) => {
            const level = levelOfItem(overrides, item);
            const low = (level === "section" || level === "step") && item.confidence < LOW;
            const levels = item.kind === "image" ? IMAGE_LEVELS : LEVELS;
            return (
              <div key={item.index} className={`import-row${low ? " low" : ""}${level === "ignore" ? " off" : ""}`}>
                <span className="import-text" title={item.text}>
                  {item.kind === "table" && <em className="import-kind">表格</em>}
                  {item.kind === "image" && <em className="import-kind">图片</em>}
                  {item.image && (
                    <img className="import-thumb" src={item.image.dataUrl} alt="" width={34} height={24} loading="lazy" />
                  )}
                  {item.prefix && <em className="import-prefix">{item.prefix}</em>}
                  {item.text.slice(0, 90) || <i className="muted">（空）</i>}
                </span>
                <span>
                  <select value={level} onChange={(e) => change(item.index, e.target.value as ItemLevel)}>
                    {levels.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABEL[l]}
                      </option>
                    ))}
                  </select>
                </span>
                <span className="import-evi muted">{item.evidence.join(" · ") || "正文段落"}</span>
                <span className={`import-conf${low ? " low" : ""}`}>
                  <i style={{ width: `${Math.round(item.confidence * 100)}%` }} />
                  <b>{Math.round(item.confidence * 100)}%</b>
                </span>
              </div>
            );
          })}
        </div>

        <div className="btn-row import-foot">
          <button className="btn btn-sm" disabled={busy} onClick={onClose}>
            取消
          </button>
          <span className="spacer" />
          {busy && <span className="muted">正在把图片压成 WebP…</span>}
          <button className="btn btn-sm" disabled={busy} onClick={() => onConfirm(plainTextOverrides(parsed))}>
            按纯文本导入
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onConfirm(overrides)}>
            {busy ? "导入中…" : "确认导入"}
          </button>
        </div>
      </div>
    </div>
  );
}
