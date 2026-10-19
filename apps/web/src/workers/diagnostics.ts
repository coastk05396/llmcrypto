/// Runs the whole import inside a dedicated worker. It performs no network requests.
import { UsageImportError, buildReport, importUsage } from "@llmcrypto/domain";
import type { AnalyzeRequest, AnalyzeResponse } from "./protocol";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResponse): void;
};

ctx.onmessage = (e) => {
  void run(e.data).then((out) => ctx.postMessage(out));
};

async function run(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  try {
    const input = req.file
      ? { name: req.file.name, bytes: new Uint8Array(await req.file.arrayBuffer()) }
      : { name: "sample-usage.csv", bytes: new TextEncoder().encode(req.sampleCsv ?? "") };
    const result = await importUsage(input);
    const report = buildReport(result, req.snapshot, req.generatedAt, { sampleData: req.file === null });
    return { type: "result", report, preview: result.rows.slice(0, 10), excluded: result.excluded };
  } catch (err) {
    if (err instanceof UsageImportError) return { type: "error", code: err.code, message: err.message };
    return { type: "error", code: "UNEXPECTED", message: "The file could not be processed." };
  }
}
