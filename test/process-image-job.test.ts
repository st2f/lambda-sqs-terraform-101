import { afterEach, describe, expect, it, vi } from "vitest";

import { processImageJob } from "../src/process-image-job.js";

describe("processImageJob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the image job and returns a successful result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await processImageJob({
      jobId: "job-123",
      imageId: "image-456",
      operation: "resize",
    });

    expect(result).toEqual({
      jobId: "job-123",
      status: "accepted",
    });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      message: "Image job received",
      jobId: "job-123",
      imageId: "image-456",
      operation: "resize",
    });
  });

  it("accepts the job ID used by the completed failure exercise", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await processImageJob({
      jobId: "FAIL",
      imageId: "image-456",
      operation: "resize",
    });

    expect(result).toEqual({ jobId: "FAIL", status: "accepted" });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      message: "Image job received",
      jobId: "FAIL",
      imageId: "image-456",
      operation: "resize",
    });
  });
});
