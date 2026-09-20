// fake-indexeddb 的 auto 入口在 package.json exports 里没有指向自己的 d.ts，
// 这里补一个环境声明，让 tsc 能检查 scripts/（否则整条 verify 链路类型够不到）。
declare module "fake-indexeddb/auto";
