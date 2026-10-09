import { defineConfig } from "@playwright/test";

const port = 4173;

export default defineConfig({
  testDir: "tests/browser",
  // 録音の長さを実時間で待つテストがあるため
  timeout: 60_000,
  // 1台の Chrome で偽マイクを取り合わないよう、並列にしない
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    // 同梱の Chromium は H.264 / AAC を持たず MP4 を録れないので、本物の Chrome を使う
    channel: "chrome",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: "node tests/browser/serve.mjs",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
  },
});
