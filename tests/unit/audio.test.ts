import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAudioForWhisper, prepareFromSamples, timestampedFilename } from "@/lib/audio";

const SAMPLE_RATE = 16000;
// Vercel のリクエストボディ上限。分割した1個がこれを超えると関数に届かない
const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

async function readWav(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer());
  const text = (offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
  return {
    riff: text(0, 4),
    wave: text(8, 4),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
    sample: (index: number) => view.getInt16(44 + index * 2, true),
  };
}

describe("prepareFromSamples", () => {
  it("120秒ずつに分け、端数は最後の1個にまとめる", () => {
    const prepared = prepareFromSamples(new Float32Array(SAMPLE_RATE * 250));
    expect(prepared.total).toBe(3);
    expect(prepared.get(0).filename).toBe("part-1.wav");
    expect(prepared.get(2).filename).toBe("part-3.wav");
    expect(prepared.get(2).blob.size).toBe(44 + SAMPLE_RATE * 10 * 2);
  });

  it("分割した1個が Vercel のボディ上限に収まる", () => {
    const prepared = prepareFromSamples(new Float32Array(SAMPLE_RATE * 120));
    expect(prepared.total).toBe(1);
    expect(prepared.get(0).blob.size).toBeLessThan(VERCEL_BODY_LIMIT);
  });

  it("16kHz / モノラル / 16bit の WAV を作る", async () => {
    const wav = await readWav(prepareFromSamples(new Float32Array(SAMPLE_RATE)).get(0).blob);
    expect(wav).toMatchObject({ riff: "RIFF", wave: "WAVE", channels: 1, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    expect(wav.dataBytes).toBe(SAMPLE_RATE * 2);
  });

  it("範囲外の振幅は割れた音として端に張り付かせ、符号を反転させない", async () => {
    const wav = await readWav(prepareFromSamples(Float32Array.from([2, -2, 0.5])).get(0).blob);
    expect(wav.sample(0)).toBe(32767);
    expect(wav.sample(1)).toBe(-32768);
    expect(wav.sample(2)).toBe(Math.trunc(0.5 * 0x7fff));
  });
});

describe("prepareAudioForWhisper", () => {
  it("小さい録音はデコードせず、そのまま1個で送る", async () => {
    const blob = new Blob([new Uint8Array(1024)], { type: "audio/webm" });
    const prepared = await prepareAudioForWhisper(blob, "claudio.webm");
    expect(prepared.total).toBe(1);
    expect(prepared.get(0)).toEqual({ blob, filename: "claudio.webm" });
  });
});

describe("timestampedFilename", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("保存した時刻を分まで入れる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 1, 22, 59));
    expect(timestampedFilename("webm")).toBe("claudio-20261007-0122.webm");
  });
});
