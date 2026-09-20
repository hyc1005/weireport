import { COVER_STYLES, autoTitle, metaLine } from "../cover";
import type { Cover, Report } from "../types";

/* ---------------- 纸面上的封面预览 ---------------- */

export function CoverPreview({ report }: { report: Report }) {
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

  if (report.cover.style === "reference") {
    return <div className="cv cv-reference" style={{ fontFamily: `"${o.bodyFont}", serif` }}>
      <div className="reference-title">{report.cover.title.trim() || `实验${report.meta.order}`}</div>
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
        <div style={titleStyle}>{title}</div>
        {report.cover.subtitle.trim() && <div className="cv-sub">{report.cover.subtitle.trim()}</div>}
        {report.cover.showMeta && metaLine(report) && <div className="cv-meta">{metaLine(report)}</div>}
      </div>
    );
  }

  return (
    <div className="cv cv-hero">
      <div className="cv-hero-space" />
      <div className="cv-center" style={heroTitleStyle}>
        {title}
      </div>
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
