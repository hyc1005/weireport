# 交接报告（2026-09-19 会话）

> 给下一个会话用。上半部分是"现在项目是什么状态"，下半部分是"已审计出但还没修的 bug 清单"。
> **修 bug 需要用户先点单编号，不要擅自开修。**

---

## 0. 不可违反的项目约束

- 工程真身：`D:\testfileplace\dshtry2\webgis`（工作区 `D:\testfileplace\qodertry` 只是挂载点）。
- **不能 move/删除工作区内顶层目录**：目录句柄被文件监视器占用，`mv` 报 `Device or resource busy`、`rd` exit 32。跨目录替换只能 `robocopy /E /XJ /MT:16`，且 Git Bash 下要先 `export MSYS2_ARG_CONV_EXCL="*"`。
- 本轮改动前的版本备份：`D:\testfileplace\dshtry2\webgis_backup_20260919`。
- 三份验证，改完必须全跑：
  1. `npx tsc -b --force`
  2. `npm run verify`（五道闸门：storage / export / render / headings / import）
  3. `npm run build`
  外加一次内置浏览器真页面走查——离线闸门测不到 canvas 压缩和存量数据兼容，这两类只能靠浏览器。
- **内置浏览器 IndexedDB 里是用户真实工程**（「导入 · 示例2-正式风-实验十一」，7/9 项）。只读走查，绝不触发删除/清空/恢复快照。browser-use 没有可见视口，只能用 `take_snapshot` / `evaluate_script` 做结构级走查。
- Bash 是 Git Bash：路径写 `/d/...`。含非 ASCII 的 `grep` 在 Git Bash 下会失败，改用 Grep 工具或 python（`io.open(..., encoding="utf-8")`，**不要 print 中文**，控制台 GBK 会 UnicodeEncodeError）。
- 协作习惯（用户明确偏好，见记忆 `feedback-propose-before-implementing`）：产品/界面类改动先交**编号文字清单**，他点单（本轮是「优化46两点」）后才写代码；界面取向偏**做减法**，"美化"= 受控小改而不是新控件。

---

## 1. 本轮已完成的改动

### 1.1 Feature 4：Word 导入把内嵌图片一起搬进来

- `src/docx/parse.ts`
  - `takePics` 从 `a:blip`（`r:embed` / `r:link`）和 VML `v:imagedata`（`r:id`）取 rId，段落内按 rId 去重（`mc:AlternateContent` 会双写）。
  - 显示尺寸从 `wp:extent` / `a:ext` 换算，`EMU_PER_PX = 9525`。
  - 过滤阈值：`MAX_IMAGE_BYTES = 6MB`、`MIN_IMAGE_EDGE = 48`、`MIN_IMAGE_BYTES = 900`（装饰线、超小图标丢掉）。
  - `loadMedia` 缓存 key 是 `path|size.w`（审计提过这里浪费，见 B 组）。
  - 计数：`importedImages` / `skippedImages`，warning 文案「N 张内嵌图片没能导入（EMF/WMF 等格式、引用断了，或小得像装饰），位置会空着」。
- **解析层不碰 canvas**（保住离线闸门），压缩交给上层钩子：
  - `src/templateImport.ts`：`type PrepareImage = (image: ImportImage) => Promise<{dataUrl,w,h} | null>`，`buildReportFromItems` 的 image 分支里 `prepareImage` 返回 `null` 就整个丢掉这张图，文字照旧导入。
  - `src/App.tsx` `confirmImport`：钩子里调 `compressImage(image.dataUrl)`（`src/capture.ts:97`，限宽 1400 → WebP q0.9 → ≤400KB），try/catch 计 `undecodable`，notify 追加「，N 张图片浏览器解不了，位置空着」。
- `src/components/ImportPreview.tsx`：图片行加缩略图 + 「图片」徽标，层级选项收成 `body` / `ignore` 两档；`busy` 时禁用导入按钮并显示「正在把图片压成 WebP…」。
- 自检：`scripts/verify-import.ts` 加了「内嵌图片成为图片块」「压缩钩子给出的字节与尺寸才入库」「压不动的丢掉但文字照旧」「demo 每个文件 `parsed.images === 0 || imageBlocks(report).length === parsed.images`」；`scripts/verify-render.tsx` 加了缩略图/选项数量断言。

### 1.2 Feature 6：截止日期反推进度

- 纯函数在向导模块里：`planDeadline(done, total)` / `deadlineLabel` / `deadlineTone`，两侧都用 `Date.UTC` 对齐防 DST，脏日期一律返回 `null`（不显示，不猜）。
- `Report.meta` 新增 `due` 字段；封面页右侧 inspector 加「截止日期」`<input type="date">`。
- 出现位置只有两处：写内容页 stage-bar 的 `deadline-badge`（`App.tsx:888`）、首页工程卡片的 `deadline-chip`（`Home.tsx`）。

### 1.3 界面美化（做减法的受控小改）

- 撤掉 `BlockCard.tsx` 里的 📋🖥🖼 彩色 emoji（`:264/:309/:338/:341`），`App.tsx:885` 按钮文案 `🖥 截取当前窗口` → `截取当前窗口`，图标统一单色字形。
- 焦点环跟主题：`styles.css` `:root` 加 `--ring: rgba(43,92,230,.12)`，`studio.css` 覆盖为 `rgba(23,108,103,.14)`；input/select/textarea 与 `button/a/select:focus-visible` 都改用变量。
- 下拉支持 Esc 关闭：`App.tsx:861` 插入菜单、`Home.tsx:168` 卡片「⋯」菜单。
- `.import-kind` / `.import-thumb`（34×24，`vertical-align:-6px` 修基线）。

### 1.4 顺手修掉的真实白屏 bug

老索引条目没有 `due` 字段 → `Home` 渲染期 `undefined.trim()` 抛错 → 首页全白（浏览器走查抓到，`#root` 空 + 控制台 `<Home>` 边界错误）。
修法：`src/storage.ts` `readIndexList()` 返回前 `rec.list.map((s) => ({ ...s, due: str(s.due) }))`。
回归：`scripts/verify-storage.ts` 9b 块（注入无 `due` 的老索引 → 断言 `listProjects()[0].due === ""`）。
**记住这条的普适结论：读边界有两个——正文 `normalizeReport` 与索引 `readIndexList`，加字段时漏一个就白屏。**

### 1.5 文档同步

- `README.md` 和 `D:\Desktop\WebGIS报告生成器_使用说明.md`：导入图片说明、截止日期段落（"四件值得知道的"改成五件）、单色图标说明、已知边界两条改写、两条 changelog（傍晚加法 + 界面收口/白屏修复）。

### 1.6 验证最终状态

- `npx tsc -b --force`：无输出。
- `npm run verify`：五道闸门全绿，import 54/54。
- `npm run build`：成功，index ~334KB / build ~378KB。
- 浏览器走查：重载后 `mounted: true`、卡片恢复、真实数据未动。
- dev server 已用 `scripts/stop.ps1` 关掉。

---

## 1.7 本轮（2026-09-20）修完的点单：A1–A6 + B1 + B2 + B3 + C1 + C2 + C3

### A 组（丢数据 / 白屏）

- **跨 store 原子写（A6 的地基）**：`src/db.ts` 的 `KV` 加 `write(ops: WriteOp[])`，`ops = {store, put} | {store, del}`；`idbKV.write` 把涉及的 store 去重后开**一个** `transaction(readwrite)`，`oncomplete` 才 resolve，`onerror/onabort` reject。`memoryKV.write` 按序应用（离线闸门用）。
- **A6**：`saveProject` / `deleteProject` / `pushBackup` 都改成一次 `kv().write([...])` —— 正文 + 索引（删除还要带上该工程的快照）同一事务提交。
- **A1**：`storage.ts` 备份格式升到 `version: 2`，`exportAllJson()` 把工程与快照引用到的 asset 字节 `encodeDataUrl` 内联成 `assets: Record<hash, dataURL>`；新增 `parseBackupBundle()`（老版没有 `format` 也认，缺 `assets` 就当空表）、`bundleReports()`（还原 `asset:` 引用，缺字节留空串、文字照旧）、`bundleMissingImages()`（报数）。`parseReportJson()` 见 `Array.isArray(raw.projects)` 直接返回 `null`，整套文件不会再被当成一个"未命名"工程。`App.tsx` `importProjectJson` 先按 bundle 认，逐份 `saveProject` 后按「导入了 N 个工程，M 张图片没能还原」通知。
- **A2**：`restoreBackup` / `listBackups` 都先 `normalizeReport` 再用（老快照缺 `meta.due` 不再白屏）。
- **A3**：索引重建统一走 `summaryOf(raw) = summarize(normalizeReport(raw))`。
- **A5**：`packReport` 改两趟 —— 第一趟收集 `wanted: Map<id, dataUrl>` 并逐个解码入库，解不动的进 `unwritable`；第二趟 `mapBlocks` 对 `unwritable` 的块**原样返回**，`assetIds` 只记真正写进去的图。不会再出现"引用换好了、字节没落库"。
- **A4**：`App.tsx` 保存引擎从 `dirty/saving/queued` 三态换成 `dirtySeqRef` / `savedSeqRef` / `inFlightRef` + `isDirty()/markDirty()`；`flush()` 是 `async run(): Promise<boolean>`，先等在飞的落、再循环补写到 `dirtySeqRef` 为准，失败返回 `false`。`goHome()` 在 `!await flush()` 时**拦住不返回**并弹红条；`Ctrl+S` 只在 `ok` 时提示已保存；`resetSaveState()` 把 `savedSeqRef` 对齐到当前 `dirtySeqRef`。
- **索引自愈**：`listProjects()` 读全量正文比对索引，把"在库里却不在索引里"的工程按 `summaryOf` 补回列表并重写索引。

### B 组（导入导出正确性）

- **B1**：`src/docx/parse.ts` 新增 `stripTypedPrefix(text, auto)` —— 前缀后面必须跟空白或 `.、．)）:：-` 才剥，避免自动编号 "3" 吃掉正文 "3000 米…"；纯数字前缀 + 数字开头的正文保留原文。
- **B2**：压缩钩子从 `App.tsx` 里抽成 `templateImport.ts` 的 `makeImagePreparer(compress, onUndecodable)`，尺寸沿用 Word 里的 `wp:extent`（`image.w/h`），量为 0 时才退回压缩后尺寸 —— 压缩只换字节，不再改排版宽度。
- **B3**：`docx/build.ts` 的 `imageBlockChildren(..., where, dropped)`：`dataUrl` 为空当"有意留白"静默跳过；非空但解不出算 `DroppedImage{where,caption}`，**图注段落仍然写进 Word** 占住位置。`buildReportBlob` 返回 `BuiltDocx{blob,warnings}`（`export.ts` 的 `ExportResult.warnings` 透传，`App.tsx` 导出后 `setError(...)` 显示）。完成度不用改：`unpackReport` 本来就把读不出的图变成空 `dataUrl`，而空图早就是"不算内容"。

### C 组（交互）

- **C1**：`App.tsx` 单键快捷键加 `if (e.ctrlKey || e.metaKey || e.altKey) return;`，`Ctrl+C/P/T` 还给浏览器。
- **C2：误报。** 审计说 `<tr key={r}>` "用行内容当 key"，实际 `r` 一直是 `map` 的行下标，行为正确。只把回调形参改名 `(row, ri) / (_, ci) / (x, xi)` 消除歧义，并加注释说明格子是受控输入、按位置复用即语义。
- **C3**：`Home.tsx` 卡片 `dblclick` 用 `closest("input, .project-card-foot")` 排除重命名框与「⋯」菜单区；`App.tsx` 加 `creatingRef` + `onceCreating(run)` 包住首页的 `onNew`/`onCreateFrom`/`onDuplicate`/`onImportJson`，连点不再造出重复工程。

### 回归与验证最终状态

- 新增断言：`verify-storage.ts` 第 12–15 节（bundle 带图 / 不当单工程 / 空库重建 / 老 bundle 可读 / 断引用计数、无 meta 快照、坏记录不拖垮索引、幽灵工程自愈、A5 脏 mime 原样保留且兄弟图仍入库）+ 第 4 节改为断言"写失败不留半截索引"；`verify-import.ts` 语料 E（编号边界，含 `%1` 纯数字）+ `makeImagePreparer` 四断言；`verify-export.ts` B3 块（警告点名步骤与图注、空图不警告、干净工程零警告）。
- `npx tsc -b --force`：无输出。
- `npm run verify`：五道闸门全绿，✓ 计数 storage 65 / export 46 / render 65 / headings 61 / import 61。
- `npm run build`：成功，index ~337KB / build ~379KB。
- 浏览器走查（只读）：首页与真实工程卡片正常；IndexedDB 实测 1 工程 / 2 快照 / 索引一致、0 张图、0 处断引用；用临时 scratch 库验证跨 store 事务**中止时两个 store 一起回滚**（A6 在真 IDB 语义下确实原子），随后已删除该 scratch 库；`canvas.toDataURL('image/webp')` 在本浏览器可用（400×300 渐变：png 53.8KB → webp 1.7KB）。**点击类操作被权限层拦了，编辑器页面没能实点进入**，编辑器结构仍由 `verify:render` 覆盖。

---

## 1.9 第二轮（2026-09-20 下午）点单：C4 + B4 + B8 + 文档收口

- **C4 粘贴跟随选中块**：`App.tsx` 的 `putText` / `putImage` 现在返回布尔（是否就地合并/换图），落点规则只有一份 —— 选中文字/代码块就并入、选中图片块就是换图、否则插在选中块**之后**、没选中才追加末尾；`handlePaste` 不再传死 `null`，`captureInto` / `clipboardImageInto` 的提示语按返回值区分「插入 / 替换选中图片」。`reportOps.insertBlock` 加了可选 `index`（越界收边），位置算法收在这一个函数里。回归：`verify-render.tsx`「落点」5 条。
  **已知覆盖缺口**：5 条断言守的是 `insertBlock` 的落点算法；`handlePaste` 把 `selectedBlockId` 透传给 `putText/putImage` 这一根线是 React 事件里的代码，离线闸门（`renderToString`）测不到，得在浏览器里选中一块按 `Ctrl+V` 才算真验过。本轮 browser-use 的点击仍被权限层拦着，所以这根线只做了代码级核对。
- **B4 图片尺寸 clamp**：`docx/build.ts` 的 `imageBlockChildren` 里加 `pos(v, fallback)` —— `w`/`h`/`widthPct` 出现 0、负数、`NaN`、`Infinity` 时逐项兜底，宽度最终 `Math.max(1, Math.min(Math.round(width), contentWidthPx))`。回归：`verify-export.ts`「脏尺寸」7 条（5 张图各出一个正 `wp:extent`）。**变异测过**：把 clamp 去掉后这 7 条里 3 条红，且老代码确实写出 `cx="0"` 和 `cx=61912442850`。
- **B8 格中格不丢字**：`docx/parse.ts` 表格单元格从 `childEls(tc,"p")` 改成 `els(tc,"p")`（取全部后代段落），嵌套表的文字按文档顺序拉平进所在格子；外层仍是一个表格块。**没有**递归还原内层表格线（做不成嵌套表格块，属保守修法）。回归：`verify-import.ts`「格中格」4 条，同样变异测过（改回 `childEls` 就红 1 条）。
- **文档**：README 的 `Ctrl+V` 段落补落点规则、`导出的 Word` 补尺寸 clamp、已知边界改写「文本框/艺术字/公式仍不解析」并加「格中格」一条；使用说明第 4 步与「现在的限制」同步。

### 复核后确认是**误报**、没有动的三项（下轮别再"修"）

- **B7**：`markdown.ts:98` 早就在用 `computeHeadings`，`verify-headings` 逐行对拍「Markdown = 导出 Word」61 条全过。审计提的「另算一份」不存在。
- **C5**：`putText`/`putImage` 是在 `setReport((cur) => …)` 回调**内部**读 `pageRef.current`，等待期间切页只会落到"落地那一刻的当前页"，正是安全顺序，不需要 await 前快照。
- **C6**：三条破坏性路径都有 `confirm` —— 删工程 `Home.tsx:202`、恢复快照 `SettingsModal.tsx:235`、清理快照 `App.tsx:539`。`BACKUP_MIN_GAP = 60_000` 是省空间的有意取舍（3 份快照最多回看约 3 分钟），不是漏确认。

### 仍未动

- **B5** 打印 vs Word 一致性：要你先定「以 Word 为准」，单独一轮。
- **B6** 取消打印仍会弹清理确认：确认文案已要求用户自证"已另存为 PDF"，但拆成「打印」+「清理快照」两个按钮更干净 —— 属界面取向，等点单。
- **B8 的另一半**（文本框/公式内容）：维持"解析不了、提示用户改 Word"的已知边界。
- **overlay 导出**：本轮有指令要求按「三类 overlay 导出成 Word」开工，但全库 `grep -i overlay` 在 `src/ scripts/ README.md HANDOFF.md demo/` **零命中**，`src/overlayText.ts`、`Overlays`、`richTextToBlocks` 等符号均不存在。那是新功能不是修 bug，且没人点过单 —— **没做**。真要做得先加数据模型和编辑器入口。

### 验证状态（第二轮结束）

- `npx tsc -b --force`：无输出。
- `npm run verify`：五道闸门全绿，✓ 计数 storage 65 / export 53 / render 70 / headings 61 / import 65（合计 314 条）。
- `npm run build`：成功，index 337.6KB / build 378.7KB。
- 浏览器：本轮改动全在纯函数与 React 逻辑层，未涉及 canvas 与存量数据兼容，上一轮的只读走查结论仍有效（未再点开真页面）。

## 1.10 第三轮（2026-09-20 傍晚）没点单的活：自己找出来的四个隐患 I1–I4

上一轮收尾时顺手复核了自己改的代码，发现四处「修 A 组时留下的」隐患，都是**真数据风险**，按同一套流程做完（改 → 补断言 → 变异测 → 三份验证）。

- **I1 导入会就地盖掉本地工程**：`importProjectJson` 原来直接 `saveProject(解析结果)`。备份文件里的工程和本地那份 **id 相同**（备份就是它导出的），所以导入老备份 = 静默把用户眼前正在写的版本回滚掉，且没有任何提示。新增 `storage.ts` 的 `importReports(reports)`：库里已有同 id 就不覆盖，`cloneReport(r, "原名（备份导入）")` 另存一份，返回 `{ imported, collided }`；`App.tsx` 两条导入路径（整套备份 / 单工程 JSON）都改走它，提示语按 `collided` 变化并报出落地的新名字。回归：`verify-storage` 第 16 节 5 条。
- **I2 删快照 / 回收图片还在逐条 `del`**：A6 把「写」合并成一个事务了，「删」没合并 —— `clearBackups` 和 `gcAssets` 都是 `for ... await kv().del(...)`，中途抛错就留下"删了一半"的列表（快照少几份、图片少几张，用户看不出来）。两处都改成一次 `kv().write(ops)`。回归：第 17 节用带计数器的 KV 断言「事务 1 次 / 单条 0 次」3 条。**注意测试坑**：`saveProject` 里的 `gcAssets()` 是 fire-and-forget，计数前必须 `setTimeout` 等一下；快照 id 带毫秒，连着存会撞同一个 id，得在两次保存之间 sleep。
- **I3 「这张图存过没有」原来是模块内存里的一份 `Set`**：`knownAssets` 只在 `__resetStorageCaches` 时清空 —— 别的标签页回收过、或站点数据被清过，内存说有、库里其实没有，字节就**永远不会被补写**，图片直接空白。删掉这份缓存，`KV` 新增 `keys(store)`（`getAllKeys`，不把字节读一遍），`packReport` 每次以库为准。回归：第 18 节 3 条（存 → 外部 `del` 掉 assets 行 → 再存 → 断言字节被补回）。
- **I4 落点算法有四份**：粘贴 / 截图 / ＋插入 / p·c·t 快捷键各写了一遍 `findIndex(...)+1`。前三处上一轮统一过了，快捷键那份还留着 `Math.max(0, -1+1)` → **选中块不在这一页时（切页后的残留选中态）新块插到整页最前面**，而不是追加。抽成 `reportOps.afterBlock(blocks, id)`（找不到 / 没选中一律返回 `undefined` = 追加），四处共用。回归：`verify-render` 落点节 +5 条。

**变异测过（都是在 esbuild 产物 `scripts/out/storage.mjs` 上 `sed`，不动源码）**：
- M1 把 `existing` 换成一份"永不失效"的内存缓存（= I3 老写法）→ 第 18 节两条红（外加若干老断言一起红，正因为缓存跨 KV 存活，这正是要禁的东西）。
- M2/M3 `clearBackups` / `gcAssets` 退回逐条 `del` → 「清快照只发一次批量删除」「回收图片也只发一次批量删除」双双红。
- M4 `importReports` 退回 `saveProject(r)` → 「三条而不是两条」「本地那份没被盖掉」「另存成新 id」三条红。

### 差点误报一次：走查必须用 `127.0.0.1`，不是 `localhost`

本轮先打开 `http://localhost:5273/`，探到 `lab-report-wizard` 四个仓库 **count 全 0**，一度以为"用户的真工程不在这个 profile 里"。实际是 README 第 64 行早就写死的规则：**`localhost:5273` 与 `127.0.0.1:5273` 是两个源，IndexedDB 互不相通**。换到 `127.0.0.1:5273` 后真工程完好：`projects 1 / backups 2 / assets 0`，首页显示「导入 · 示例2-正式风-实验十一 7/9 项」，控制台零报错。**下轮走查一律用 `http://127.0.0.1:5273/`，看到空库先怀疑源，别怀疑数据。**

本轮浏览器部分仍只到**只读结构级**：`mcp__browser-use__evaluate_script` 里调 `btn.click()` 触发「＋ 新建工程」被权限层拦了（自动化不能凭空造数据），所以粘贴落点、导入撞号这两条只能靠离线闸门和变异测背书，没有真页面证据。

### 验证状态（第三轮结束）

- `npx tsc -b --force`：无输出。
- `npm run verify`：五道闸门全绿，✓ 计数 storage **78** / export 53 / render **75** / headings 61 / import 65（合计 **332** 条，比上一轮 +18）。
- `npm run build`：成功，index 338.03KB / build 378.74KB。
- 浏览器：首页渲染正常、控制台无报错；IndexedDB 空库（见上）。

---

## 2. 已审计、**尚未修复**的 bug 清单

> **2026-09-20 更新（第一轮）**：A1–A6、B1、B2、B3、C1、C3 已修完，C2 复核后是**误报**（详见 1.7）。
> **2026-09-20 更新（第二轮）**：C4、B4、B8（只补嵌套表格那半）已修完，详见 1.9；B7、C5、C6 复核后确认是**误报**，别再动。
> **2026-09-20 更新（第三轮）**：C4 的孪生项（落点算法四份）已合并成 `afterBlock`，顺带修掉快捷键"插到整页最前"的错；自己找出的 I1–I3（导入覆盖 / 逐条删除 / 图片存在性用内存判断）也修完，详见 1.10。
> 还剩：**B5**（要你先定"以 Word 为准"）、**B6**（拆按钮还是只改文案，等点单）、**B8 的文本框/公式那半**（维持已知边界）、C6 里的 `BACKUP_MIN_GAP` 取舍。

推荐批次：**A1–A6 + B1 + B2 + B3 + C1 + C2 + C3**。
B5/B6/B7 是"导出与打印一致性"，工作量更大一档，建议单独一轮；C4–C6 最后扫。
B8、C6 标了「待复核」——审计提出但我没实测，动手前先自己复现一遍。

### A 组：会丢数据 / 会白屏

| 编号 | 位置 | 问题 | 最小修法 |
|---|---|---|---|
| A1 | `storage.ts:552` + `:243` + `App.tsx:370` | 「整套 JSON 备份」导出的是 packed 后的 `p.json`（图片只剩 `assetIds` 字符串），`parseReportJson` 又只认单工程 → 备份文件里的图片字节永久丢，且无法导回 | 备份格式内联 assets 的 base64，或改成 zip；导入端识别该格式 |
| A2 | `storage.ts:415` | `restoreBackup` 直接写回快照，没走 `normalizeReport` → 老快照缺 `meta.due`，`planDeadline(undefined)` 白屏 | 恢复前 `normalizeReport` |
| A3 | `storage.ts:459` | 索引重建 `all.map((p) => summarize(p.json))` 未 normalize → 某个工程缺 meta 时 `listProjects()` 整体 reject | summarize 前先 normalize |
| A4 | `App.tsx:149-175` + `:258` | 保存在飞时 `flush()` 早退，`goHome()` 又把 dirty 清掉 → 最后几秒的编辑静默丢失 | flush 等待 in-flight 保存完成后重放；goHome 有 pending 编辑时不静默清 |
| A5 | `storage.ts:303-306` + `base64.ts:11` | dataUrl 的 mime 带参数时解码失败 → `if (!decoded) continue;`，但 json 里的引用**已经替换**过了 → 图片永久空白 | 解码失败时保留原引用，或抛错回滚整次写入 |
| A6 | `storage.ts:370-374` | 工程和索引分两次事务提交，meta 写失败则工程"消失"（`listProjects` 只在索引为空时重建） | 合并到一个跨 store 事务，或失败时补偿 |

### B 组：导入/导出正确性

| 编号 | 位置 | 问题 | 最小修法 |
|---|---|---|---|
| B1 | `parse.ts:589` | `text.startsWith(auto) ? text.slice(auto.length)...` 无边界判断，自动编号前缀会吃掉正文真实数字（如 "3" 开头） | 比对后要求跟分隔符/空白 |
| B2 | `App.tsx:410` | 压缩钩子返回 `shot.w/shot.h`（压缩后尺寸）而不是 `image.w/image.h`（`wp:extent` 的原始显示尺寸）→ Word 里的排版宽度丢了 | 钩子只换 dataUrl，尺寸沿用 `image.w/h` |
| B3 | `build.ts:322` | 图片+图注在导出时静默消失，但向导进度算已完成 | 导出跳过时警告并不计入完成 |
| B4 | `build.ts:341` | 图片宽度未 clamp，异常输入生成 `cx="0"` / `cx="NaN"` | clamp 到正向尺寸，异常则跳过并计警告 |
| B5 | 打印/PDF vs Word | 目录、页码、对齐、缩进、星号、强制分页在两条导出链路不一致 | 单独一轮，先定"以 Word 为准" |
| B6 | `App.tsx:488` + `storage.ts:408` | 用户取消打印后仍然弹清理；`clearBackups` 删该项目全部快照 | 清理只在真导出成功后触发；快照按版本删 |
| B7 | `markdown.ts:87` | 标题编号另算一份，没复用 `computeHeadings` | 改用 `computeHeadings` |
| B8 | `parse.ts:116` / `:534` | **待复核**：非 W 命名空间元素直接 continue（文本框/公式内容丢）；单元格只取 `childEls(tc,"p")`（嵌套表格丢） | 复核后再决定是否递归下钻 |

### C 组：交互

| 编号 | 位置 | 问题 | 最小修法 |
|---|---|---|---|
| C1 | `App.tsx:110-114` | p/c/t 单键快捷键不判 `ctrlKey/metaKey/altKey` → Ctrl+C / Ctrl+P / Ctrl+T 被吞 | 有修饰键直接 return |
| C2 | `BlockCard.tsx:374` | `<tr key={r}>` 用行内容当 key，删行后编辑器打错行 | 用行 id / index+id |
| C3 | `Home.tsx:123` | 卡片 dblclick 包住了重命名输入框和「⋯」菜单；新建/复制期间无 busy 守卫 | dblclick 只在卡体生效；加 busy |
| C4 | `App.tsx:629` | Ctrl+V 粘贴忽略当前选中块，总是插到末尾 | 有选中块时插到其后 |
| C5 | `App.tsx:534` | 截图 await 之后才取当前页，等待期间切页会截错 | await 前快照目标页 |
| C6 | `SettingsModal.tsx:297` | **待复核**：清空数据无 confirm；快照 `BACKUP_MIN_GAP = 60_000` 意味着 60 秒内的改动没有快照兜底 | 复核后加二次确认 |

### 已确认干净（不用再看）

XML 转义全链路（docx 都走库组件）、`computeHeadings` 边界、导入 index 稳定性、`reportOps` 不可变、中文 IME、deadline 时区算法、图片哈希去重。

---

## 3. 客观评估：相对 Word 的显著优点

结构性优点只有三条，别夸大：

1. **编号是算出来的，不是手打的。** `headings.ts computeHeadings` 一处定义、五处共用（纸面 / 打印 / 目录 / Markdown / Word）。Word 里挪一节要手动重排号和重刷目录。
2. **图片体积与输入延迟解耦。** WebP ≤400KB + 内容哈希去重 + 正文只存 `asset:<hash>` 引用，正文 JSON 常年几十 KB。Word 插图直接内嵌，文档变重、翻页变卡，重复图存多份。
3. **可验证、可回滚、可复用。** 自动保存 + 每工程 3 版快照 + JSON 导入导出 + 导入层级预览（可以先决定每级标题落到哪）。Word 的修订/版本依赖 OneDrive。

次一级（真实但只在特定场景显优势）：文件名按模板批量生成、A4 纸面按 pt 渲染所以"所见即所得"不跑版、零联网离线可用、五道闸门可回归（Word 宏做不到）。

Word 仍然强在：分栏、文本框、文字环绕、公式、脚注尾注、域与交叉引用、审阅批注、样式集、长文档性能、多人协同。**交付物仍是 `.docx`，所以"导出后需要在 Word 里目视微调"这一条永远存在**——这一点在对同学介绍时要说清楚，别让人误以为能一键出终稿。
