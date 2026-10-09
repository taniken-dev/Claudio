import { NextRequest, NextResponse } from "next/server";
import { Client as NotionClient } from "@notionhq/client";
import { inBatches, transcriptBlocks } from "@/lib/notion";

// 文字起こしを Notion に保存するだけの置き場。要約は用途ごとに渡した先の AI に任せる。
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const transcript = (body.transcript as string | undefined)?.trim() ?? "";

    if (!transcript) {
      return NextResponse.json({ error: "音声から文字を認識できませんでした。" }, { status: 422 });
    }

    const pageId = process.env.NOTION_PAGE_ID;
    if (!pageId) return NextResponse.json({});

    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jst = new Date(now.getTime() + jstOffset);

    const userTitle = (body.title as string | undefined)?.trim() ?? "";
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateTimeStr = `${jst.getUTCFullYear()}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;

    const baseTitle = userTitle
      ? `${userTitle} - ${dateTimeStr}`
      : `🎙️ ${dateTimeStr}`;

    const uniqueTitle = await resolveUniqueTitle(pageId, baseTitle);

    // 1回に渡せる子ブロックは100個までなので、残りは作ったページへ順に追記する
    const [first = [], ...rest] = inBatches(transcriptBlocks(transcript));
    const newPage = await notion.pages.create({
      parent: { type: "page_id", page_id: pageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: uniqueTitle } }],
        },
      },
      children: first,
    });
    for (const batch of rest) {
      await notion.blocks.children.append({ block_id: newPage.id, children: batch });
    }

    return NextResponse.json({ notionUrl: `https://notion.so/${newPage.id.replace(/-/g, "")}` });
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
