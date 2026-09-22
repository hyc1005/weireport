import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages 项目站地址为 user.github.io/<repo>/，构建时按仓库名补 base；本地开发保持根路径
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const base = process.env.GITHUB_ACTIONS ? `/${repo}/` : "/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5273,
    strictPort: true,
  },
});
