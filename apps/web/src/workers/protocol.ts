import type { ExcludedRow, PriceSnapshot, UsageReport, UsageRow } from "@llmcrypto/domain";

export interface AnalyzeRequest {
  type: "analyze";
  /** A user-selected File, or null when `sampleCsv` is used. Files are structured-cloned, never uploaded. */
  file: File | null;
  sampleCsv: string | null;
  snapshot: PriceSnapshot;
  generatedAt: string;
}

export type AnalyzeResponse =
  | { type: "result"; report: UsageReport; preview: UsageRow[]; excluded: ExcludedRow[] }
  | { type: "error"; code: string; message: string };
