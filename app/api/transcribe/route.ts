import { NextRequest, NextResponse } from "next/server";
import { get } from "@vercel/blob";
import OpenAI from "openai";
import { fetchWithDuplex } from "@/lib/openai-fetch";

// fetch を明示的に渡さないと SDK は node-fetch を使う。Vercel 上では
// 音声アップロード中に read ECONNRESET で切断される事象が出たため、
// Node 標準の fetch（undici）に寄せる。
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: fetchWithDuplex,
  maxRetries: 3,
  // maxDuration(300秒)より手前で諦め、原因の分かるエラーを返せるようにする
  timeout: 240_000,
});

// Fluid compute 有効時は Hobby でも 300 秒が上限かつ既定値。
// 実測 6.7 分の音声で約 9.6 秒だったため、1時間でも 90 秒前後で収まる想定。
export const maxDuration = 300;

// Whisper（whisper-1）のファイル上限
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

async function transcribe(file: File): Promise<string> {
  // 失敗したときにサイズと所要時間の相関を追えるようにしておく
  const startedAt = Date.now();
  console.log("[transcribe] 送信:", file.name, file.type, `${file.size}バイト`);

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "ja",
  });

  console.log("[transcribe] 完了:", `${Date.now() - startedAt}ms`);
  return transcription.text.trim();
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";

    // 経路1: Blob に直接アップロード済みの録音を URL で受け取る（通常経路）。
    // 音声の実体は関数のリクエストボディを通らないので 4.5MB 上限にかからない。
    if (contentType.includes("application/json")) {
      const { blobUrl, filename } = (await req.json()) as {
        blobUrl?: string;
        filename?: string;
      };

      if (!blobUrl) {
        return NextResponse.json({ error: "blobUrl がありません。" }, { status: 400 });
      }

      const result = await get(blobUrl, { access: "private" });
      if (!result || result.statusCode !== 200) {
        return NextResponse.json({ error: "録音ファイルを取得できませんでした。" }, { status: 404 });
      }

      if (result.blob.size > WHISPER_MAX_BYTES) {
        return NextResponse.json(
          { error: "録音が25MBを超えています。分割経路で処理してください。" },
          { status: 413 }
        );
      }

      const data = await new Response(result.stream).blob();
      const file = new File([data], filename ?? "recording.webm", {
        type: result.blob.contentType,
      });

      return NextResponse.json({ text: await transcribe(file) });
    }

    // 経路2: 25MB超のときにクライアントが分割して送ってくるチャンク（フォールバック）
    const formData = await req.formData();
    const audioFile = formData.get("audio");

    if (!audioFile || !(audioFile instanceof Blob)) {
      return NextResponse.json({ error: "音声ファイルがありません。" }, { status: 400 });
    }

    const filename = (formData.get("filename") as string | null) ?? "recording.webm";
    const file = new File([audioFile], filename, { type: audioFile.type });

    return NextResponse.json({ text: await transcribe(file) });
  } catch (err) {
    // "Connection error." だけでは原因が分からないので、下位層の理由まで残す。
    // undici の cause に ECONNRESET / ENOTFOUND / UND_ERR_CONNECT_TIMEOUT
    // などが入っており、ネットワークかAPI側かの切り分けに要る。
    const e = err as { name?: string; status?: number; cause?: unknown };
    const cause = e.cause as { code?: string; message?: string } | undefined;
    console.error("文字起こしエラー:", {
      name: e.name,
      status: e.status,
      message: err instanceof Error ? err.message : String(err),
      causeCode: cause?.code,
      causeMessage: cause?.message,
    });

    const message = err instanceof Error ? err.message : "サーバーエラー";
    return NextResponse.json(
      { error: cause?.code ? `${message}（${cause.code}）` : message },
      { status: 500 }
    );
  }
}
