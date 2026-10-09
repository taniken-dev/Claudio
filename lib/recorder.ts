import { VIDEO_CONSTRAINTS, pickVideoFormat, videoRecorderOptions } from "./video";

// 録音の開始・停止・破棄をまとめたもの。React に依存させず、本物のブラウザで単体に動かして確かめられるようにしている。

export interface Sources {
  mic: boolean;
  system: boolean;
  screen: boolean;
}

export interface RecordingHandlers {
  /** 録音は続いているが知らせるべき異常（マイクの途切れ、録画の停止） */
  onWarning?: (message: string) => void;
  /** ボタン以外のきっかけ（共有停止・音声の途切れ）で録音を畳むべきとき。受け取った側が stop() する */
  onAutoStop?: (reason: string) => void;
}

export interface RecordedVideo {
  blob: Blob;
  extension: "mp4" | "webm";
  /** 途中でエラーになり、止まった時点までの録画であること */
  errored: boolean;
}

export interface RecordingResult {
  /** 手元に保存する、区切らない1本の録音 */
  audio: Blob;
  /** 文字起こし用に一定の長さで区切った録音。1個ずつ単独で再生でき、そのまま Whisper に送れる */
  segments: Blob[];
  video: RecordedVideo | null;
}

export interface RecordingOptions {
  /** 文字起こし用に区切る長さ */
  segmentMs?: number;
}

// 32kbps で10分は約2.4MB。Vercel のリクエストボディ上限（4.5MB）に余裕をもって収まり、
// Whisper がループしても失うのはこの長さまでで済む。
export const SEGMENT_MS = 10 * 60 * 1000;
const AUDIO_BITS_PER_SECOND = 32000;

export interface Recording {
  /** チェックボックスは希望であって保証ではない（共有ダイアログで音声を切られることがある）。実際に取れたトラックから確定した音源 */
  readonly activeSources: Sources;
  videoBytes(): number;
  /** 何度呼んでも同じ結果を返す */
  stop(): Promise<RecordingResult>;
  cancel(): void;
}

/**
 * getDisplayMedia は「ユーザー操作の直後」でないとブラウザに弾かれ、この操作は数秒で失効する。
 * クリックの処理から await を挟まずに呼ぶこと。
 */
export async function beginRecording(
  sources: Sources,
  handlers: RecordingHandlers = {},
  { segmentMs = SEGMENT_MS }: RecordingOptions = {},
): Promise<Recording> {
  let finished = false;
  // 停止・破棄の後に届いたトラックのイベントで、終わった録音を畳み直さないようにする
  const warn = (message: string) => { if (!finished) handlers.onWarning?.(message); };
  const autoStop = (reason: string) => { if (!finished) handlers.onAutoStop?.(reason); };

  let audioContext: AudioContext | null = null;
  let displayStream: MediaStream | null = null;
  let micStream: MediaStream | null = null;
  // 区切り用のレコーダーに渡す複製。元と同じく、終わったら止める
  const clonedTracks: MediaStreamTrack[] = [];
  const release = () => {
    clonedTracks.forEach((t) => t.stop());
    void audioContext?.close();
    audioContext = null;
    displayStream?.getTracks().forEach((t) => t.stop());
    displayStream = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
  };

  /**
   * 文字起こし用の音声と、画面録画用の映像+音声を組み立てる。
   * PC内部音声と画面録画はどちらも getDisplayMedia 由来なので、共有ダイアログが
   * 二度出ないよう1回の呼び出しでまかない、取れたトラックを用途別に振り分ける。
   */
  const buildStreams = async () => {
    let videoTrack: MediaStreamTrack | null = null;

    // マイク許可のダイアログで迷われると操作が失効するため、操作を必要としない getUserMedia より先に必ずこちらを呼ぶ。
    if (sources.system || sources.screen) {
      try {
        // 音声だけを要求する指定はできないので、内部音声のみのときも映像を取って後で捨てる。
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: sources.screen ? VIDEO_CONSTRAINTS : true,
          audio: sources.system,
        });
      } catch {
        throw new Error("画面の共有がキャンセルされました。PC内部音声や画面録画には共有の許可が必要です。");
      }

      const track = displayStream.getVideoTracks()[0] ?? null;
      if (sources.screen && track) {
        // 要求時の指定を無視して共有元の解像度で返すブラウザがあるため、取得後にも掛け直す
        try {
          await track.applyConstraints(VIDEO_CONSTRAINTS);
        } catch {}
        videoTrack = track;
      } else {
        track?.stop();
      }

      if (sources.system && displayStream.getAudioTracks().length === 0) {
        throw new Error("音声が共有されていません。共有ダイアログで「タブの音声を共有」を有効にしてください。");
      }
    }

    if (sources.mic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error("マイクへのアクセスが拒否されました。");
      }
    }

    const systemAudio = displayStream?.getAudioTracks().length ? displayStream : null;
    const audioStreams = [micStream, systemAudio].filter((s): s is MediaStream => s !== null);
    if (audioStreams.length === 0) {
      throw new Error("録音する音声がありません。マイクかPC内部音声のどちらかを選んでください。");
    }

    const activeSources: Sources = { mic: micStream !== null, system: systemAudio !== null, screen: videoTrack !== null };

    // 音声を混ぜている場合、マイクが途切れても録音は止まらず無音のまま続く。
    // Bluetooth マイクの電池切れなどに気づけるよう知らせる（自分で stop() した場合は発火しない）。
    micStream?.getAudioTracks()[0]?.addEventListener(
      "ended",
      () => warn("🎤 マイクの入力が途切れました。録音は続いていますが、マイクの音は入っていません。"),
      { once: true },
    );

    // 音源が1つで画面録画もしないなら、余計な処理を挟まず元のストリームをそのまま使う
    if (audioStreams.length === 1 && !videoTrack) {
      return { audio: audioStreams[0], video: null, activeSources };
    }

    const ctx = new AudioContext();
    audioContext = ctx;
    const inputs = audioStreams.map((stream) => ctx.createMediaStreamSource(stream));
    const mixInto = () => {
      const dest = ctx.createMediaStreamDestination();
      inputs.forEach((node) => node.connect(dest));
      return dest.stream;
    };

    return {
      audio: mixInto(),
      // 1本の音声トラックを2つの MediaRecorder で共有するとブラウザによっては録れないため、
      // 動画側には同じミックスの別の出力先を渡す。
      video: videoTrack ? new MediaStream([videoTrack, ...mixInto().getAudioTracks()]) : null,
      activeSources,
    };
  };

  let streams: Awaited<ReturnType<typeof buildStreams>>;
  try {
    streams = await buildStreams();
  } catch (err) {
    release();
    throw err;
  }

  const audioMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const audioRecorder = new MediaRecorder(streams.audio, { mimeType: audioMimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
  const audioChunks: Blob[] = [];
  audioRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };

  let videoRecorder: MediaRecorder | null = null;
  let videoExtension: "mp4" | "webm" = "mp4";
  let videoErrored = false;
  const videoChunks: Blob[] = [];
  if (streams.video) {
    const format = pickVideoFormat();
    videoExtension = format.extension;
    videoRecorder = new MediaRecorder(streams.video, videoRecorderOptions(format));
    videoRecorder.ondataavailable = (e) => { if (e.data.size > 0) videoChunks.push(e.data); };
    // エラーが起きると録画はそこで止まるが、それまでのデータは残るので捨てずに停止時に保存する
    videoRecorder.addEventListener("error", (e) => {
      console.error("画面録画のエラー:", e);
      videoErrored = true;
      warn("⚠️ 画面録画が止まりました。止まるまでの録画は停止時に保存します（音声の録音は続いています）。");
    }, { once: true });
    // 1時間で数百MBになるため、音声より粗い間隔で受け取って配列の要素数を抑える
    videoRecorder.start(1000);

    // ブラウザの「共有を停止」バーで止められたら、録れたところまでで正常に畳む
    streams.video.getVideoTracks()[0]?.addEventListener(
      "ended",
      () => autoStop("画面共有が停止されたため、録画を終了しました。"),
      { once: true },
    );
  }

  // 生のストリームを録っている場合、トラックが切れるとブラウザが録音を勝手に止める。
  // 停止処理をボタンにしか紐づけていないと、録音中の表示のまま固まりデータも保存されない。
  audioRecorder.addEventListener("stop", () => autoStop("音声の入力が途切れたため、録音を終了しました。"), { once: true });
  audioRecorder.start(100);

  // 文字起こし用には、保存用とは別のレコーダーで一定時間ごとに新しいファイルを録り直す。
  // 録音全体を後からデコードして切り分けると、1時間で一時的に約3.6GBを使い、93分を超えると
  // デコード自体が失敗するため。保存用の1本と同じトラックを共有するとブラウザによっては録れないので、複製を渡す。
  const segmentStream = new MediaStream(streams.audio.getAudioTracks().map((t) => {
    const clone = t.clone();
    clonedTracks.push(clone);
    return clone;
  }));
  const segments: Promise<Blob>[] = [];
  const startSegment = () => {
    const recorder = new MediaRecorder(segmentStream, { mimeType: audioMimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    segments.push(new Promise((resolve) => {
      recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true });
    }));
    recorder.start(1000);
    return recorder;
  };
  let segmentRecorder = startSegment();
  const rotation = setInterval(() => {
    // 先に次を始めてから前を止め、区切り目で音が抜けないようにする
    const previous = segmentRecorder;
    segmentRecorder = startSegment();
    if (previous.state !== "inactive") previous.stop();
  }, segmentMs);
  const stopSegments = () => {
    clearInterval(rotation);
    if (segmentRecorder.state !== "inactive") segmentRecorder.stop();
  };

  let stopping: Promise<RecordingResult> | null = null;

  return {
    activeSources: streams.activeSources,

    videoBytes: () => videoChunks.reduce((total, chunk) => total + chunk.size, 0),

    stop() {
      if (stopping) return stopping;
      finished = true;
      const recorder = videoRecorder;
      // MP4 は最後のデータが欠けるとほぼ再生できなくなる（実測: 6秒の録画が0.2秒分しか再生できなかった）。
      // 時間で見切りをつけると録画を壊すので、必ず stop イベントを待つ。
      const video = recorder
        ? whenStopped(recorder).then(() => ({
            blob: new Blob(videoChunks, { type: recorder.mimeType }),
            extension: videoExtension,
            errored: videoErrored,
          }))
        : Promise.resolve(null);
      const audio = whenStopped(audioRecorder).then(() => new Blob(audioChunks, { type: audioRecorder.mimeType }));
      stopSegments();
      stopping = Promise.all([audio, Promise.all(segments), video]).then(([audio, segments, video]) => {
        release();
        // 区切った直後に止めると、中身のない最後の1個ができることがある
        return { audio, segments: segments.filter((segment) => segment.size > 0), video };
      });
      return stopping;
    },

    cancel() {
      if (finished) return;
      finished = true;
      stopSegments();
      for (const recorder of [videoRecorder, audioRecorder]) {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      }
      audioChunks.length = 0;
      videoChunks.length = 0;
      release();
    },
  };
}

/**
 * エラーや音声の途切れでブラウザに止められた場合、既に inactive で stop イベントはもう来ないので
 * その場で解決する。
 */
function whenStopped(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve();
      return;
    }
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.stop();
  });
}
