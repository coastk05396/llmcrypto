# Provider and protocol matrix

Status (2026-10-18): **only the deterministic FakeProvider exists.** No real provider is integrated. The real
provider (task 12) is **BLOCKED: no provider account or credentials**. Nothing below claims compatibility with any
real upstream; all models in the catalog are fabricated sample entries (`source: sample-seed`).

## Provider x protocol x model

| Provider | Model ids (sample, fabricated) | `POST /v1/chat/completions` | `POST /v1/messages` | `POST /v1/responses` | Gemini `generateContent` |
| --- | --- | --- | --- | --- | --- |
| `fake` (in-process test double, `apps/api/src/gateway/fake-provider.ts`) | `sample-fast-1` | stream + non-stream, tested | stream + non-stream, tested | stream + non-stream + function-tool passthrough, tested against the fake only | **DISABLED, not built** (see below) |
| `fake` | `sample-frontier-1` | stream + non-stream, tested | stream + non-stream, tested | rejected: 400 `model_protocol_unsupported` (catalog does not list it) | n/a |
| `fake` | `sample-reasoner-1` | chat + Responses (catalog lists both); only `sample-fast-1` is exercised in tests | rejected: 400 `model_protocol_unsupported` | listed, same adapter | n/a |
| `fake` | `sample-mini-1`, `sample-lite-1`, `sample-long-context-1` | stream + non-stream (the catalog lists the protocol) | rejected: 400 `model_protocol_unsupported` (no translation) | rejected | n/a (see Gemini) |
| real provider | none | BLOCKED (no account) | BLOCKED | BLOCKED | BLOCKED |

A model is served on an endpoint only when its catalog `protocols` includes that endpoint's protocol; otherwise the
request fails with 400 `model_protocol_unsupported`. The gateway never switches model or route silently.

## `POST /v1/responses` (OpenAI Responses) - task 15, fake only

Adapter: `apps/api/src/gateway/responses.ts`; tests: `tests/integration/responses.test.ts` (19). **Verified only against
the FakeProvider; no SDK or real upstream was run.** Same pipeline as the other endpoints (hold, one provider call,
settle, `requests.protocol = openai_responses`).

- Supported: `model`, `input` (string or message / `function_call` / `function_call_output` items with `input_text` /
  `output_text` parts), `instructions`, `max_output_tokens`, `stream`, `temperature`, `top_p`, `user`, function `tools`,
  `tool_choice` (`auto | none | required | {type:function,name}`), `parallel_tool_calls` (echoed), `store` only as `false`.
- Rejected with 400 naming the field (`unsupported_parameter` / `unsupported_value`): `previous_response_id`, `reasoning`,
  `text` (structured output), `include`, `background`, `conversation`, `metadata`, `truncation`, `store=true`,
  built-in tools (web/file search, code interpreter, MCP...), image/file/audio input parts, other item types.
  Responses are not stored: there is no `GET /v1/responses/{id}`.
- Response: `object: response`, `output` = a `message` item and/or `function_call` items, `usage` with cached tokens;
  length cap -> `status: incomplete` + `incomplete_details.reason = max_output_tokens`.
- Streaming: `response.created`, `.in_progress`, `.output_item.added`, `.content_part.added`, `.output_text.delta`,
  `.output_text.done`, `.content_part.done`, `.output_item.done`, `.function_call_arguments.delta/.done`,
  `.completed` | `.incomplete`, each with `sequence_number`; a mid-stream failure is an `error` event (no `completed`).
  There is no `[DONE]` sentinel (matches the Responses API).
- Tool calls are passthrough: tool definitions go to the provider interface untouched and its calls are rendered
  untouched. The fake produces a call only on `[[fake:tool_call]]`, `tool_choice: required` or a named choice; at most
  one call per response. Tool definitions are counted in the reserved input bound.

## Gemini `generateContent`: DISABLED, not built

No adapter exists. `POST /v1beta/models/*` answers **501 `protocol_not_implemented`** so the gap is visible instead of a
bare 404. The sample catalog still lists `gemini_generate_content` for `sample-long-context-1` (fabricated sample data);
that listing is not backed by an endpoint and must be removed or the adapter built before launch (needs a tested
request/response contract and model matrix).

## What the FakeProvider is

Deterministic and offline. Output is `tok0 tok1 ...`; input tokens are `ceil(utf8 bytes / 4) + 3` per message.
Directives in message text (`[[fake:hang]]`, `[[fake:reject]]`, `[[fake:no_usage]]`, `[[fake:late_usage]]`,
`[[fake:error_after=N]]`, `[[fake:slow]]`, `[[fake:overrun]]`, `[[fake:cached=N]]`, `[[fake:output=N]]`, `[[fake:tool_call]]`) inject
timeout, rejection, missing usage, late usage, mid-stream error, slow/disconnectable streams, provider overrun, cached
tokens and output length. It honours `max_tokens` only; sampling parameters are accepted and ignored. Its input-token
upper bound (utf8 bytes + framing) is valid for any tokenizer but is not a real tokenizer: real routes need their own
proven bound or must be rejected.

## Gateway behaviour (tested against the fake)

- Config: `GATEWAY_PROVIDER=fake` enables the gateway; unset = `/v1/chat/completions`, `/v1/messages` and `/v1/responses` answer 503.
- Auth: `Authorization: Bearer <key>` or `x-api-key`. Unknown/revoked/expired -> 401 (indistinguishable); missing
  `gateway:invoke` scope -> 403; model outside the key's allowlist -> 403 `model_not_allowed`.
- Supported request fields. OpenAI: `model, messages (text content only), stream, stream_options.include_usage,
  max_tokens, max_completion_tokens, temperature, top_p, stop, n (=1), user`. Anthropic: `model, messages, system,
  max_tokens (required), stream, temperature, top_p, stop_sequences, metadata.user_id`. Anything else (tools,
  response_format, images, ...) -> 400 `unsupported_parameter` naming the field.
- Output cap: omitted -> `GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS` (1024); above `GATEWAY_MAX_OUTPUT_TOKENS_CEILING`
  (8192) -> 400 (never silently clamped). Input + cap above the model context window -> 400 `context_length_exceeded`.
  Anthropic requires `max_tokens` as upstream does.
- Reservation: upper-bound input tokens (at the dearer of input/cached rate) + full output cap at the output rate,
  rounded up once. Refused -> 402 `insufficient_funds` (OpenAI type `insufficient_quota`, Anthropic `billing_error`),
  `key_spend_cap_exceeded` or `project_spend_cap_exceeded`; nothing is dispatched.
- Metadata headers (optional, 1-128 chars of `[A-Za-z0-9_.:-]`): `X-Correlation-Id`, `X-Run-Id`, `X-Parent-Id`,
  `X-Project-Id` (must belong to the key's account and, for project-scoped keys, equal its project).
- One provider call per request; no retry after possible acceptance. Pre-dispatch failure or provider rejection ->
  hold released, 502, no charge. Timeout/disconnect/error after dispatch -> charged from verified usage if the
  provider reported it, otherwise `USAGE_PENDING`.
- Streaming errors: failure before the first provider event is a normal JSON error; afterwards an OpenAI
  `data: {"error":...}` frame or an Anthropic `event: error` frame is emitted and the stream closes (no `[DONE]` /
  `message_stop`).
- Limits: per-key rate (`GATEWAY_RATE_LIMIT_PER_MINUTE`, 600) and concurrency (`GATEWAY_MAX_CONCURRENT_PER_KEY`, 16) ->
  429 with `Retry-After`; both are in-memory and per process.

## Open policy (unconfirmed)

`USAGE_PENDING` is reconciled for `GATEWAY_USAGE_PENDING_SECONDS` (default 86400 = the 24 h the spec proposes;
**commercial policy unconfirmed**). After it, the worker releases the hold, absorbs the provider cost and settles at
zero; the customer is never charged later. Long-context tiered rates are not modelled (the catalog has no thresholds).
