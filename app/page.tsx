"use client";

import { useRef, useState, useEffect } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import { prepareAudioForWhisper, saveBlobLocally, timestampedFilename } from "@/lib/audio";

type Status = "idle" | "recording" | "processing" | "done" | "error";

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

  const [useMic, setUseMic] = useState(true);
  const [useSystem, setUseSystem] = useState(true);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(SOURCE_PREF_KEY);
    if (!saved) return;
    try {
      const { mic, system } = JSON.parse(saved) as { mic: boolean; system: boolean };
      if (typeof mic === "boolean" && typeof system === "boolean" && (mic || system)) {
        setUseMic(mic);
        setUseSystem(system);
      }
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(SOURCE_PREF_KEY, JSON.stringify({ mic: useMic, system: useSystem }));
  }, [useMic, useSystem]);

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
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch {
        throw new Error("画面共有がキャンセルされました。PC内部音声を録音するには共有の許可が必要です。");
      }
      displayStream.getVideoTracks().forEach((t) => t.stop());
      if (displayStream.getAudioTracks().length === 0) {
        displayStream.getTracks().forEach((t) => t.stop());
        throw new Error("音声が共有されていません。共有ダイアログで「タブの音声を共有」を有効にしてください。");
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
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(recordStream, { mimeType, audioBitsPerSecond: 32000 });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start(100);
      mediaRecorderRef.current = recorder;
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      setStatus("recording");
      setResult(null);
      setErrorMessage("");
      setBlobWarning("");
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

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      cleanupAudio();
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
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (recorder) { recorder.onstop = () => cleanupAudio(); recorder.stop(); }
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

          <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 20, flexWrap: "wrap" }}>
            <span className="text-muted" style={{ fontSize: 13 }}>録音する音声</span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={useMic} onChange={(e) => setUseMic(e.target.checked)} style={{ accentColor: "var(--color-accent)", width: 15, height: 15 }} />
              🎤 マイク
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={useSystem} onChange={(e) => setUseSystem(e.target.checked)} style={{ accentColor: "var(--color-accent)", width: 15, height: 15 }} />
              🔊 PC内部音声
            </label>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button onClick={startRecording} disabled={!useMic && !useSystem} className="btn btn-primary" style={{ padding: "14px 30px", fontSize: 15 }}>
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
            {useSystem
              ? "録音開始後、ブラウザの共有ダイアログでタブまたは画面を選択し、必ず「タブの音声を共有」を有効にしてください。"
              : "マイクのみで録音します。PC内部音声も録りたい場合は上のチェックを入れてください。"}
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
            <p className="tag tag-accent-2" style={{ marginBottom: 20 }}>
              {useMic && useSystem ? "🎧 マイク + PC内部音声" : useMic ? "🎤 マイクのみ" : "🔊 PC内部音声のみ"}
            </p>
            <div style={{ display: "flex", gap: 14 }}>
              <button onClick={stopRecording} className="btn" style={{ padding: "12px 28px", fontSize: 15, background: "var(--color-neutral-800)", color: "var(--color-neutral-100)" }}>
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
    </main>
  );
}
