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

    // Step 2: GPT-4o で要約・整理
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content: "あなたは日本語の音声メモを整理するアシスタントです。",
        },
        {
          role: "user",
          content: `以下の文字起こしテキストを整理してください。
誤認識と思われる単語は文脈から正しい単語に修正すること。

出力は必ず以下のフォーマットを厳守すること。
マークダウンの記号（**や--）はそのまま出力しないこと。

---
🎙️ 話者整理

[話者名]（役割）
発言内容を整理して段落で記載。箇条書きは内容の列挙が必要な場合のみ使う。

[話者名]（役割）
発言内容を整理して段落で記載。

---
✨ 要約

・要点1
・要点2
・要点3

---
📌 アクションアイテム（あれば）

・内容
---

話者名が含まれる場合はそれを使用。ない場合は話者A・話者Bとする。

【文字起こし】
${transcript}`,
        },
      ],
    });

    const summary = completion.choices[0]?.message?.content?.trim() ?? "";

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
          {
            type: "heading_2",
            heading_2: {
              rich_text: [{ type: "text", text: { content: "📝 文字起こし" } }],
            },
          },
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: transcript } }],
            },
          },
          { type: "divider", divider: {} },
          ...buildNotionBlocks(summary),
        ],
      });

      notionUrl = `https://notion.so/${newPage.id.replace(/-/g, "")}`;
    }

    return NextResponse.json({ transcript, summary, notionUrl });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "サーバーエラー";
    return NextResponse.json({ error: message }, { status: 500 });
  }
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
    if (/^-{2,}$/.test(line)) {
      blocks.push({ type: "divider", divider: {} });
      continue;
    }

    // セクション見出し（🎙️ / ✨ / 📌）
    if (/^[🎙️✨📌]/.test(line)) {
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
