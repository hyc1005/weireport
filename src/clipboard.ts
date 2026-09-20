/** 剪贴板：快捷粘贴按钮的后端实现（文本 + 图片） */

interface ClipboardItemLike {
  types: string[];
  getType(type: string): Promise<Blob>;
}

interface ClipboardReadLike {
  read(): Promise<ClipboardItemLike[]>;
  readText(): Promise<string>;
}

function api(): ClipboardReadLike | null {
  const c = navigator.clipboard as unknown as Partial<ClipboardReadLike> | undefined;
  if (c && typeof c.read === "function" && typeof c.readText === "function") {
    return c as ClipboardReadLike;
  }
  return null;
}

export function isClipboardReadSupported(): boolean {
  return api() !== null;
}

/** 读剪贴板里的第一张图片（截图工具复制出来的图、网页右键复制的图都行） */
export async function readClipboardImage(): Promise<Blob | null> {
  const c = api();
  if (!c) throw new Error("当前浏览器不支持读取剪贴板图片，请改用「截取当前窗口」或 Ctrl+V");
  const items = await c.read();
  for (const item of items) {
    for (const type of item.types) {
      if (type.startsWith("image/")) return await item.getType(type);
    }
  }
  return null;
}

export async function readClipboardText(): Promise<string> {
  const c = api();
  if (!c) throw new Error("当前浏览器不支持读取剪贴板，请改用 Ctrl+V");
  return await c.readText();
}

/** 从 paste 事件里抠出图片（最稳的一条路，不需要任何权限弹窗） */
export function imageFromClipboardEvent(e: ClipboardEvent): Blob | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

export function textFromClipboardEvent(e: ClipboardEvent): string | null {
  const t = e.clipboardData?.getData("text/plain");
  return t && t.length > 0 ? t : null;
}
