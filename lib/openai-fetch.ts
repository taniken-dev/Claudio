// openai v4 は Node 環境では multipart の body を node-fetch 向けに
// Node の Readable として組み立てる。undici（Node 標準の fetch）は
// ストリームを body にする際 duplex 指定を必須とするため、ここで補う。
// 補わないと Whisper 送信が "Connection error." で落ちる。
export const fetchWithDuplex: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init?.body ? ({ ...init, duplex: "half" } as RequestInit) : init);
