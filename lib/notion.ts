// Notion API の制約。1ブロックの文字列は2000文字まで、1回のリクエストで渡せる子ブロックは100個まで。
export const NOTION_TEXT_LIMIT = 2000;
export const NOTION_CHILDREN_LIMIT = 100;

export interface ParagraphBlock {
  type: "paragraph";
  paragraph: { rich_text: { type: "text"; text: { content: string } }[] };
}

/** 文字起こしを段落ブロックに変える。区間ごとの改行は段落の切れ目として残す */
export function transcriptBlocks(transcript: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  for (const line of transcript.split("\n")) {
    for (let i = 0; i < line.length; i += NOTION_TEXT_LIMIT) {
      const content = line.slice(i, i + NOTION_TEXT_LIMIT).trim();
      if (content) blocks.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } });
    }
  }
  return blocks;
}

export function inBatches<T>(items: T[], size = NOTION_CHILDREN_LIMIT): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
