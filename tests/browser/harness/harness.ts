// lib/recorder.ts を本物の Chrome で動かすためのページ。アプリ本体は Google ログインが壁で
// 自動テストできないので、録音の制御だけをここに載せて Playwright から操作する。
import { beginRecording, type Recording, type Sources } from "../../../lib/recorder";

interface DisplayOptions {
  /** 共有ダイアログで「音声を共有」を外された状態を再現する */
  withAudio: boolean;
  /** 共有ダイアログでキャンセルされた状態を再現する */
  reject: boolean;
  /** 画面が何ミリ秒ごとに変わるか。スライド中心の会議は滅多に変わらない */
  repaintMs: number;
}

const calls: string[] = [];
const events: { type: "warning" | "autoStop"; message: string }[] = [];
const tracks: { mic: MediaStreamTrack[]; display: MediaStreamTrack[] } = { mic: [], display: [] };
let displayOptions: DisplayOptions = { withAudio: true, reject: false, repaintMs: 100 };
let recording: Recording | null = null;

const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  calls.push("getUserMedia");
  // Chrome の偽マイク（--use-fake-device-for-media-stream）がビープ音を返す
  const stream = await realGetUserMedia(constraints);
  tracks.mic.push(...stream.getTracks());
  return stream;
};

// 本物の getDisplayMedia は共有ダイアログを自動で通せないので、canvas の映像と発振音で代用する
navigator.mediaDevices.getDisplayMedia = async (options) => {
  calls.push("getDisplayMedia");
  if (displayOptions.reject) throw new DOMException("Permission denied", "NotAllowedError");

  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const g = canvas.getContext("2d")!;
  let frame = 0;
  const paint = () => {
    g.fillStyle = `hsl(${(frame++ * 40) % 360} 60% 50%)`;
    g.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  setInterval(paint, displayOptions.repaintMs);
  const stream = canvas.captureStream(30);

  if (options?.audio && displayOptions.withAudio) {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
  }
  tracks.display.push(...stream.getTracks());
  return stream;
};

/** 本物の切断（Bluetooth の電池切れ、共有停止バー）ではトラックが止まり ended が届く */
function endTrack(track: MediaStreamTrack | undefined) {
  if (!track) throw new Error("止めるトラックがありません");
  track.stop();
  track.dispatchEvent(new Event("ended"));
}

async function mediaDuration(blob: Blob, kind: "audio" | "video"): Promise<number> {
  const el = document.createElement(kind);
  el.muted = true;
  el.src = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    el.onloadedmetadata = resolve;
    el.onerror = () => reject(new Error(`${kind} を読み込めません`));
  });
  // MediaRecorder の webm は duration が Infinity。末尾へシークさせると実際の長さが分かる
  if (el.duration === Infinity) {
    await new Promise((resolve) => {
      el.ondurationchange = () => { if (el.duration !== Infinity) resolve(null); };
      el.currentTime = 1e9;
    });
  }
  URL.revokeObjectURL(el.src);
  return el.duration;
}

const harness = {
  calls,
  events,
  setDisplay(options: Partial<DisplayOptions>) {
    displayOptions = { ...displayOptions, ...options };
  },
  async start(sources: Sources) {
    recording = await beginRecording(sources, {
      onWarning: (message) => events.push({ type: "warning", message }),
      onAutoStop: (message) => events.push({ type: "autoStop", message }),
    });
    return recording.activeSources;
  },
  videoBytes: () => recording!.videoBytes(),
  async stop() {
    const result = await recording!.stop();
    return {
      audio: {
        size: result.audio.size,
        type: result.audio.type,
        duration: result.audio.size ? await mediaDuration(result.audio, "audio") : 0,
      },
      video: result.video && {
        size: result.video.blob.size,
        extension: result.video.extension,
        errored: result.video.errored,
        duration: result.video.blob.size ? await mediaDuration(result.video.blob, "video") : 0,
      },
    };
  },
  /** stop() を続けて呼んでも同じ結果か */
  async stopTwiceSame() {
    const [a, b] = [recording!.stop(), recording!.stop()];
    return a === b && (await a) === (await b);
  },
  cancel: () => recording!.cancel(),
  endMic: () => endTrack(tracks.mic.at(-1)),
  endShare: () => endTrack(tracks.display.find((t) => t.kind === "video")),
  liveTracks: () => [...tracks.mic, ...tracks.display].filter((t) => t.readyState === "live").length,
};

declare global {
  interface Window { harness: typeof harness }
}
window.harness = harness;
