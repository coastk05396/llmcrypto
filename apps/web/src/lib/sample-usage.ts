/** SAMPLE usage export for the diagnostics page. Invented; matches ids in SAMPLE_CATALOG plus one unknown model. */
export const SAMPLE_USAGE_CSV = [
  "timestamp,model,input_tokens,output_tokens,cached_tokens,cost_usd",
  "2026-10-01T09:00:00Z,alpha-large,120000,8000,0,0.48",
  "2026-10-01T09:05:00Z,alpha-large,64000,2200,40000,0.24",
  "2026-10-02T14:20:00Z,beta-fast,900000,45000,0,0.17",
  "2026-10-03T08:00:00Z,gamma-mini,15000,900,0,0.0014",
  "2026-10-03T08:30:00Z,unlisted-model-x,50000,3000,0,0.30",
  "2026-10-04T10:00:00Z,,1000,200,0,0.01",
].join("\n") + "\n";
