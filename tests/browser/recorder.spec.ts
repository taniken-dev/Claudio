import { expect, test, type Page } from "@playwright/test";
import type { Sources } from "../../lib/recorder";

const MIC: Sources = { mic: true, system: false, screen: false };
const MIC_AND_SYSTEM: Sources = { mic: true, system: true, screen: false };
const SCREEN: Sources = { mic: true, system: true, screen: true };

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "harness" in window);
});

const start = (page: Page, sources: Sources) => page.evaluate((s) => window.harness.start(s), sources);
const stop = (page: Page) => page.evaluate(() => window.harness.stop());
const events = (page: Page) => page.evaluate(() => window.harness.events);

test("共有ダイアログをマイクより先に出す（操作の失効で共有が弾かれないように）", async ({ page }) => {
  await start(page, MIC_AND_SYSTEM);
  expect(await page.evaluate(() => window.harness.calls)).toEqual(["getDisplayMedia", "getUserMedia"]);
  await stop(page);
});

test("マイクだけで録って止めると、録った長さの音声が返る", async ({ page }) => {
  expect(await start(page, MIC)).toEqual(MIC);
  await page.waitForTimeout(2000);
  const { audio, video } = await stop(page);
  expect(audio.type).toContain("audio/webm");
  expect(audio.duration).toBeGreaterThan(1.5);
  expect(video).toBeNull();
});

test("マイクだけの録音中にマイクが切れても固まらず、そこまでの録音を返す", async ({ page }) => {
  await start(page, MIC);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.harness.endMic());

  await expect.poll(() => events(page)).toContainEqual({
    type: "autoStop",
    message: "音声の入力が途切れたため、録音を終了しました。",
  });
  const { audio } = await stop(page);
  expect(audio.duration).toBeGreaterThan(1);
});

test("マイクと内部音声を混ぜているときは、マイクが切れても録音を続けて警告だけ出す", async ({ page }) => {
  expect(await start(page, MIC_AND_SYSTEM)).toEqual(MIC_AND_SYSTEM);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.harness.endMic());
  await page.waitForTimeout(1500);

  const got = await events(page);
  expect(got.filter((e) => e.type === "autoStop")).toEqual([]);
  expect(got).toContainEqual(expect.objectContaining({ type: "warning", message: expect.stringContaining("マイクの入力が途切れました") }));
  const { audio } = await stop(page);
  expect(audio.duration).toBeGreaterThan(2);
});

test("画面録画は、停止を待ってから組み立てるので最後まで再生できる MP4 になる", async ({ page }) => {
  expect(await start(page, SCREEN)).toEqual(SCREEN);
  await page.waitForTimeout(3000);
  const { audio, video } = await stop(page);

  expect(video).toMatchObject({ extension: "mp4", errored: false });
  expect(video!.duration).toBeGreaterThan(2.5);
  expect(audio.duration).toBeGreaterThan(2.5);
});

test("ほとんど変わらない画面でも、録画中から少しずつデータが届く（キーフレームの溜め込み対策）", async ({ page }) => {
  await page.evaluate(() => window.harness.setDisplay({ repaintMs: 2000 }));
  await start(page, SCREEN);
  // キーフレームは5秒ごと。既定（100フレームごと）のままだと、2秒に1回変わる画面では200秒出てこない。
  // 開始直後にファイルの先頭（36バイト）だけは届くので、それを超える映像が来るかで見る。
  // 実測: 対策ありは約6秒で100KB（同じブラウザで2回目以降の録画は最初だけ約13秒かかる）、
  // なしは14秒たっても36バイトのまま
  await expect.poll(() => page.evaluate(() => window.harness.videoBytes()), { timeout: 30_000 }).toBeGreaterThan(10_000);
  await stop(page);
});

test("ブラウザの「共有を停止」で止められたら、そこまでの録画で畳む", async ({ page }) => {
  await start(page, SCREEN);
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.harness.endShare());

  await expect.poll(() => events(page)).toContainEqual({
    type: "autoStop",
    message: "画面共有が停止されたため、録画を終了しました。",
  });
  const { video } = await stop(page);
  expect(video!.size).toBeGreaterThan(0);
});

test("内部音声を選んだのに音声が共有されなければ、始めずに取ったトラックを止める", async ({ page }) => {
  await page.evaluate(() => window.harness.setDisplay({ withAudio: false }));
  // 画面録画ありだと、映像のトラックを取ったあとで音声の不足に気づくので、止め忘れると共有が続いてしまう
  await expect(start(page, SCREEN)).rejects.toThrow("音声が共有されていません");
  expect(await page.evaluate(() => window.harness.liveTracks())).toBe(0);
});

test("共有ダイアログでキャンセルされたら、理由の分かるエラーにする", async ({ page }) => {
  await page.evaluate(() => window.harness.setDisplay({ reject: true }));
  await expect(start(page, SCREEN)).rejects.toThrow("画面の共有がキャンセルされました");
  expect(await page.evaluate(() => window.harness.calls)).toEqual(["getDisplayMedia"]);
});

test("破棄したら、停止扱いの通知を出さずにマイクも共有もすべて止める", async ({ page }) => {
  await start(page, SCREEN);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.harness.cancel());
  await page.waitForTimeout(500);

  expect(await events(page)).toEqual([]);
  expect(await page.evaluate(() => window.harness.liveTracks())).toBe(0);
});

test("停止を続けて呼んでも、同じ結果を返す", async ({ page }) => {
  await start(page, MIC);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.harness.stopTwiceSame())).toBe(true);
});
