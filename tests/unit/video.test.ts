import { afterEach, describe, expect, it, vi } from "vitest";
import { VIDEO_KEYFRAME_INTERVAL_MS, pickVideoFormat, videoRecorderOptions } from "@/lib/video";

function supportOnly(...types: string[]) {
  vi.stubGlobal("MediaRecorder", { isTypeSupported: (type: string) => types.includes(type) });
}

describe("pickVideoFormat", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("MP4 を録れるブラウザでは MP4 を選ぶ", () => {
    supportOnly('video/mp4;codecs="avc1.42E01E,mp4a.40.2"', "video/webm");
    expect(pickVideoFormat()).toEqual({ mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', extension: "mp4" });
  });

  it("MP4 に対応しないブラウザ（Firefox）では webm に落とす", () => {
    supportOnly("video/webm;codecs=vp8,opus", "video/webm");
    expect(pickVideoFormat()).toEqual({ mimeType: "video/webm;codecs=vp8,opus", extension: "webm" });
  });

  it("どれにも対応しなければブラウザ既定に任せる", () => {
    supportOnly();
    expect(pickVideoFormat()).toEqual({ mimeType: "", extension: "webm" });
  });
});

describe("videoRecorderOptions", () => {
  it("静止した画面でも録画が溜め込まれないよう、キーフレームの間隔を指定する", () => {
    const options = videoRecorderOptions({ mimeType: "video/mp4", extension: "mp4" }) as Record<string, unknown>;
    expect(options.videoKeyFrameIntervalDuration).toBe(VIDEO_KEYFRAME_INTERVAL_MS);
    expect(options.mimeType).toBe("video/mp4");
  });

  it("mimeType が空ならブラウザ既定に任せるため指定しない", () => {
    expect(videoRecorderOptions({ mimeType: "", extension: "webm" })).not.toHaveProperty("mimeType");
  });
});
