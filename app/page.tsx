"use client";

import { useRef, useState, useEffect } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import { prepareAudioForWhisper, saveBlobLocally, timestampedFilename } from "@/lib/audio";

type Status = "idle" | "recording" | "processing" | "done" | "error";

// Whisper（whisper-1）のファイル上限。約30kbpsの録音で約118分に相当する。
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

const SOURCE_PREF_KEY = "claudio.audioSources";

interface Result {
  transcript: string;
  summary: string;
  notionUrl?: string;
  summaryFailed?: boolean;
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

  const lastRecordingRef = useRef<{ blob: Blob; filename: string } | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // 録音する音源の選択。両方ONならミックス、PC音声のみも選べる。
  const [useMic, setUseMic] = useState(true);
  const [useSystem, setUseSystem] = useState(true);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // 前回の選択を復元する。SSRとの不一致を避けるためマウント後に読む。
  useEffect(() => {
    const saved = localStorage.getItem(SOURCE_PREF_KEY);
    if (!saved) return;
    try {
      const { mic, system } = JSON.parse(saved) as { mic: boolean; system: boolean };
      // 両方オフだと録音できないので、その状態は復元しない
      if (typeof mic === "boolean" && typeof system === "boolean" && (mic || system)) {
        setUseMic(mic);
        setUseSystem(system);
      }
    } catch {
      // 壊れていたら既定値のまま
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SOURCE_PREF_KEY, JSON.stringify({ mic: useMic, system: useSystem }));
  }, [useMic, useSystem]);

  // 選択された音源だけを取得して、録音対象のストリームを組み立てる。
  // 単一音源のときは AudioContext を経由せず、そのまま MediaRecorder に渡す。
  const buildRecordStream = async (): Promise<MediaStream> => {
    if (useMic) {
      try {
        micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error("マイクへのアクセスが拒否されました。");
      }
    }

    if (useSystem) {
      let displayStream: MediaStream;
      try {
        // 音声のみの getDisplayMedia は多くのブラウザで通らないため video も要求し、
        // 取得後すぐビデオトラックを止める。
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      } catch {
        throw new Error("画面共有がキャンセルされました。PC内部音声を録音するには共有の許可が必要です。");
      }

      displayStream.getVideoTracks().forEach((t) => t.stop());

      if (displayStream.getAudioTracks().length === 0) {
        displayStream.getTracks().forEach((t) => t.stop());
        throw new Error(
          "音声が共有されていません。共有ダイアログで「タブの音声を共有」を有効にしてください。"
        );
      }

      displayStreamRef.current = displayStream;
    }

    const mic = micStreamRef.current;
    const sys = displayStreamRef.current;

    if (mic && sys) {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(mic).connect(dest);
      ctx.createMediaStreamSource(sys).connect(dest);
      return dest.stream;
    }

    return (mic ?? sys)!;
  };

  const startRecording = async () => {
    if (!useMic && !useSystem) return;

    try {
      const recordStream = await buildRecordStream();

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(recordStream, {
        mimeType,
        audioBitsPerSecond: 32000,
      });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(100);
      mediaRecorderRef.current = recorder;
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      setStatus("recording");
      setResult(null);
      setErrorMessage("");
      setBlobWarning("");
    } catch (err) {
      // 途中まで取得したストリームを残さない
      cleanupAudio();
      setErrorMessage(err instanceof Error ? err.message : "録音を開始できませんでした。");
      setStatus("error");
    }
  };

  // マイク・画面共有・AudioContext をまとめて解放する。
  // 音源が任意になったので、停止処理は必ずここに集約する。
  const cleanupAudio = () => {
    audioContextRef.current?.close();
    audioContextRef.current = null;
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      cleanupAudio();

      // 文字起こしが失敗しても録音そのものを失わないよう、先に手元へ保存する
      const filename = timestampedFilename("webm");
      lastRecordingRef.current = { blob, filename };
      saveBlobLocally(blob, filename);
      setSavedFilename(filename);

      await processAudio(blob, filename);
    };

    recorder.stop();
    setStatus("processing");
  };

  const cancelRecording = () => {
    if (!window.confirm("録音を破棄しますか？")) return;

    const recorder = mediaRecorderRef.current;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorder) {
      recorder.onstop = () => cleanupAudio();
      recorder.stop();
    }
    chunksRef.current = [];
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
    lastRecordingRef.current = null;
    setStatus("processing");
    await processAudio(file, file.name);
  };

  const copyToClipboard = async (text: string, key: "transcript" | "summary") => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  // 長さに関わらず必ずクラウドへ退避する。長い録音ほど失うと痛いので、
  // 分割経路に回る大きさでもバックアップだけは先に取っておく。
  // 失敗しても文字起こしは続行する（ローカル保存は済んでいる）。
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
      setBlobWarning(
        err instanceof Error ? err.message : "クラウドへの保存に失敗しました。"
      );
      return null;
    }
  };

  // 25MB（約106分）以下なら、Blobに置いたまま1回で文字起こしする。
  // 分割もWAV再エンコードもしないので、境界の欠落もメモリ肥大も起きない。
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

  // 25MB超のときだけ使う退避経路。16kHz WAVに変換して2分ずつ送る。
  const transcribeBySplitting = async (audioBlob: Blob, sourceName: string) => {
    setProgressLabel("音声を準備中…");
    const prepared = await prepareAudioForWhisper(audioBlob, sourceName);

    const texts: string[] = [];
    for (let i = 0; i < prepared.total; i++) {
      setProgressLabel(
        prepared.total > 1
          ? `文字起こし中… (${i + 1}/${prepared.total})`
          : "文字起こし中…"
      );

      // ここで初めてWAV化する。ループを抜ければ参照が切れて回収される。
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

      // Blobに置けた25MB以下の録音だけが単一呼び出しで通る。
      // 25MB超、またはアップロードに失敗した場合は分割経路で処理する。
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
    <main style={styles.main}>
      <h1 style={styles.title}>🎙️ Claudio</h1>
      <p style={styles.subtitle}>録音 → 文字起こし → 要約 → Notion保存</p>

      <div style={styles.inputArea}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="タイトル（省略可）"
          disabled={isRecording || isProcessing}
          style={styles.titleInput}
        />
      </div>

      {!isRecording && !isProcessing && (
        <div style={styles.sourceArea}>
          <span style={styles.sourceLabel}>録音する音声</span>
          <label style={styles.sourceOption}>
            <input
              type="checkbox"
              checked={useMic}
              onChange={(e) => setUseMic(e.target.checked)}
            />
            🎤 マイク
          </label>
          <label style={styles.sourceOption}>
            <input
              type="checkbox"
              checked={useSystem}
              onChange={(e) => setUseSystem(e.target.checked)}
            />
            🔊 PC内部音声
          </label>
        </div>
      )}

      <div style={styles.buttonArea}>
        {!isRecording && !isProcessing && (
          <>
            <button
              onClick={startRecording}
              disabled={!useMic && !useSystem}
              style={{
                ...styles.recordBtn,
                ...(!useMic && !useSystem ? styles.recordBtnDisabled : {}),
              }}
            >
              ● 録音開始
            </button>
            <label style={styles.uploadLabel}>
              ファイルを選択
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={handleFileUpload}
                style={{ display: "none" }}
              />
            </label>
          </>
        )}

        {isRecording && (
          <>
            <button onClick={stopRecording} style={styles.stopBtn}>
              ■ 録音停止
            </button>
            <button onClick={cancelRecording} style={styles.cancelBtn}>
              ✕ キャンセル
            </button>
          </>
        )}

        {isProcessing && (
          <div style={styles.processing}>
            <span style={styles.spinner} />
            {progressLabel}
          </div>
        )}
      </div>

      {isRecording && (
        <div>
          <p style={styles.recordingIndicator}>● 録音中　{formatTime(elapsed)}</p>
          <p style={styles.audioModeLabel}>
            {useMic && useSystem
              ? "🎧 マイク + PC内部音声"
              : useMic
                ? "🎤 マイクのみ"
                : "🔊 PC内部音声のみ"}
          </p>
        </div>
      )}

      {status === "idle" && (
        <p style={styles.hint}>
          {useSystem
            ? "録音開始後、ブラウザの共有ダイアログでタブまたは画面を選択し、必ず「タブの音声を共有」を有効にしてください。"
            : "マイクのみで録音します。PC内部音声も録りたい場合は上のチェックを入れてください。"}
        </p>
      )}

      {blobWarning && (
        <p style={styles.blobWarning}>
          ⚠️ クラウド保存に失敗しました（{blobWarning}）。録音は手元のファイルに残っています。
        </p>
      )}

      {savedFilename && (
        <p style={styles.savedNote}>
          💾 録音ファイルを <code>{savedFilename}</code> として保存しました。
        </p>
      )}

      {status === "error" && (
        <div style={styles.errorBox}>
          <strong>エラー:</strong> {errorMessage}
          {lastRecordingRef.current && (
            <div style={{ marginTop: 12 }}>
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                録音データは残っています。保存し直してから、あとで「ファイルを選択」でやり直せます。
              </p>
              <button
                onClick={() =>
                  lastRecordingRef.current &&
                  saveBlobLocally(lastRecordingRef.current.blob, lastRecordingRef.current.filename)
                }
                style={styles.copyBtn}
              >
                録音ファイルを保存
              </button>
            </div>
          )}
        </div>
      )}

      {result && (
        <div style={styles.resultArea}>
          <section style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>📝 文字起こし</h2>
              <button
                onClick={() => copyToClipboard(result.transcript, "transcript")}
                style={styles.copyBtn}
              >
                {copied === "transcript" ? "✓ コピー済み" : "コピー"}
              </button>
            </div>
            <p style={styles.text}>{result.transcript}</p>
          </section>

          {result.summaryFailed && (
            <div style={styles.warnBox}>
              ⚠️ 要約の生成に失敗しました。文字起こしのみNotionに保存されています。
            </div>
          )}

          {!result.summaryFailed && (
          <section style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>✨ 要約</h2>
              <button
                onClick={() => copyToClipboard(result.summary, "summary")}
                style={styles.copyBtn}
              >
                {copied === "summary" ? "✓ コピー済み" : "コピー"}
              </button>
            </div>
            <div style={styles.text}>
              {result.summary.split("\n").map((line, i) => (
                <p key={i} style={{ margin: "4px 0" }}>
                  {line}
                </p>
              ))}
            </div>
          </section>
          )}

          {result.notionUrl && (
            <p style={styles.notionLink}>
              <a href={result.notionUrl} target="_blank" rel="noopener noreferrer">
                Notionで確認 →
              </a>
            </p>
          )}
        </div>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 700,
    margin: "0 auto",
    padding: "40px 24px",
    fontFamily: "'Hiragino Sans', 'Helvetica Neue', sans-serif",
    color: "#1a1a1a",
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    margin: 0,
  },
  subtitle: {
    color: "#666",
    margin: "8px 0 32px",
    fontSize: 15,
  },
  inputArea: {
    marginBottom: 12,
  },
  titleInput: {
    width: "100%",
    padding: "10px 14px",
    fontSize: 15,
    border: "1px solid #cbd5e0",
    borderRadius: 8,
    outline: "none",
    color: "#1a1a1a",
    background: "#fff",
  },
  buttonArea: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 16,
  },
  recordBtn: {
    background: "#e53e3e",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "14px 32px",
    fontSize: 17,
    fontWeight: 600,
    cursor: "pointer",
  },
  stopBtn: {
    background: "#2d3748",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "14px 32px",
    fontSize: 17,
    fontWeight: 600,
    cursor: "pointer",
  },
  processing: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 15,
    color: "#666",
  },
  spinner: {
    display: "inline-block",
    width: 18,
    height: 18,
    border: "3px solid #ddd",
    borderTopColor: "#555",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  recordingIndicator: {
    color: "#e53e3e",
    fontWeight: 600,
    fontSize: 14,
    margin: "4px 0 0",
    animation: "pulse 1.2s ease-in-out infinite",
  },
  warnBox: {
    background: "#fffbeb",
    border: "1px solid #fcd34d",
    borderRadius: 8,
    padding: "12px 16px",
    color: "#92400e",
    fontSize: 14,
  },
  errorBox: {
    background: "#fff5f5",
    border: "1px solid #fed7d7",
    borderRadius: 8,
    padding: "12px 16px",
    color: "#c53030",
    marginTop: 16,
  },
  resultArea: {
    marginTop: 32,
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  section: {
    background: "#f7fafc",
    borderRadius: 10,
    padding: "20px 24px",
    borderLeft: "4px solid #4a90d9",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 700,
    margin: 0,
    color: "#2d3748",
  },
  copyBtn: {
    background: "transparent",
    border: "1px solid #cbd5e0",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 13,
    color: "#555",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  cancelBtn: {
    background: "transparent",
    color: "#718096",
    border: "1px solid #cbd5e0",
    borderRadius: 8,
    padding: "14px 24px",
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
  },
  uploadLabel: {
    background: "#fff",
    color: "#2d3748",
    border: "1px solid #cbd5e0",
    borderRadius: 8,
    padding: "14px 24px",
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
  },
  text: {
    fontSize: 15,
    lineHeight: 1.7,
    margin: 0,
    color: "#333",
    whiteSpace: "pre-wrap",
  },
  notionLink: {
    textAlign: "right",
    margin: 0,
  },
  sourceArea: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 16,
    margin: "0 0 16px",
  },
  sourceLabel: {
    fontSize: 13,
    color: "#718096",
  },
  sourceOption: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 14,
    color: "#2d3748",
    cursor: "pointer",
    userSelect: "none",
  },
  recordBtnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  audioModeLabel: {
    fontSize: 13,
    color: "#4a5568",
    margin: "2px 0 0",
  },
  hint: {
    fontSize: 13,
    color: "#888",
    margin: "8px 0 0",
    lineHeight: 1.6,
  },
  blobWarning: {
    fontSize: 13,
    color: "#975a16",
    background: "#fffff0",
    border: "1px solid #faf089",
    borderRadius: 8,
    padding: "10px 14px",
    margin: "12px 0 0",
    lineHeight: 1.6,
  },
  savedNote: {
    fontSize: 13,
    color: "#2f855a",
    background: "#f0fff4",
    border: "1px solid #c6f6d5",
    borderRadius: 8,
    padding: "10px 14px",
    margin: "12px 0 0",
  },
};
