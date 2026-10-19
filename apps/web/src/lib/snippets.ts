export type SnippetId = "anthropic" | "openai" | "curl";
export type GuideStatus = "tested" | "api-checked" | "docs-only";

export const GUIDE_STATUS_LABEL: Record<GuideStatus, string> = {
  tested: "Tested with our service",
  "api-checked": "API format checked",
  "docs-only": "Documentation only",
};

export const API_KEY_PLACEHOLDER = "YOUR_API_KEY";
export const MODEL_PLACEHOLDER = "YOUR_MODEL_ID";

/** `origin` is the site origin without a trailing slash, for example https://gateway.example. */
export function baseUrl(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function firstRequestCurl(origin: string, modelId: string): string {
  return `curl ${baseUrl(origin)}/v1/chat/completions \\
  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${modelId}", "messages": [{"role": "user", "content": "Say hello."}]}'
`;
}

export interface Snippet {
  id: SnippetId;
  label: string;
  language: "python" | "bash";
  code: string;
  note: string;
}

export function quickstartSnippets(origin: string): Snippet[] {
  const base = baseUrl(origin);
  return [
    {
      id: "anthropic",
      label: "Anthropic SDK",
      language: "python",
      note: `The Anthropic SDK adds /v1/messages itself, so the base URL is the origin only.`,
      code: `import anthropic

client = anthropic.Anthropic(
    base_url="${base}",
    api_key="${API_KEY_PLACEHOLDER}",
)

message = client.messages.create(
    model="${MODEL_PLACEHOLDER}",
    max_tokens=256,
    messages=[{"role": "user", "content": "Say hello."}],
)
print(message.content[0].text)
`,
    },
    {
      id: "openai",
      label: "OpenAI SDK",
      language: "python",
      note: `The OpenAI SDK base URL includes /v1.`,
      code: `from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key="${API_KEY_PLACEHOLDER}",
)

reply = client.chat.completions.create(
    model="${MODEL_PLACEHOLDER}",
    messages=[{"role": "user", "content": "Say hello."}],
)
print(reply.choices[0].message.content)
`,
    },
    {
      id: "curl",
      label: "cURL",
      language: "bash",
      note: `Chat Completions shape. Replace both placeholders; never paste a real key into shared text.`,
      code: `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${MODEL_PLACEHOLDER}", "messages": [{"role": "user", "content": "Say hello."}]}'
`,
    },
  ];
}

export interface Guide {
  id: string;
  title: string;
  status: GuideStatus;
  summary: string;
  prerequisites: string[];
  endpoint: (origin: string) => string;
  env: (origin: string) => string[];
  example: (origin: string) => { language: "python" | "bash"; code: string };
  caveat: string;
}

/**
 * Every guide is "docs-only" until a person has run it against a running instance of our service.
 * Do not change a status without evidence recorded in tasks/todo.md.
 */
export const GUIDES: Guide[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    status: "docs-only",
    summary: "Point Claude Code at the gateway with environment variables.",
    prerequisites: ["Claude Code installed", "An API key from the console", "A model ID that supports the Anthropic Messages shape"],
    endpoint: (o) => baseUrl(o),
    env: (o) => [`ANTHROPIC_BASE_URL=${baseUrl(o)}`, `ANTHROPIC_AUTH_TOKEN=${API_KEY_PLACEHOLDER}`],
    example: (o) => ({
      language: "bash",
      code: `export ANTHROPIC_BASE_URL="${baseUrl(o)}"\nexport ANTHROPIC_AUTH_TOKEN="${API_KEY_PLACEHOLDER}"\nclaude\n`,
    }),
    caveat: "Variable names follow the Claude Code documentation as we understand it; they have not been run against this gateway.",
  },
  {
    id: "anthropic-sdk",
    title: "Anthropic SDK (Python)",
    status: "docs-only",
    summary: "Use the official Anthropic client with a custom base URL.",
    prerequisites: ["Python 3.9 or newer", "pip install anthropic", "An API key from the console"],
    endpoint: (o) => `${baseUrl(o)}/v1/messages`,
    env: (o) => [`ANTHROPIC_BASE_URL=${baseUrl(o)}`, `ANTHROPIC_API_KEY=${API_KEY_PLACEHOLDER}`],
    example: (o) => ({
      language: "python",
      code: `import anthropic\n\nclient = anthropic.Anthropic(base_url="${baseUrl(o)}", api_key="${API_KEY_PLACEHOLDER}")\nprint(client.messages.create(model="${MODEL_PLACEHOLDER}", max_tokens=64,\n    messages=[{"role": "user", "content": "ping"}]).content[0].text)\n`,
    }),
    caveat: "The request shape follows the public Anthropic Messages format. Supported fields will be listed in the docs once the endpoint exists.",
  },
  {
    id: "openai-sdk",
    title: "OpenAI SDK (Python)",
    status: "docs-only",
    summary: "Use the official OpenAI client against Chat Completions.",
    prerequisites: ["Python 3.9 or newer", "pip install openai", "An API key from the console"],
    endpoint: (o) => `${baseUrl(o)}/v1/chat/completions`,
    env: (o) => [`OPENAI_BASE_URL=${baseUrl(o)}/v1`, `OPENAI_API_KEY=${API_KEY_PLACEHOLDER}`],
    example: (o) => ({
      language: "python",
      code: `from openai import OpenAI\n\nclient = OpenAI(base_url="${baseUrl(o)}/v1", api_key="${API_KEY_PLACEHOLDER}")\nprint(client.chat.completions.create(model="${MODEL_PLACEHOLDER}",\n    messages=[{"role": "user", "content": "ping"}]).choices[0].message.content)\n`,
    }),
    caveat: "The Responses endpoint is planned separately and is not covered by this guide.",
  },
  {
    id: "curl",
    title: "cURL",
    status: "docs-only",
    summary: "Send one request from a shell to check your key and model ID.",
    prerequisites: ["curl", "An API key from the console", "A model ID from the catalog"],
    endpoint: (o) => `${baseUrl(o)}/v1/chat/completions`,
    env: () => [`GATEWAY_API_KEY=${API_KEY_PLACEHOLDER}`],
    example: (o) => ({
      language: "bash",
      code: `curl ${baseUrl(o)}/v1/chat/completions \\\n  -H "Authorization: Bearer $GATEWAY_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${MODEL_PLACEHOLDER}", "messages": [{"role": "user", "content": "ping"}]}'\n`,
    }),
    caveat: "Keep the key in an environment variable so it does not land in shell history or screenshots.",
  },
  {
    id: "openai-compatible",
    title: "Other OpenAI-compatible tools",
    status: "docs-only",
    summary: "Tools that accept a custom OpenAI base URL usually read these two variables.",
    prerequisites: ["A tool that lets you set a base URL and API key", "An API key from the console"],
    endpoint: (o) => `${baseUrl(o)}/v1`,
    env: (o) => [`OPENAI_BASE_URL=${baseUrl(o)}/v1`, `OPENAI_API_KEY=${API_KEY_PLACEHOLDER}`],
    example: (o) => ({
      language: "bash",
      code: `export OPENAI_BASE_URL="${baseUrl(o)}/v1"\nexport OPENAI_API_KEY="${API_KEY_PLACEHOLDER}"\n`,
    }),
    caveat: "Compatibility varies by tool; we have not tested any specific third-party tool.",
  },
];
