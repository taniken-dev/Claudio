import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <main style={styles.main}>
      <h1 style={styles.title}>Claudio</h1>
      <p className="text-muted" style={styles.subtitle}>録音 → 文字起こし → 要約 → Notion保存</p>
      <div className="card elev-sm" style={styles.card}>
        <p className="text-muted" style={styles.description}>Googleアカウントでログインしてください</p>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button type="submit" className="btn btn-secondary" style={styles.button}>
            <svg width="18" height="18" viewBox="0 0 18 18" style={{ marginRight: 8 }}>
              <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
              <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z"/>
              <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
            </svg>
            Googleでログイン
          </button>
        </form>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 44, margin: "0 0 8px" },
  subtitle: { fontSize: 16, margin: "0 0 40px" },
  card: { padding: "32px 40px", textAlign: "center", minWidth: 300 },
  description: { fontSize: 14, margin: "0 0 24px" },
  button: { width: "100%", padding: "12px 24px", fontSize: 15, background: "#fff" },
};
