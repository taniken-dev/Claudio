import { describe, expect, it } from "vitest";
import { NOTION_CHILDREN_LIMIT, NOTION_TEXT_LIMIT, inBatches, transcriptBlocks } from "@/lib/notion";

const contents = (transcript: string) => transcriptBlocks(transcript).map((b) => b.paragraph.rich_text[0].text.content);

describe("transcriptBlocks", () => {
  it("区間ごとの改行を段落の切れ目にし、空行は捨てる", () => {
    expect(contents("最初の10分\n\n次の10分\n")).toEqual(["最初の10分", "次の10分"]);
  });

  it("1段落が2000文字を超えたら分ける（Notion が受け付けないため）", () => {
    const blocks = contents("あ".repeat(NOTION_TEXT_LIMIT * 2 + 5));
    expect(blocks.map((b) => b.length)).toEqual([NOTION_TEXT_LIMIT, NOTION_TEXT_LIMIT, 5]);
  });
});

describe("inBatches", () => {
  it("1回に送れる100個ずつに分ける", () => {
    const batches = inBatches(Array.from({ length: 250 }, (_, i) => i));
    expect(batches.map((b) => b.length)).toEqual([NOTION_CHILDREN_LIMIT, NOTION_CHILDREN_LIMIT, 50]);
    expect(batches.flat()).toHaveLength(250);
  });

  it("空なら1回も送らない", () => {
    expect(inBatches([])).toEqual([]);
  });
});
