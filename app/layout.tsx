import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claudio - 音声メモ",
  description: "音声録音・文字起こし・要約・Notion保存",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
