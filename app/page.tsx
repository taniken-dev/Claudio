"use client";

import { useRef, useState, useEffect } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import { convertToMp3, prepareAudioForWhisper, saveBlobLocally, timestampedFilename } from "@/lib/audio";
import { VIDEO_CONSTRAINTS, pickVideoFormat, videoRecorderOptions } from "@/lib/video";

type Status = "idle" | "recording" | "processing" | "done" | "error";

const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const SOURCE_PREF_KEY = "claudio.audioSources";

interface Sources {
  mic: boolean;
  system: boolean;
  screen: boolean;
}

interface Result {
  transcript: string;
  summary: string;
  notionUrl?: string;
  summaryFailed?: boolean;
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState<"transcript" | "summary" | null>(null);
  const [progressLabel, setProgressLabel] = useState("処理中…");
  const [savedFilename, setSavedFilename] = useState<string>("");
  const [blobWarning, setBlobWarning] = useState<string>("");
  const [mp3Notice, setMp3Notice] = useState<string>("");
  const [videoNotice, setVideoNotice] = useState<string>("");
  const [showSourceDialog, setShowSourceDialog] = useState(false);
  const [videoBytes, setVideoBytes] = useState(0);
  // 録音中に起きた異常（マイク切断・録画の停止）。止めずに続けられるものはここで知らせる
  const [recordingWarning, setRecordingWarning] = useState<string>("");
  // ユーザーの操作以外で録音が終わったときの理由
  const [stopNotice, setStopNotice] = useState<string>("");

  const lastRecordingRef = useRef<{ blob: Blob; filename: string } | null>(null);
  // 音声と動画を続けて保存するとブラウザが2つ目のダウンロードを止めることがあるため、
  // 取りこぼしたときに押し直せるよう録画を保持しておく（次の録音開始で解放する）。
  const lastVideoRef = useRef<{ blob: Blob; filename: string } | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const videoRecorderRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<Blob[]>([]);
  const videoExtensionRef = useRef<"mp4" | "webm">("mp4");
  const videoErroredRef = useRef(false);
  // 共有停止や音声の途切れなど、ボタン以外のきっかけで録音を畳むため、関数の最新版を保持する
  const stopRecordingRef = useRef<(reason?: string) => void>(() => {});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const [sources, setSources] = useState<Sources>({ mic: true, system: true, screen: false });
  // チェックボックスは希望であって保証ではない（共有ダイアログで音声を切られることがある）。
  // 録音中の表示には、実際に取れたトラックから確定したこちらを使う。
  const [activeSources, setActiveSources] = useState<Sources>({ mic: false, system: false, screen: false });

  const hasAudioSource = sources.mic || sources.system;
  const toggleSource = (key: keyof Sources) => setSources((prev) => ({ ...prev, [key]: !prev[key] }));

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(SOURCE_PREF_KEY);
    if (!saved) return;
    try {
      const { mic, system, screen } = JSON.parse(saved) as Partial<Sources>;
      // 音声が両方falseの設定は保存されない想定だが、壊れた値を読んでも開始できなくならないようにする
      if (typeof mic === "boolean" && typeof system === "boolean" && (mic || system)) {
        setSources({ mic, system, screen: screen === true });
      }
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(SOURCE_PREF_KEY, JSON.stringify(sources));
  }, [sources]);

  // 録音・録画はすべてタブのメモリ上にあるので、保存前にページを離れると跡形もなく消える
  useEffect(() => {
    if (status !== "recording" && status !== "processing") return;
    const warnUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // ログアウトは再読み込みを伴わない画面遷移なので beforeunload では止まらない。
    // React がフォームを処理するより先に捕まえる必要があるため、window の捕捉段階で受ける。
    const guardSubmit = (e: SubmitEvent) => {
      if (window.confirm("録音中・処理中にページを離れると、録音が失われることがあります。続けますか？")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("beforeunload", warnUnload);
    window.addEventListener("submit", guardSubmit, true);
    return () => {
      window.removeEventListener("beforeunload", warnUnload);
      window.removeEventListener("submit", guardSubmit, true);
    };
  }, [status]);

  /**
   * 文字起こし用の音声と、画面録画用の映像+音声を組み立てる。
   * PC内部音声と画面録画はどちらも getDisplayMedia 由来なので、共有ダイアログが
   * 二度出ないよう1回の呼び出しでまかない、取れたトラックを用途別に振り分ける。
   */
  const buildStreams = async (): Promise<{ audio: MediaStream; video: MediaStream | null }> => {
    let videoTrack: MediaStreamTrack | null = null;

    // getDisplayMedia は「ユーザー操作の直後」でないとブラウザに弾かれ、この操作は数秒で失効する。
    // マイク許可のダイアログで迷われると間に合わなくなるため、操作を必要としない
    // getUserMedia より先に必ずこちらを呼ぶ。
    if (sources.system || sources.screen) {
      let displayStream: MediaStream;
      try {
        // 音声だけを要求する指定はできないので、内部音声のみのときも映像を取って後で捨てる。
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: sources.screen ? VIDEO_CONSTRAINTS : true,
          audio: sources.system,
        });
      } catch {
        throw new Error("画面の共有がキャンセルされました。PC内部音声や画面録画には共有の許可が必要です。");
      }
      // 失敗して抜ける場合もトラックを止められるよう、検査より先に控えておく
      displayStreamRef.current = displayStream;

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
        micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error("マイクへのアクセスが拒否されました。");
      }
    }

    const systemAudio = displayStreamRef.current?.getAudioTracks().length ? displayStreamRef.current : null;
    const audioStreams = [micStreamRef.current, systemAudio].filter((s): s is MediaStream => s !== null);
    if (audioStreams.length === 0) {
      throw new Error("録音する音声がありません。マイクかPC内部音声のどちらかを選んでください。");
    }

    setActiveSources({
      mic: micStreamRef.current !== null,
      system: systemAudio !== null,
      screen: videoTrack !== null,
    });

    // 音声を混ぜている場合、マイクが途切れても録音は止まらず無音のまま続く。
    // Bluetooth マイクの電池切れなどに気づけるよう知らせる（自分で stop() した場合は発火しない）。
    micStreamRef.current?.getAudioTracks()[0]?.addEventListener(
      "ended",
      () => setRecordingWarning("🎤 マイクの入力が途切れました。録音は続いていますが、マイクの音は入っていません。"),
      { once: true },
    );

    // 音源が1つで画面録画もしないなら、余計な処理を挟まず元のストリームをそのまま使う
    if (audioStreams.length === 1 && !videoTrack) {
      return { audio: audioStreams[0], video: null };
    }

    const ctx = new AudioContext();
    audioContextRef.current = ctx;
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
    };
  };

  const startRecording = async () => {
    if (!hasAudioSource) return;
    // ここから getDisplayMedia までの間に await を挟むと、クリックの操作扱いが失効して弾かれる
    setShowSourceDialog(false);
    try {
      const streams = await buildStreams();

      const audioMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const audioRecorder = new MediaRecorder(streams.audio, { mimeType: audioMimeType, audioBitsPerSecond: 32000 });
      chunksRef.current = [];
      audioRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };

      videoRecorderRef.current = null;
      videoChunksRef.current = [];
      lastVideoRef.current = null;
      if (streams.video) {
        const format = pickVideoFormat();
        videoExtensionRef.current = format.extension;
        const videoRecorder = new MediaRecorder(streams.video, videoRecorderOptions(format));
        videoRecorder.ondataavailable = (e) => { if (e.data.size > 0) videoChunksRef.current.push(e.data); };
        videoErroredRef.current = false;
        // エラーが起きると録画はそこで止まるが、それまでのデータは残るので捨てずに停止時に保存する
        videoRecorder.addEventListener("error", (e) => {
          console.error("画面録画のエラー:", e);
          videoErroredRef.current = true;
          setRecordingWarning("⚠️ 画面録画が止まりました。止まるまでの録画は停止時に保存します（音声の録音は続いています）。");
        }, { once: true });
        // 1時間で数百MBになるため、音声より粗い間隔で受け取って配列の要素数を抑える
        videoRecorder.start(1000);
        videoRecorderRef.current = videoRecorder;

        // ブラウザの「共有を停止」バーで止められたら、録れたところまでで正常に畳む
        streams.video.getVideoTracks()[0]?.addEventListener(
          "ended",
          () => stopRecordingRef.current("画面共有が停止されたため、録画を終了しました。"),
          { once: true },
        );
      }

      // 生のストリームを録っている場合、トラックが切れるとブラウザが録音を勝手に止める。
      // 停止処理をボタンにしか紐づけていないと、録音中の表示のまま固まりデータも保存されない。
      audioRecorder.addEventListener(
        "stop",
        () => stopRecordingRef.current("音声の入力が途切れたため、録音を終了しました。"),
        { once: true },
      );
      audioRecorder.start(100);
      audioRecorderRef.current = audioRecorder;
      setElapsed(0);
      setVideoBytes(0);
      timerRef.current = setInterval(() => {
        setElapsed((s) => s + 1);
        // 画面録画は1時間で数百MBに達する。タブのメモリに載り続けるので、
        // 手遅れになる前に気づけるよう現在のサイズを出しておく。
        if (videoRecorderRef.current) {
          setVideoBytes(videoChunksRef.current.reduce((total, chunk) => total + chunk.size, 0));
        }
      }, 1000);
      setStatus("recording");
      setResult(null);
      setErrorMessage("");
      setBlobWarning("");
      setMp3Notice("");
      setVideoNotice("");
      setSavedFilename("");
      setRecordingWarning("");
      setStopNotice("");
    } catch (err) {
      cleanupAudio();
      setErrorMessage(err instanceof Error ? err.message : "録音を開始できませんでした。");
      setStatus("error");
    }
  };

  const cleanupAudio = () => {
    audioContextRef.current?.close();
    audioContextRef.current = null;
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
  };

  const stopRecording = (reason?: string) => {
    // ボタンで止めた後にも録音の stop イベントからここへ来るので、2回目は何もしない
    const audioRecorder = audioRecorderRef.current;
    if (!audioRecorder) return;
    audioRecorderRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (reason) setStopNotice(reason);

    const videoRecorder = videoRecorderRef.current;
    videoRecorderRef.current = null;
    // MP4 は最後のデータが欠けるとほぼ再生できなくなる（実測: 6秒の録画が0.2秒分しか再生できなかった）。
    // 時間で見切りをつけると録画を壊すので、必ず stop イベントを待つ。エラーで止まった場合も
    // stop イベントは届き、既に止まっているならそのまま組み立てる。
    const videoBlob = videoRecorder
      ? new Promise<Blob>((resolve) => {
          const assemble = () => resolve(new Blob(videoChunksRef.current, { type: videoRecorder.mimeType }));
          if (videoRecorder.state === "inactive") {
            assemble();
            return;
          }
          videoRecorder.addEventListener("stop", assemble, { once: true });
          videoRecorder.stop();
        })
      : null;

    const finalize = async () => {
      const blob = new Blob(chunksRef.current, { type: audioRecorder.mimeType });
      const filename = timestampedFilename("webm");
      lastRecordingRef.current = { blob, filename };

      // ネットワークを使う処理より先に、録れたものを手元へ落とす。
      // 文字起こしや Notion 保存が失敗しても記録そのものは失われない。
      let hasVideo = false;
      if (videoBlob) {
        try {
          const video = await videoBlob;
          if (video.size === 0) throw new Error("画面録画のデータが空です。");
          const videoFilename = timestampedFilename(videoExtensionRef.current);
          lastVideoRef.current = { blob: video, filename: videoFilename };
          saveBlobLocally(video, videoFilename);
          setVideoNotice(
            videoErroredRef.current
              ? `🎬 画面録画を ${videoFilename} として保存しました（${formatSize(video.size)}）。途中で止まったため、止まった時点までの録画です。`
              : `🎬 画面録画を ${videoFilename} として保存しました（${formatSize(video.size)}）`,
          );
          hasVideo = true;
        } catch (err) {
          console.error("画面録画の保存に失敗:", err);
          setVideoNotice("⚠️ 画面録画の保存に失敗しました。音声は別に保存します。");
        } finally {
          videoChunksRef.current = [];
        }
      }

      // 2つのファイルを続けて落とすとブラウザが「複数ファイルのダウンロード」を警告し、
      // 2つ目が黙って止まることがある。録画を保存できたときは同じ音声がより高いビットレートで
      // 動画に入っているので、webm は自動では落とさず手動ボタンから取り出せるようにする。
      if (!hasVideo) {
        saveBlobLocally(blob, filename);
        setSavedFilename(filename);
      }

      cleanupAudio();
      await processAudio(blob, filename);
      // 変換はデコードで数百MBのメモリを使う。文字起こしと同時に走らせてタブが落ちないよう、
      // Notion 保存まで終わってから行う（webm は上で保存済みなので、変換に失敗しても録音は残る）。
      // 画面録画がある場合は同じ音声が動画に入っているので、メモリを使ってまで作らない。
      if (!hasVideo) await saveAsMp3(blob, filename);
    };

    // 音声が途切れてブラウザに止められた場合は、既に止まっていて stop イベントはもう来ない
    if (audioRecorder.state === "inactive") {
      void finalize();
    } else {
      audioRecorder.addEventListener("stop", () => void finalize(), { once: true });
      audioRecorder.stop();
    }
    setRecordingWarning("");
    setStatus("processing");
  };

  // ボタン以外のきっかけ（共有停止・音声の途切れ）から呼べるよう、最新の stopRecording を保持する
  useEffect(() => { stopRecordingRef.current = stopRecording; });

  const cancelRecording = () => {
    if (!window.confirm("録音を破棄しますか？")) return;
    const audioRecorder = audioRecorderRef.current;
    const videoRecorder = videoRecorderRef.current;
    audioRecorderRef.current = null;
    videoRecorderRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (videoRecorder) { videoRecorder.onstop = null; videoRecorder.stop(); }
    if (audioRecorder) { audioRecorder.onstop = () => cleanupAudio(); audioRecorder.stop(); }
    else cleanupAudio();
    chunksRef.current = [];
    videoChunksRef.current = [];
    setRecordingWarning("");
    setStatus("idle");
    setElapsed(0);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setResult(null);
    setErrorMessage("");
    setSavedFilename("");
    setBlobWarning("");
    setMp3Notice("");
    setVideoNotice("");
    lastRecordingRef.current = null;
    setStatus("processing");
    await processAudio(file, file.name);
  };

  const copyToClipboard = async (text: string, key: "transcript" | "summary") => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const saveAsMp3 = async (audioBlob: Blob, webmName: string) => {
    const mp3Name = webmName.replace(/\.webm$/, ".mp3");
    try {
      setMp3Notice("🎵 MP3に変換中…");
      const mp3 = await convertToMp3(audioBlob, (ratio) => setMp3Notice(`🎵 MP3に変換中… ${Math.round(ratio * 100)}%`));
      saveBlobLocally(mp3, mp3Name);
      setMp3Notice(`💾 MP3を ${mp3Name} として保存しました`);
    } catch (err) {
      console.error("MP3への変換に失敗:", err);
      setMp3Notice(`⚠️ MP3への変換に失敗しました。録音は ${webmName} として保存済みです。`);
    }
  };

  const backupToBlob = async (audioBlob: Blob, sourceName: string) => {
    try {
      setProgressLabel("録音をアップロード中…");
      const uploaded = await uploadPresigned(sourceName, audioBlob, {
        access: "private",
        contentType: audioBlob.type || "audio/webm",
        handleUploadUrl: "/api/blob-upload",
      });
      return uploaded.url;
    } catch (err) {
      console.error("Blobへの保存に失敗:", err);
      setBlobWarning(err instanceof Error ? err.message : "クラウドへの保存に失敗しました。");
      return null;
    }
  };

  const transcribeFromBlob = async (blobUrl: string, sourceName: string) => {
    setProgressLabel("文字起こし中…");
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobUrl, filename: sourceName }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTPエラー: ${res.status}`);
    }
    const data: { text: string } = await res.json();
    return data.text.trim();
  };

  const transcribeBySplitting = async (audioBlob: Blob, sourceName: string) => {
    setProgressLabel("音声を準備中…");
    const prepared = await prepareAudioForWhisper(audioBlob, sourceName);
    const texts: string[] = [];
    for (let i = 0; i < prepared.total; i++) {
      setProgressLabel(prepared.total > 1 ? `文字起こし中… (${i + 1}/${prepared.total})` : "文字起こし中…");
      const part = prepared.get(i);
      const formData = new FormData();
      formData.append("audio", part.blob, part.filename);
      formData.append("filename", part.filename);
      const res = await fetch("/api/transcribe", { method: "POST", body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTPエラー: ${res.status}`);
      }
      const data: { text: string } = await res.json();
      texts.push(data.text);
    }
    return texts.filter((t) => t).join("\n").trim();
  };

  const processAudio = async (audioBlob: Blob, sourceName: string) => {
    try {
      const blobUrl = await backupToBlob(audioBlob, sourceName);
      const transcript =
        blobUrl && audioBlob.size <= WHISPER_MAX_BYTES
          ? await transcribeFromBlob(blobUrl, sourceName)
          : await transcribeBySplitting(audioBlob, sourceName);

      setProgressLabel("要約してNotionに保存中…");
      const res = await fetch("/api/voice-memo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, title }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTPエラー: ${res.status}`);
      }
      const data: Result = await res.json();
      setResult(data);
      setStatus("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "不明なエラー");
      setStatus("error");
    }
  };

  const isRecording = status === "recording";
  const isProcessing = status === "processing";

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 28px 80px" }}>
      <h1 style={{ fontSize: 44, margin: "0 0 8px" }}>Claudio</h1>
      <p className="text-muted" style={{ fontSize: 16, margin: "0 0 40px", maxWidth: "44ch" }}>録音 → 文字起こし → 要約 → Notionへ自動保存。</p>

      {!isRecording && !isProcessing && (
        <>
          <div className="field" style={{ maxWidth: 420, marginBottom: 20 }}>
            <label>タイトル（省略可）</label>
            <input
              type="text"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：週次ミーティング"
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button onClick={() => setShowSourceDialog(true)} className="btn btn-primary" style={{ padding: "14px 30px", fontSize: 15 }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>
              録音開始
            </button>
            <label className="btn btn-secondary" style={{ padding: "14px 24px", fontSize: 15, cursor: "pointer" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" x2="12" y1="3" y2="15"></line></svg>
              ファイルを選択
              <input ref={fileInputRef} type="file" accept="audio/*,video/webm,video/mp4,video/ogg,.webm,.m4a" onChange={handleFileUpload} style={{ display: "none" }} />
            </label>
          </div>

          <p className="text-muted" style={{ fontSize: 13, margin: "24px 0 0", lineHeight: 1.7, maxWidth: "52ch" }}>
            録音開始を押すと、録音する内容を選ぶ画面が表示されます。
          </p>
        </>
      )}

      {isRecording && (
        <div style={{ display: "flex", alignItems: "center", gap: 48, padding: "24px 0" }}>
          <div style={{ position: "relative", width: 120, height: 120, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--color-accent-200)", animation: "pulse-ring 1.8s ease-out infinite" }}></span>
            <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--color-accent-200)", animation: "pulse-ring 1.8s ease-out infinite", animationDelay: "0.6s" }}></span>
            <span style={{ position: "relative", width: 76, height: 76, borderRadius: "50%", background: "var(--color-accent)", color: "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>
            </span>
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-heading)", fontSize: 20, margin: "0 0 4px", color: "var(--color-accent-700)" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--color-accent-700)", display: "inline-block", animation: "blink 1.2s ease-in-out infinite" }}></span>
              録音中　{formatTime(elapsed)}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
              {activeSources.mic && <span className="tag tag-accent-2">🎤 マイク</span>}
              {activeSources.system && <span className="tag tag-accent-2">🔊 PC内部音声</span>}
              {activeSources.screen && (
                <span className="tag tag-accent">🖥️ 画面録画 720p{videoBytes > 0 && ` · ${formatSize(videoBytes)}`}</span>
              )}
            </div>
            {recordingWarning && (
              <p className="tag tag-accent" style={{ margin: "-8px 0 16px" }}>{recordingWarning}</p>
            )}
            <div style={{ display: "flex", gap: 14 }}>
              <button onClick={() => stopRecording()} className="btn" style={{ padding: "12px 28px", fontSize: 15, background: "var(--color-neutral-800)", color: "var(--color-neutral-100)" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>
                録音停止
              </button>
              <button onClick={cancelRecording} className="btn btn-ghost">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {isProcessing && (
        <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "24px 0" }}>
          <span style={{ width: 26, height: 26, border: "3px solid var(--color-neutral-400)", borderTopColor: "var(--color-accent)", borderRadius: "50%", display: "inline-block", animation: "spin 0.8s linear infinite", flex: "none" }}></span>
          <p style={{ fontSize: 17, margin: 0, fontFamily: "var(--font-heading)" }}>{progressLabel}</p>
        </div>
      )}

      {blobWarning && (
        <div className="card elev-sm" style={{ marginTop: 16, background: "var(--color-accent-100)", border: "1px solid var(--color-accent-300)" }}>
          <span style={{ fontFamily: "var(--font-heading)", color: "var(--color-accent-800)", fontSize: 14 }}>⚠️ クラウド保存に失敗しました（{blobWarning}）。録音は手元のファイルに残っています。</span>
        </div>
      )}

      {savedFilename && (
        <p className="tag tag-accent-2" style={{ marginTop: 16 }}>💾 録音ファイルを {savedFilename} として保存しました</p>
      )}

      {stopNotice && (
        <p className="tag tag-accent" style={{ marginTop: 16 }}>ℹ️ {stopNotice}</p>
      )}

      {videoNotice && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <span className="tag tag-accent-2">{videoNotice}</span>
          {lastVideoRef.current && (
            <button
              onClick={() => lastVideoRef.current && saveBlobLocally(lastVideoRef.current.blob, lastVideoRef.current.filename)}
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
            >
              録画を保存し直す
            </button>
          )}
          {lastRecordingRef.current && (
            <button
              onClick={() => lastRecordingRef.current && saveBlobLocally(lastRecordingRef.current.blob, lastRecordingRef.current.filename)}
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
            >
              音声だけを保存
            </button>
          )}
        </div>
      )}

      {mp3Notice && (
        <p className="tag tag-accent-2" style={{ marginTop: 8 }}>{mp3Notice}</p>
      )}

      {status === "error" && (
        <div className="card elev-sm" style={{ marginTop: 16, padding: "22px 26px", background: "var(--color-accent-100)", border: "1px solid var(--color-accent-300)" }}>
          <p style={{ margin: "0 0 10px", fontFamily: "var(--font-heading)", color: "var(--color-accent-800)" }}><strong>エラー：</strong>{errorMessage}</p>
          {lastRecordingRef.current && (
            <div>
              <p className="text-muted" style={{ fontSize: 13, margin: "0 0 12px" }}>録音データは残っています。保存し直してから、あとで「ファイルを選択」でやり直せます。</p>
              <button
                onClick={() => lastRecordingRef.current && saveBlobLocally(lastRecordingRef.current.blob, lastRecordingRef.current.filename)}
                className="btn btn-secondary"
                style={{ fontSize: 13, padding: "8px 16px" }}
              >
                録音ファイルを保存
              </button>
            </div>
          )}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="card elev-sm" style={{ padding: "26px 28px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <p className="card-kicker" style={{ margin: 0 }}>📝 文字起こし</p>
              <button onClick={() => copyToClipboard(result.transcript, "transcript")} className="btn btn-ghost" style={{ fontSize: 13 }}>
                {copied === "transcript" ? "✓ コピー済み" : "コピー"}
              </button>
            </div>
            <p style={{ fontSize: 15, lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap" }}>{result.transcript}</p>
          </section>

          {result.summaryFailed && (
            <div className="card elev-sm" style={{ background: "var(--color-accent-100)", border: "1px solid var(--color-accent-300)" }}>
              <span style={{ fontFamily: "var(--font-heading)", color: "var(--color-accent-800)", fontSize: 14 }}>⚠️ 要約の生成に失敗しました。文字起こしのみNotionに保存されています。</span>
            </div>
          )}

          {!result.summaryFailed && (
            <section className="card elev-sm" style={{ padding: "26px 28px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <p className="card-kicker" style={{ margin: 0 }}>✨ 要約</p>
                <button onClick={() => copyToClipboard(result.summary, "summary")} className="btn btn-ghost" style={{ fontSize: 13 }}>
                  {copied === "summary" ? "✓ コピー済み" : "コピー"}
                </button>
              </div>
              <div style={{ fontSize: 15, lineHeight: 1.75 }}>
                {result.summary.split("\n").map((line, i) => (
                  <p key={i} style={{ margin: "4px 0" }}>{line}</p>
                ))}
              </div>
            </section>
          )}

          {result.notionUrl && (
            <div style={{ textAlign: "right" }}>
              <a href={result.notionUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
                Notionで確認 →
              </a>
            </div>
          )}
        </div>
      )}

      {showSourceDialog && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => { if (e.target === e.currentTarget) setShowSourceDialog(false); }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="source-dialog-title">
            <h2 id="source-dialog-title">録音する内容</h2>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label className="modal-option">
                <input type="checkbox" checked={sources.mic} onChange={() => toggleSource("mic")} />
                <span>
                  <span className="modal-option-title">🎤 マイク</span>
                  <span className="modal-option-note">自分の声を録音します</span>
                </span>
              </label>

              <label className="modal-option">
                <input type="checkbox" checked={sources.system} onChange={() => toggleSource("system")} />
                <span>
                  <span className="modal-option-title">🔊 PC内部音声</span>
                  <span className="modal-option-note">相手の声やスピーカーの音を録音します</span>
                </span>
              </label>

              <label className="modal-option">
                <input type="checkbox" checked={sources.screen} onChange={() => toggleSource("screen")} />
                <span>
                  <span className="modal-option-title">🖥️ 画面録画</span>
                  <span className="modal-option-note">720pのMP4として手元に保存します（1時間で約450MB）</span>
                </span>
              </label>
            </div>

            {!hasAudioSource && (
              <p className="tag tag-accent" style={{ marginTop: 14 }}>
                マイクかPC内部音声のどちらかを選んでください（文字起こしに必要です）
              </p>
            )}

            {hasAudioSource && (sources.system || sources.screen) && (
              <p className="text-muted" style={{ fontSize: 12.5, lineHeight: 1.7, margin: "14px 0 0" }}>
                ℹ️ 次にブラウザの共有画面が出ます。共有するタブまたは画面を選んでください。
                {sources.system && "PC内部音声には「タブの音声も共有する」を必ず有効にしてください。"}
              </p>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24 }}>
              <button onClick={() => setShowSourceDialog(false)} className="btn btn-secondary">キャンセル</button>
              <button onClick={startRecording} disabled={!hasAudioSource} className="btn btn-primary" style={{ padding: "11px 26px" }}>
                開始
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
