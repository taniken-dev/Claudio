import { issueSignedToken } from "@vercel/blob";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { auth } from "@/auth";

// 録音は4.5MBのボディ上限を避けてブラウザから直接Blobへ送る。
// このルートは署名済みURLを発行するだけで、音声の実体はここを通らない。
// presigned方式なので長期有効な読み書きトークンは不要で、OIDC
// （BLOB_STORE_ID + VERCEL_OIDC_TOKEN）で認証される。
const MAX_RECORDING_BYTES = 200 * 1024 * 1024;
// MediaRecorder は "audio/webm;codecs=opus" のようにコーデック付きで返すため、
// 個別列挙だと一致しない。ブラウザ差異も吸収できるワイルドカードを使う。
// MediaRecorder は "audio/webm;codecs=opus" を返すが、保存済みファイルを
// 選び直すと OS/ブラウザが同じ .webm を "video/webm" と報告することがある。
// webm/mp4/ogg は音声専用でもコンテナ上は video/* になり得るため許可する。
const ALLOWED_CONTENT_TYPES = ["audio/*", "video/webm", "video/mp4", "video/ogg"];

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadPresignedBody;

  try {
    const jsonResponse = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname) => {
        // ここを省くとBlobストアが誰でも書き込める状態になる
        const session = await auth();
        if (!session) throw new Error("認証されていません。");

        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_RECORDING_BYTES,
          validUntil: Date.now() + 60 * 60 * 1000,
        });

        return {
          token,
          urlOptions: {
            allowedContentTypes: ALLOWED_CONTENT_TYPES,
            maximumSizeInBytes: MAX_RECORDING_BYTES,
            // 1時間の録音のアップロードにも耐えるよう長めに取る
            validUntil: Date.now() + 60 * 60 * 1000,
            addRandomSuffix: true,
            allowOverwrite: false,
          },
        };
      },
      // onUploadCompleted は使わない。クライアントは uploadPresigned() の
      // 戻り値から URL を直接受け取るため、ローカルでも ngrok が要らない。
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    console.error("[blob-upload] 失敗:", err);
    const message = err instanceof Error ? err.message : "アップロードを開始できませんでした。";
    return NextResponse.json(
      { error: message },
      { status: message === "認証されていません。" ? 401 : 400 }
    );
  }
}
