import { describe, expect, it } from "vitest";
import { LOOP_NOTICE, cleanTranscript } from "@/lib/transcript";

describe("cleanTranscript", () => {
  it("普通の会話はそのまま返す（「うんうんうん」程度の繰り返しは消さない）", () => {
    const text = "うんうんうん そうそうそう 1 2 3 4 5 6 7 8 じゃあやろう";
    expect(cleanTranscript(text)).toEqual({ text, looped: false });
  });

  it("同じ語が延々と続くループは、始まった所から先を捨てて印を付ける（実例: 88 88 88…）", () => {
    const text = `クッキー見るアプリこれ本命ってこと? 送り 送り ${"88 ".repeat(300)}`;
    expect(cleanTranscript(text)).toEqual({ text: `クッキー見るアプリこれ本命ってこと? 送り 送り\n${LOOP_NOTICE}`, looped: true });
  });

  it("区切りのない1文字のループも捉える（実例: イイイイ…）", () => {
    const { text, looped } = cleanTranscript(`話してた。${"イ".repeat(80)}`);
    expect(looped).toBe(true);
    expect(text).toBe(`話してた。\n${LOOP_NOTICE}`);
  });

  it("発言の区切りに差し込まれた絵文字を消す（実例: 🌵）", () => {
    expect(cleanTranscript("🌵️俺がやってて感じたのは 🌵️ワンパターン 🌵️うん").text).toBe("俺がやってて感じたのは ワンパターン うん");
  });

  it("【】で始まる架空の定型文を消す（実例: 【質問】 今後の目標は?）", () => {
    expect(cleanTranscript("【質問】 今後の目標は? いやー… 違うの考える? 【質問】 今後の目標は? うーん").text).toBe("いやー… 違うの考える? うーん");
  });

  it("動画の締めの定型文を消す（実例: ご視聴ありがとうございました）", () => {
    expect(cleanTranscript("来た。 違うか。 ご視聴ありがとうございました。 コーチングセミナー?").text).toBe("来た。 違うか。 コーチングセミナー?");
  });

  it("2万字の文字起こしでも一瞬で終わる", () => {
    const text = "これは普通の会話の文字起こしです。".repeat(1200);
    const started = performance.now();
    cleanTranscript(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
