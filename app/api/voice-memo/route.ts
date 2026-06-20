import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Client as NotionClient } from "@notionhq/client";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get("audio");

    if (!audioFile || !(audioFile instanceof Blob)) {
      return NextResponse.json({ error: "音声ファイルがありません。" }, { status: 400 });
    }

    // Step 1: OpenAI Whisper で文字起こし
    const file = new File([audioFile], "recording.webm", { type: audioFile.type });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "ja",
    });
    const transcript = transcription.text.trim();

    if (!transcript) {
      return NextResponse.json({ error: "音声から文字を認識できませんでした。" }, { status: 422 });
    }

    // Step 2: GPT-4o で要約・整理（失敗しても文字起こしは保存する）
    let summary = "";
    let keywords: string[] = [];
    let summaryFailed = false;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 1500,
        messages: [
          {
            role: "system",
            content: "あなたは日本語の音声メモを整理するアシスタントです。",
          },
          {
            role: "user",
            content: `以下の文字起こしテキストを整理してください。
誤認識と思われる単語は文脈から正しい単語に修正すること。

【話者整理の発言内容について】
・対比できる概念が出てきた場合は箇条書きで対比して整理する
・手順・ステップ・列挙が3つ以上ある場合は箇条書きにする
・それ以外の説明は段落で記載する
・内容に応じて自動判断し、無条件に箇条書きにしないこと

出力は必ず以下のフォーマットを厳守すること。
マークダウンの記号（**や--）はそのまま出力しないこと。

---
🎙️ 話者整理

[話者名]（役割）
発言内容

[話者名]（役割）
発言内容

---
✨ 要約

・要点1
・要点2
・要点3

---
📌 アクションアイテム（あれば）

・内容

---
📌 キーワードタグ

キーワード1, キーワード2, キーワード3
---

話者名が含まれる場合はそれを使用。ない場合は話者A・話者Bとする。

【文字起こし】
${transcript}`,
          },
        ],
      });

      summary = completion.choices[0]?.message?.content?.trim() ?? "";
      keywords = extractKeywords(summary);
    } catch (err) {
      console.error("GPT-4o 要約エラー:", err);
      summaryFailed = true;
    }

    // Step 3: Notion に子ページとして保存
    const pageId = process.env.NOTION_PAGE_ID;
    let notionUrl: string | undefined;

    if (pageId) {
      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jst = new Date(now.getTime() + jstOffset);

      const userTitle = (formData.get("title") as string | null)?.trim() ?? "";
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateTimeStr = `${jst.getUTCFullYear()}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;

      const baseTitle = userTitle
        ? `${userTitle} - ${dateTimeStr}`
        : `🎙️ ${dateTimeStr}`;

      const uniqueTitle = await resolveUniqueTitle(pageId, baseTitle);

      const newPage = await notion.pages.create({
        parent: { type: "page_id", page_id: pageId },
        properties: {
          title: {
            title: [{ type: "text", text: { content: uniqueTitle } }],
          },
        },
        children: [
          ...(summaryFailed
            ? [
                {
                  type: "callout" as const,
                  callout: {
                    rich_text: [{ type: "text" as const, text: { content: "要約に失敗したため、文字起こしのみ保存しています。" } }],
                    icon: { type: "emoji" as const, emoji: "⚠️" as const },
                  },
                },
              ]
            : []),
          {
            type: "toggle" as const,
            toggle: {
              rich_text: [{ type: "text" as const, text: { content: "📝 文字起こし全文（タップで展開）" } }],
              children: splitIntoParagraphs(transcript),
            },
          },
          ...(summaryFailed ? [] : [
            { type: "divider" as const, divider: {} as Record<string, never> },
            ...buildNotionBlocks(summary),
          ]),
        ],
      });

      // タグをmulti_selectプロパティとして保存（データベースページの場合のみ有効）
      if (keywords.length > 0) {
        try {
          await notion.pages.update({
            page_id: newPage.id,
            properties: {
              タグ: {
                multi_select: keywords.map((k) => ({ name: k })),
              },
            },
          });
        } catch {
          // 親がデータベースでない場合はスキップ
        }
      }

      notionUrl = `https://notion.so/${newPage.id.replace(/-/g, "")}`;
    }

    return NextResponse.json({ transcript, summary, notionUrl, summaryFailed });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "サーバーエラー";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function splitIntoParagraphs(text: string, maxLen = 2000) {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks.map((chunk) => ({
    type: "paragraph" as const,
    paragraph: {
      rich_text: [{ type: "text" as const, text: { content: chunk } }],
    },
  }));
}

function extractKeywords(summary: string): string[] {
  const lines = summary.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("キーワードタグ")) {
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (candidate && !/^[-—―]+$/.test(candidate) && !candidate.startsWith("📌")) {
          return candidate.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
        }
      }
    }
  }
  return [];
}

async function resolveUniqueTitle(pageId: string, baseTitle: string): Promise<string> {
  const existingTitles = new Set<string>();
  let cursor: string | undefined;

  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const block of res.results) {
      if ("type" in block && block.type === "child_page") {
        existingTitles.add(block.child_page.title);
      }
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  if (!existingTitles.has(baseTitle)) return baseTitle;

  let n = 1;
  while (existingTitles.has(`${baseTitle} (${n})`)) n++;
  return `${baseTitle} (${n})`;
}

function buildNotionBlocks(summary: string) {
  type Block =
    | { type: "divider"; divider: Record<string, never> }
    | { type: "heading_2"; heading_2: { rich_text: { type: "text"; text: { content: string } }[] } }
    | { type: "heading_3"; heading_3: { rich_text: { type: "text"; text: { content: string } }[] } }
    | { type: "paragraph"; paragraph: { rich_text: { type: "text"; text: { content: string } }[] } }
    | { type: "bulleted_list_item"; bulleted_list_item: { rich_text: { type: "text"; text: { content: string } }[] } };

  const blocks: Block[] = [];
  let inSpeakerSection = false;

  for (const rawLine of summary.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // 区切り線
    if (/^[-—―]{2,}$/.test(line)) {
      blocks.push({ type: "divider", divider: {} });
      continue;
    }

    // セクション見出し（🎙️ / ✨ / 📌）
    if (/^[🎙✨📌]/.test(line)) {
      inSpeakerSection = line.startsWith("🎙");
      blocks.push({ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: line } }] } });
      continue;
    }

    // 箇条書き（・ または • で始まる行）
    if (/^[・•]/.test(line)) {
      const text = line.replace(/^[・•]\s*/, "");
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: text } }] } });
      continue;
    }

    // 話者名（話者整理セクション内で「名前（役割）」パターン）
    if (inSpeakerSection && /^.+（.+）$/.test(line) && line.length <= 40) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: line } }] } });
      continue;
    }

    // それ以外は段落
    blocks.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line } }] } });
  }

  return blocks;
}
