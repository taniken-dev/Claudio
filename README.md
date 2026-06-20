# Claudio

音声を録音して、文字起こし・要約・Notion保存まで自動で行うWebアプリです。

## 機能

- Googleアカウントによるログイン認証（許可したメールアドレスのみアクセス可）
- ブラウザでマイク録音（MediaRecorder API）・録音タイマー表示
- 音声ファイルのアップロードにも対応（mp3 / m4a / webm など）
- 録音中のキャンセル（確認ダイアログあり）
- OpenAI Whisper による日本語文字起こし
- GPT-4o による話者整理・要約・アクションアイテム抽出・キーワードタグ生成
- 文字起こし・要約のワンクリックコピー
- Notion の指定ページに子ページとして自動保存
- 長時間録音（文字起こし全文を2000文字ごとに分割してNotion保存）

## 技術スタック

- **フロントエンド**: Next.js 15 (App Router) / TypeScript / React 19
- **認証**: NextAuth.js v5 / Google OAuth 2.0
- **文字起こし**: OpenAI Whisper API (`whisper-1`)
- **要約**: OpenAI GPT-4o
- **保存先**: Notion API (`@notionhq/client`)

## セットアップ

### 1. リポジトリをクローン

```bash
git clone https://github.com/taniken-dev/Claudio.git
cd Claudio
```

### 2. 依存関係をインストール

```bash
npm install
```

### 3. 環境変数を設定

`.env.local.example` をコピーして `.env.local` を作成し、各APIキーを入力します。

```bash
cp .env.local.example .env.local
```

```env
OPENAI_API_KEY=sk-...
NOTION_API_KEY=secret_...
NOTION_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx

AUTH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALLOWED_EMAIL=your@gmail.com

# Vercel本番環境のみ必要
AUTH_URL=https://your-app.vercel.app
```

| 変数名 | 説明 |
|---|---|
| `OPENAI_API_KEY` | OpenAI APIキー（Whisper・GPT-4o に使用） |
| `NOTION_API_KEY` | Notion インテグレーションのAPIキー |
| `NOTION_PAGE_ID` | 保存先ページのID（URLの末尾32文字） |
| `GOOGLE_CLIENT_ID` | Google OAuth クライアントID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth クライアントシークレット |
| `AUTH_SECRET` | NextAuth 署名用シークレット（`openssl rand -base64 32` で生成） |
| `ALLOWED_EMAIL` | アクセスを許可するGoogleアカウントのメールアドレス |
| `AUTH_URL` | Vercel 本番環境のURL（デプロイ時のみ必要） |

### 4. Google OAuth の設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「APIとサービス」→「認証情報」→「OAuthクライアントID」を作成（種別: ウェブアプリケーション）
3. 承認済みリダイレクトURIに以下を追加：
   - ローカル: `http://localhost:3000/api/auth/callback/google`
   - 本番: `https://your-app.vercel.app/api/auth/callback/google`
4. 取得した クライアントID・シークレットを `.env.local` に設定

### 5. Notion の設定

1. [Notion Integrations](https://www.notion.so/my-integrations) でインテグレーションを作成
2. 保存先ページを開き、「接続を追加」でインテグレーションを接続
3. ページURLの末尾32文字（ハイフン除く）を `NOTION_PAGE_ID` に設定

> **キーワードタグのmulti_select保存について**  
> 保存先が Notion データベースの場合、`タグ` プロパティにキーワードが multi_select で自動保存されます。通常のページの場合はページ本文内に記載されます。

### 6. 起動

```bash
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

## 使い方

1. Googleアカウントでログイン（`ALLOWED_EMAIL` に設定したアカウントのみ可）
2. タイトルを入力（省略可）
3. **「録音開始」** を押してマイクを許可 → 録音タイマーが表示される
   - 録音中に **「キャンセル」** を押すと確認後に破棄
   - 音声ファイルがある場合は **「ファイルを選択」** からアップロードも可能
4. **「録音停止」** を押すと自動で処理開始
5. 文字起こし・要約が画面に表示され、Notionに保存される
   - 各テキストはコピーボタンでクリップボードにコピー可能

### Notion 保存フォーマット

- **ページタイトル**: `入力タイトル - 2026/06/09 01:33`（タイトル省略時は `🎙️ 2026/06/09 01:33`）
- **同名ページ**: `タイトル (1)`、`タイトル (2)` のように自動で連番付与
- **ページ内容**:
  - 📝 文字起こし全文（toggle で折りたたみ）
  - 🎙️ 話者整理（話者ごとに整理）
  - ✨ 要約（箇条書き）
  - 📌 アクションアイテム
  - 📌 キーワードタグ

## 環境変数

APIキーはすべてサーバーサイド（Next.js Route Handler）でのみ使用されます。ブラウザには一切露出しません。
