// Whisper が音声に無いものを書き足す「幻覚」を取り除く。実際の録音で出たものに絞っている。

export const LOOP_NOTICE = "［この先は文字起こしが同じ言葉の繰り返しになったため除外しました］";

// 同じ語がこれだけ続いたらループとみなす。「うんうんうん」「そうそうそう」程度では引っかからない
const LOOP_REPEATS = 15;
const LOOP_PATTERN = new RegExp(String.raw`(\S{1,20}?)(?:[\s、。,.]*\1){${LOOP_REPEATS - 1},}`, "u");

// 発言の区切りに絵文字を差し込むことがある（実例: 🌵 が10分で128個）
const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;
// 字幕の見出しのような架空の文を差し込むことがある（実例: 【質問】 今後の目標は?）
const BRACKET_HEADING = /【[^】]{1,10}】\s*(?:[^\s【]{0,20}?[?？。])?\s*/g;
// 動画字幕で学習した締めの定型文（実例: 実際の会話がこれに置き換わった）
const VIDEO_OUTRO = /ご視聴ありがとうございました[。.!！]?\s*/g;

export interface CleanedTranscript {
  text: string;
  /** ループを検出して後ろを捨てたか */
  looped: boolean;
}

export function cleanTranscript(raw: string): CleanedTranscript {
  let text = raw
    .replace(EMOJI, "")
    .replace(BRACKET_HEADING, "")
    .replace(VIDEO_OUTRO, "")
    .replace(/[ \t　]{2,}/g, " ")
    .trim();

  // Whisper は直前の出力を手がかりに続きを書くので、一度ループすると最後まで抜け出せない。
  // ループ以降に正しい文は残っていないため、始まった所から先は捨てて、欠けたことが分かるようにする。
  const loop = LOOP_PATTERN.exec(text);
  if (!loop) return { text, looped: false };
  text = text.slice(0, loop.index).trimEnd();
  return { text: text ? `${text}\n${LOOP_NOTICE}` : LOOP_NOTICE, looped: true };
}
