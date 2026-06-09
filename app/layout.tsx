import type { Metadata } from "next";
import "./globals.css";
import { auth, signOut } from "@/auth";

export const metadata: Metadata = {
  title: "Claudio - 音声メモ",
  description: "音声録音・文字起こし・要約・Notion保存",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="ja">
      <body>
        {session && (
          <header style={headerStyle}>
            <span style={emailStyle}>{session.user?.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button type="submit" style={signOutStyle}>
                ログアウト
              </button>
            </form>
          </header>
        )}
        {children}
      </body>
    </html>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 16,
  padding: "10px 24px",
  borderBottom: "1px solid #e2e8f0",
  background: "#fff",
};

const emailStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#666",
};

const signOutStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#e53e3e",
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 0,
};
