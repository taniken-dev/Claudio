import { NextRequest, NextResponse } from "next/server";
import { get } from "@vercel/blob";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Fluid compute 有効時は Hobby でも 300 秒が上限かつ既定値。
// 実測 6.7 分の音声で約 9.6 秒だったため、1時間でも 90 秒前後で収まる想定。
export const maxDuration = 300;

// Whisper（whisper-1）のファイル上限
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

async function transcribe(file: File): Promise<string> {
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "ja",
  });
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
    console.error("文字起こしエラー:", err);
    const message = err instanceof Error ? err.message : "サーバーエラー";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
