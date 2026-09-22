import { useRef, useState } from "react";
import { COVER_STYLES, autoTitle, metaLine } from "../cover";
import type { Cover, Report } from "../types";

/* ---------------- 纸面即输入框：在原来的位置直接改 ---------------- */

/**
 * 大标题的就地编辑：纸面上那一行本身就是输入框，不弹任何面板。
 * 平时看起来和排版结果完全一样（无边框、透明底），点上去才出现虚线框；
 * 输入框宽度跟着文字走（`size` + `.ip-title` 的 ch 兜底），不会因为编辑态就换行。
 */
function InplaceTitle({
  value,
  display,
  placeholder,
  className,
  style,
  onCommit,
}: {
  /** 真正存下来的标题；空串表示「用自动标题」 */
  value: string;
  /** 没在编辑时显示的文字（自动标题在这里生效） */
  display: string;
  placeholder: string;
  className: string;
  style: React.CSSProperties;
  onCommit: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const boxRef = useRef<HTMLInputElement | null>(null);
  /** onBlur 之后紧接着的 onKeyDown(Enter) 不该再提交一次 */
  const blurring = useRef(false);
  /** Esc 放弃这次编辑：onBlur 要知道「别提交」 */
  const abandoning = useRef(false);
  const width = { "--ip-w": `${Math.max(4, (display || placeholder).length)}ch` } as React.CSSProperties;

  /** 进入/退出编辑态，并把焦点安置好（点一下就进编辑，不用再点第二下） */
  const flip = (on: boolean) => {
    setEditing(on);
    requestAnimationFrame(() => {
      const el = boxRef.current;
      if (!el) return;
      if (on) {
        el.focus();
        el.select();
      } else {
        el.blur();
      }
    });
  };

  const finish = () => {
    if (blurring.current) return;
    blurring.current = true;
    queueMicrotask(() => {
      blurring.current = false;
    });
    const next = draft;
    const cancelled = abandoning.current;
    abandoning.current = false;
    setEditing(false);
    if (!cancelled && next !== value) onCommit(next);
  };

  if (editing) {
    return (
      <input
        className={`ip ip-title ip-nowrap ${className}`}
        style={{ ...style, ...width }}
        data-inplace="title"
        value={draft}
        size={Math.max(4, draft.length)}
        placeholder={placeholder}
        ref={boxRef}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            flip(false); // 失焦交给 onBlur 提交，只走一条路径
          }
          if (e.key === "Escape") {
            e.preventDefault();
            abandoning.current = true;
            flip(false);
          }
        }}
      />
    );
  }

  return (
    <div
      className={`ip ip-title ip-nowrap ${className}`}
      style={{ ...style, ...width }}
      data-inplace="title"
      title="点一下直接改"
      onClick={() => {
        setDraft(value);
        flip(true);
      }}
    >
      {display || <span className="ip-placeholder">{placeholder}</span>}
    </div>
  );
}

/* ---------------- 纸面上的封面预览 ---------------- */

export function CoverPreview({
  report,
  onTitle,
}: {
  report: Report;
  /** 给了就能在纸面上直接改大标题（不给则纯预览） */
  onTitle?: (title: string) => void;
}) {
  const o = report.options;
  const title = autoTitle(report);
  const titleStyle = {
    fontFamily: `"${o.headFont}", "SimHei", sans-serif`,
    fontSize: `${o.titleSize / 2}pt`,
    fontWeight: 700,
  };
  const heroTitleStyle = {
    ...titleStyle,
    fontSize: `${Math.max(o.titleSize, 44) / 2}pt`,
  };
  const titleNode = (display: string, className: string, style: React.CSSProperties) =>
    onTitle ? (
      <InplaceTitle
        value={report.cover.title}
        display={display}
        placeholder={autoTitle({ ...report, cover: { ...report.cover, title: "" } })}
        className={className}
        style={style}
        onCommit={onTitle}
      />
    ) : (
      <div className={className} style={style}>
        {display}
      </div>
    );

  if (report.cover.style === "reference") {
    return <div className="cv cv-reference" style={{ fontFamily: `"${o.bodyFont}", serif` }}>
      {titleNode(report.cover.title.trim() || `实验${report.meta.order}`, "reference-title", {})}
      {report.meta.topic && <div className="reference-topic">{report.meta.topic}</div>}
      <div className="reference-details">
        {report.cover.subtitle.trim() && <div>课程：{report.cover.subtitle.trim()}</div>}
        {report.cover.showMeta && <>
          <div>学号：{report.meta.studentId || "________________"}</div>
          <div>姓名：{report.meta.name || "________________"}</div>
          {report.meta.date && <div className="reference-date">{report.meta.date}</div>}
        </>}
      </div>
    </div>;
  }

  if (report.cover.style === "plain") {
    return (
      <div className="cv cv-plain">
        {titleNode(title, "", titleStyle)}
        {report.cover.subtitle.trim() && <div className="cv-sub">{report.cover.subtitle.trim()}</div>}
        {report.cover.showMeta && metaLine(report) && <div className="cv-meta">{metaLine(report)}</div>}
      </div>
    );
  }

  return (
    <div className="cv cv-hero">
      <div className="cv-hero-space" />
      {titleNode(title, "cv-center", heroTitleStyle)}
      {report.cover.subtitle.trim() && (
        <div className="cv-center cv-hero-sub">{report.cover.subtitle.trim()}</div>
      )}
      <div className="cv-hero-space2" />
      {report.cover.showMeta && (
        <div className="cv-hero-meta">
          {report.meta.studentId && <div>学号：{report.meta.studentId}</div>}
          {report.meta.name && <div>姓名：{report.meta.name}</div>}
          {report.cover.subtitle.trim() && <div>课程：{report.cover.subtitle.trim()}</div>}
          {report.meta.date && <div className="cv-hero-date">{report.meta.date}</div>}
        </div>
      )}
      <div className="cv-pagebreak">— 分页 —</div>
    </div>
  );
}

/* ---------------- 封面设置面板 ---------------- */

interface PanelProps {
  report: Report;
  onCover: (patch: Partial<Cover>) => void;
}

export function CoverPanel({ report, onCover }: PanelProps) {
  return (
    <div className="panel">
      <div className="panel-title">封面</div>

      <div className="cover-styles">
        {COVER_STYLES.map((s) => (
          <button
            key={s.value}
            className={`cover-style${report.cover.style === s.value ? " on" : ""}`}
            onClick={() => onCover({ style: s.value })}
          >
            <span className="cover-style-name">{s.label}</span>
            <span className="cover-style-desc">{s.desc}</span>
          </button>
        ))}
      </div>

      <div className="field-row">
        <label className="field">
          标题
          <input
            value={report.cover.title}
            placeholder={autoTitle(report)}
            onChange={(e) => onCover({ title: e.target.value })}
          />
        </label>
        <label className="field">
          副标题 / 课程名
          <input
            value={report.cover.subtitle}
            placeholder="WebGIS 开发"
            onChange={(e) => onCover({ subtitle: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={report.cover.showMeta}
            onChange={(e) => onCover({ showMeta: e.target.checked })}
          />
          显示学号姓名
        </label>
      </div>
    </div>
  );
}
