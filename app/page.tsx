"use client";

import { useRef, useState, useEffect } from "react";

type Status = "idle" | "recording" | "processing" | "done" | "error";

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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, {
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
    } catch {
      setErrorMessage("マイクへのアクセスが拒否されました。");
      setStatus("error");
    }
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
      recorder.stream.getTracks().forEach((t) => t.stop());
      await processAudio(blob);
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
      recorder.onstop = () => {
        recorder.stream.getTracks().forEach((t) => t.stop());
      };
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
    setStatus("processing");
    await processAudio(file);
  };

  const copyToClipboard = async (text: string, key: "transcript" | "summary") => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const processAudio = async (audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.webm");
      formData.append("title", title);

      const res = await fetch("/api/voice-memo", {
        method: "POST",
        body: formData,
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

      <div style={styles.buttonArea}>
        {!isRecording && !isProcessing && (
          <>
            <button onClick={startRecording} style={styles.recordBtn}>
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
            処理中…
          </div>
        )}
      </div>

      {isRecording && (
        <p style={styles.recordingIndicator}>● 録音中　{formatTime(elapsed)}</p>
      )}

      {status === "error" && (
        <div style={styles.errorBox}>
          <strong>エラー:</strong> {errorMessage}
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
};
