// テスト用のページを esbuild で組み立てて配信する。localhost はセキュアコンテキストなのでマイクを使える。
import * as esbuild from "esbuild";

const port = Number(process.env.PORT ?? 4173);
const ctx = await esbuild.context({
  entryPoints: ["tests/browser/harness/harness.ts"],
  bundle: true,
  format: "iife",
  outfile: "tests/browser/harness/harness.js",
  write: false,
});
await ctx.serve({ servedir: "tests/browser/harness", port, host: "127.0.0.1" });
console.log(`harness: http://127.0.0.1:${port}/`);
