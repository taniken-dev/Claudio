// Vercel のリクエストボディ上限は 4.5MB（プラットフォーム側の制約で変更不可）。
// 実測で録音は約30kbps なので、1時間だと約12.7MB とこの上限を確実に超える。
// Whisper 側の 25MB 制限より Vercel のほうが厳しいので、こちらに余裕をみて合わせる。
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
// 16kHz / mono / 16bit = 32KB/s。120秒で約3.84MBとなり上限に収まる。
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 120;

export interface AudioPart {
  blob: Blob;
  filename: string;
}

/**
 * チャンクを事前に全部作らず、get() が呼ばれた時点で1個ずつエンコードする。
 * 1時間の録音を WAV 化すると全チャンク合計で 110MB を超えるため、
 * まとめて保持するとタブが落ちて録音そのものを失う危険がある。
 */
export interface PreparedAudio {
  total: number;
  get(index: number): AudioPart;
}

export function timestampedFilename(extension: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `claudio-${stamp}.${extension}`;
}

export function saveBlobLocally(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function prepareAudioForWhisper(blob: Blob, sourceName: string): Promise<PreparedAudio> {
  if (blob.size <= MAX_UPLOAD_BYTES) {
    return { total: 1, get: () => ({ blob, filename: sourceName }) };
  }

  return prepareFromSamples(await decodeToMono(blob));
}

export function prepareFromSamples(samples: Float32Array): PreparedAudio {
  const samplesPerChunk = CHUNK_SECONDS * TARGET_SAMPLE_RATE;
  const total = Math.max(1, Math.ceil(samples.length / samplesPerChunk));

  return {
    total,
    get(index: number): AudioPart {
      const offset = index * samplesPerChunk;
      const slice = samples.subarray(offset, Math.min(offset + samplesPerChunk, samples.length));
      // 呼ばれるたびに生成する。呼び出し側が送信後に手放せば1個分しかメモリに残らない。
      return {
        blob: encodeWav(slice, TARGET_SAMPLE_RATE),
        filename: `part-${index + 1}.wav`,
      };
    },
  };
}

async function decodeToMono(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);

  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error("音声ファイルを解析できませんでした。対応していない形式の可能性があります。");
  }

  const channels = decoded.numberOfChannels;
  // 先頭チャンネルに直接混ぜ込む。別バッファを確保すると1時間の録音で
  // 230MB ほど余計に積み上がるため、デコード済みバッファを再利用する。
  const merged = decoded.getChannelData(0);
  if (channels === 1) return merged;

  for (let ch = 1; ch < channels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < merged.length; i++) merged[i] += data[i];
  }
  for (let i = 0; i < merged.length; i++) merged[i] /= channels;
  return merged;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Blob([bytes], { type: "audio/wav" });
}
