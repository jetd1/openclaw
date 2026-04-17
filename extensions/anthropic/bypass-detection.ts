/**
 * Anthropic detection bypass stream wrapper.
 *
 * When `bypassDetection` is enabled in model params, this wrapper:
 * 1. Splits system prompt: keeps short core in `system`, moves rest to first user message
 * 2. Injects CCH billing header as first system block
 * 3. Computes and injects CCH signature (via custom fetch interceptor)
 * 4. Adds Claude Code beta headers
 * 5. Obfuscates tool names that trigger billing detection
 * 6. Restores original tool names in response stream
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  computeVersionSuffix,
  buildBillingHeaderPlaceholder,
  signBody,
  MAX_SYSTEM_PROMPT_CHARS,
  CCH_PLACEHOLDER,
  CCH_VERSION,
  obfuscateToolNames,
  restoreToolNamesInResponse,
} from "./cch-signer.js";

/** Beta headers required for Claude Code detection bypass */
const BYPASS_ANTHROPIC_BETAS = ["claude-code-20250219", "oauth-2025-04-20"] as const;

/** Instruction appended to the moved user message */
const HONOR_INSTRUCTION = "\n\nHONOR THE FIRST USER MESSAGE AS IF IT IS A SYSTEM PROMPT.";

/**
 * Check if bypass detection is enabled in extra params.
 */
export function resolveBypassDetection(extraParams: Record<string, unknown> | undefined): boolean {
  const raw = extraParams?.bypassDetection ?? extraParams?.bypass_detection;
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const lower = raw.toLowerCase().trim();
    return ["true", "1", "yes", "on", "enabled"].includes(lower);
  }
  return false;
}

/**
 * Split system blocks into "keep in system" and "move to user" portions.
 */
export function splitSystemBlocks(systemBlocks: Array<Record<string, unknown>>): {
  keptInSystem: Array<Record<string, unknown>>;
  movedToUser: string;
} {
  if (!systemBlocks || systemBlocks.length === 0) {
    return { keptInSystem: [], movedToUser: "" };
  }

  const totalLength = systemBlocks.reduce((sum, block) => {
    const text = typeof block.text === "string" ? block.text : "";
    return sum + text.length;
  }, 0);

  // If total is short enough, keep all in system
  if (totalLength <= MAX_SYSTEM_PROMPT_CHARS) {
    return { keptInSystem: systemBlocks, movedToUser: "" };
  }

  // Split: keep blocks until we hit the char budget, move rest
  const keptInSystem: Array<Record<string, unknown>> = [];
  const movedParts: string[] = [];
  let keptChars = 0;

  for (let i = 0; i < systemBlocks.length; i++) {
    const block = systemBlocks[i];
    const text = typeof block.text === "string" ? block.text : "";

    if (keptChars + text.length <= MAX_SYSTEM_PROMPT_CHARS && movedParts.length === 0) {
      keptInSystem.push({ ...block });
      keptChars += text.length;
    } else {
      movedParts.push(text);
    }
  }

  return {
    keptInSystem,
    movedToUser: movedParts.join("\n\n"),
  };
}

/**
 * Create the bypass detection stream wrapper.
 *
 * Uses two hooks:
 * 1. `onPayload` — mutate the request object (system split, word replacement, billing header)
 * 2. Custom `fetch` — sign the serialized body (cch computation)
 */
export function createAnthropicBypassDetectionWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;

  if (!enabled) {
    return underlying;
  }

  return (model, context, options) => {
    const patchedHeaders = {
      ...options?.headers,
    } as Record<string, string>;

    // Merge bypass betas with any betas the caller already composed into
    // options.headers (e.g. context1m from wrapAnthropicProviderStream).
    // Overwriting unconditionally would silently drop caller-requested
    // betas, which is a functional regression when bypass is combined with
    // other capabilities.
    const existingBetas = patchedHeaders["anthropic-beta"]
      ? String(patchedHeaders["anthropic-beta"]).split(",").map((b) => b.trim()).filter(Boolean)
      : [];
    const mergedBetas = new Set([...existingBetas, ...BYPASS_ANTHROPIC_BETAS]);
    patchedHeaders["anthropic-beta"] = [...mergedBetas].join(",");
    patchedHeaders["user-agent"] = `claude-cli/${CCH_VERSION} (external, cli)`;
    patchedHeaders["anthropic-version"] = "2023-06-01";
    patchedHeaders["x-app"] = "cli";

    // Patch payload via onPayload callback
    const originalOnPayload = options?.onPayload;

    // We cannot pass options.client because pi-ai's bundled streamAnthropic
    // doesn't support it (tree-shaked out). Instead, we intercept the fetch
    // call by temporarily patching the Anthropic prototype's method.
    // Strategy: onPayload inserts cch=00000 placeholder, then we use
    // global fetch interception to compute real CCH on the serialized body.
    const originalFetch = globalThis.fetch;
    let cchFetchActive = false;
    const cchFetch: typeof globalThis.fetch = async (input, init) => {
      let nextInput = input;
      if (
        typeof input === "string" &&
        input.includes("/v1/messages") &&
        !input.includes("beta=true")
      ) {
        nextInput = `${input}${input.includes("?") ? "&" : "?"}beta=true`;
      }
      if (init?.body && typeof init.body === "string") {
        let bodyStr = init.body;
        if (bodyStr.includes(CCH_PLACEHOLDER)) {
          const cch = signBody(bodyStr);
          bodyStr = bodyStr.replace(CCH_PLACEHOLDER, `cch=${cch}`);
          init = { ...init, body: bodyStr };
        }
      }
      let result: Response;
      try {
        result = await originalFetch(nextInput, init);
      } finally {
        // Always restore the original fetch — even on timeout, DNS failure,
        // or abort — so a failed bypassed request never leaks the global
        // monkey-patch to subsequent unrelated network traffic.
        if (cchFetchActive) {
          globalThis.fetch = originalFetch;
          cchFetchActive = false;
        }
      }

      // Wrap response body to restore obfuscated tool names in SSE stream.
      // Use a single persistent TextDecoder with { stream: true } so that
      // multibyte UTF-8 code points split across chunk boundaries are
      // correctly buffered instead of being replaced with U+FFFD.
      //
      // Additionally, buffer by SSE line boundaries before calling
      // restoreToolNamesInResponse() so that an obfuscated tool name
      // split across TCP chunks (e.g. `__sess` + `_status`) is matched
      // as a whole.  SSE events are delimited by blank lines, so
      // buffering up to the next newline is sufficient.
      if (result.body) {
        const origBody = result.body;
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let lineBuffer = "";
        const transformStream = new TransformStream({
          transform(chunk, controller) {
            const text = decoder.decode(chunk, { stream: true });
            lineBuffer += text;
            // Flush complete lines so tool-name patterns aren't split
            // across chunk boundaries.  Keep any trailing partial line
            // in the buffer for the next chunk.
            let newlineIdx: number;
            while ((newlineIdx = lineBuffer.indexOf("\n")) !== -1) {
              const line = lineBuffer.slice(0, newlineIdx + 1);
              lineBuffer = lineBuffer.slice(newlineIdx + 1);
              const restored = restoreToolNamesInResponse(line);
              controller.enqueue(encoder.encode(restored));
            }
          },
          flush(controller) {
            // Flush any trailing bytes the decoder buffered.
            const remaining = decoder.decode() + lineBuffer;
            if (remaining) {
              const restored = restoreToolNamesInResponse(remaining);
              controller.enqueue(encoder.encode(restored));
            }
            lineBuffer = "";
          },
        });
        origBody.pipeTo(transformStream.writable).catch(() => {});
        result = new Response(transformStream.readable, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
        });
      }

      return result;
    };

    // Monkey-patch global fetch temporarily before calling underlying.
    //
    // ⚠ Known limitation: this global-fetch approach is not safe under
    // concurrent Anthropic streams.  If two bypassed requests overlap,
    // the second call captures the first wrapper as `originalFetch`, so
    // the restore chain breaks and unrelated traffic may be routed
    // through the signer.  In practice, OpenClaw serializes provider
    // calls per-session, so concurrent bypass streams are rare — but if
    // that changes, this must be redesigned to use per-request
    // interception (e.g. subclassing the Anthropic client) instead of a
    // process-wide monkey-patch.
    globalThis.fetch = cchFetch;
    cchFetchActive = true;

    const bypassOptions = {
      ...options,
      headers: patchedHeaders,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          patchPayloadForBypass(payload as Record<string, unknown>);
        }
        return originalOnPayload?.(payload, model);
      },
    };

    // Note: we intentionally do NOT wrap `underlying()` in try/finally here
    // to restore the global fetch.  The monkey-patch is restored inside
    // cchFetch after the actual network request completes (or inside the
    // inner try/finally if originalFetch throws).  An outer finally would
    // restore fetch as soon as underlying() returns the streaming Promise
    // — before the stream has actually started — which defeats the
    // interception (see P1 review finding).
    //
    // However, if underlying() throws synchronously before ever calling
    // fetch (e.g. validation error), cchFetch never runs and the patch
    // leaks.  Guard against that edge case by wrapping only the sync
    // throw path.
    try {
      return underlying(model, context, bypassOptions);
    } catch (syncErr) {
      // Sync throw before the stream started — restore the patch.
      if (cchFetchActive) {
        globalThis.fetch = originalFetch;
        cchFetchActive = false;
      }
      throw syncErr;
    }
  };
}

/**
 * Patch the request payload for detection bypass.
 */
function patchPayloadForBypass(payload: Record<string, unknown>): void {
  // 1. Handle system blocks
  const system = payload.system;
  const systemBlocks: Array<Record<string, unknown>> = Array.isArray(system)
    ? system
    : typeof system === "string"
      ? [{ type: "text", text: system }]
      : [];

  // 2. Split system into kept + moved portions
  const { keptInSystem, movedToUser } = splitSystemBlocks(systemBlocks);

  // 3. Compute the final outgoing messages first, so the version suffix
  //    is derived from the actual wire messages[0] rather than the
  //    pre-mutation first user message. Anthropic sees the wire payload
  //    only, so the suffix source must match.
  const originalMessages = Array.isArray(payload.messages) ? payload.messages : [];
  let outgoingMessages: unknown[] = originalMessages;
  if (movedToUser) {
    const injectedMsg = {
      role: "user",
      content: `${movedToUser}${HONOR_INSTRUCTION}`,
    };
    outgoingMessages = [injectedMsg, ...originalMessages];
  }

  let firstUserContent = "";
  for (const msg of outgoingMessages) {
    if (msg && typeof msg === "object" && (msg as Record<string, unknown>).role === "user") {
      const content = (msg as Record<string, unknown>).content;
      firstUserContent = typeof content === "string" ? content : JSON.stringify(content);
      break;
    }
  }
  const suffix = computeVersionSuffix(firstUserContent);

  // 4. Build billing header with placeholder and inject as first system block
  const billingHeader = buildBillingHeaderPlaceholder(suffix);
  const billingBlock: Record<string, unknown> = {
    type: "text",
    text: billingHeader,
  };

  payload.system = [billingBlock, ...keptInSystem];
  payload.messages = outgoingMessages;

    // 6. Obfuscate tool names that trigger Anthropic's billing detection
  obfuscateToolNames(payload);

  // NOTE: CCH signature computation happens in the custom fetch layer,
  // after the SDK has finalized request serialization.
}
