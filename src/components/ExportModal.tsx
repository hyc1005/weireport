interface Props {
  fileName: string;
  busy: boolean;
  autoCaption: boolean;
  missingCaptions: number;
  onAutoCaption: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 导出 Word 前的确认：核对文件名 + 可选「给没图注的图补图 N」。勾选只影响这次导出，不动工程数据 */
export default function ExportModal({
  fileName,
  busy,
  autoCaption,
  missingCaptions,
  onAutoCaption,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>导出 Word</span>
          <button className="icon" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-group">
            <div className="modal-group-title">文件名</div>
            <div className="field" style={{ wordBreak: "break-all" }}>
              {fileName}
            </div>
            <span className="muted">想换个名字去「设置 → Word 默认文件名」改规则</span>
          </div>
          <div className="modal-group">
            <label className="check">
              <input
                type="checkbox"
                checked={autoCaption}
                onChange={(e) => onAutoCaption(e.target.checked)}
              />
              <span>
                给没图注的图片自动补「图 N」
                {missingCaptions > 0 ? `（本次涉及 ${missingCaptions} 张）` : ""}
              </span>
            </label>
            <span className="muted">按全文出现顺序连续编号；已手写图注的不覆盖，只在这次导出生效</span>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={onCancel} disabled={busy}>
              取消
            </button>
            <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
              {busy ? "生成中…" : "导出"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
