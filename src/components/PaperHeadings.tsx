import type { HeadLabel } from "../headings";
import type { ReportOptions } from "../types";

function headingStyle(o: ReportOptions, size: number) {
  return { fontFamily: o.headFont, fontSize: `${size / 2}pt` };
}

/** 小节标题（plain 小节在纸面上的那一行）。编号只读 HeadLabel，不再自己算。 */
export function SectionHeading({
  label,
  title,
  options,
}: {
  label: HeadLabel | null;
  title: string;
  options: ReportOptions;
}) {
  return (
    <h2 className="paper-h2" data-no={label?.no ?? ""} style={headingStyle(options, options.subHeadSize)}>
      {label?.text ?? ""}
      {title}
    </h2>
  );
}

/** 步骤标题：编号 + 可编辑标题 + 「沿用原编号」徽标 */
export function StepHeading({
  label,
  title,
  options,
  onTitle,
}: {
  label: HeadLabel | null;
  title: string;
  options: ReportOptions;
  onTitle: (title: string) => void;
}) {
  return (
    <h3 className="paper-h3" data-no={label?.no ?? ""} style={headingStyle(options, options.stepHeadSize)}>
      <span className="h3-no">{label?.no ?? ""}</span>
      <input
        className="h3-input"
        value={title}
        placeholder="这一步做什么？例：添加图形图层"
        onChange={(e) => onTitle(e.target.value)}
      />
      {label?.suppressed && (
        <span className="h3-own-no muted" title="这条标题自己写了编号，系统编号已让位；导出时序号仍占位">
          沿用原编号
        </span>
      )}
    </h3>
  );
}
