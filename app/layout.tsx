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
          <header className="nav" style={{ maxWidth: 760, margin: "0 auto", padding: "28px 28px 0" }}>
            <span className="nav-brand">
              <span style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--color-accent)", color: "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>
              </span>
              Claudio
            </span>
            <span className="tag tag-neutral">{session.user?.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button type="submit" className="btn btn-ghost">ログアウト</button>
            </form>
          </header>
        )}
        {children}
      </body>
    </html>
  );
}
