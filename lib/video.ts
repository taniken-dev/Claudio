// 画面録画の設定。720p / 1Mbps で1時間あたり約450MB。
// 共有元が4Kでもここまで落とす。これ以上の画質は手元保存もタブのメモリも現実的でなくなる。
export const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  // 資料や画面共有が主な用途なので、滑らかさよりサイズを優先する
  frameRate: { ideal: 15, max: 30 },
};

export const VIDEO_BITS_PER_SECOND = 1_000_000;
// Chrome の MP4 は次のキーフレームが来るまで映像を内部に溜めて出さない。既定のキーフレームは
// 100フレームごとで、画面共有は画面が変わったときしかフレームが来ないため、スライド中心の会議だと
// 2時間分が停止の瞬間まで溜まり続ける（実測: 2秒に1回変わる画面で90秒間まったく出力されなかった）。
// 時間で区切らせて、録画中も少しずつ Blob として受け取れるようにする。
export const VIDEO_KEYFRAME_INTERVAL_MS = 5000;
// 動画に載せる音声。文字起こし用（32kbps）より上げて、聞き返しに耐えるようにする。
export const VIDEO_AUDIO_BITS_PER_SECOND = 64_000;

// MediaRecorder が MP4 を直接吐けるのは Chrome 126+ / Edge / Safari。
// Firefox は webm しか対応しないため、その場合だけコンテナを落とす。
const MP4_TYPES = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', "video/mp4"];
const WEBM_TYPES = ["video/webm;codecs=vp8,opus", "video/webm"];

export interface VideoFormat {
  /** MediaRecorder に渡す mimeType。空文字ならブラウザ既定に任せる */
  mimeType: string;
  extension: "mp4" | "webm";
}

export function pickVideoFormat(): VideoFormat {
  for (const mimeType of MP4_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, extension: "mp4" };
  }
  for (const mimeType of WEBM_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, extension: "webm" };
  }
  return { mimeType: "", extension: "webm" };
}

// TypeScript の型定義にはまだ無いが Chrome は対応している。対応しないブラウザは無視するだけで害はない。
type RecorderOptionsWithKeyFrame = MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number };

export function videoRecorderOptions(format: VideoFormat): MediaRecorderOptions {
  const options: RecorderOptionsWithKeyFrame = {
    ...(format.mimeType ? { mimeType: format.mimeType } : {}),
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: VIDEO_AUDIO_BITS_PER_SECOND,
    videoKeyFrameIntervalDuration: VIDEO_KEYFRAME_INTERVAL_MS,
  };
  return options;
}
