import { BridgeError } from "./errors.js";
import {
  hasControlCharacters,
  normalizeRuntimeUrl,
  validateBrowserHandoff,
  validateReviewId
} from "./validation.js";

export const DEFAULT_RUNTIME_URL = "http://127.0.0.1:4317";

export function reviewUrl(runtimeUrl, reviewId, handoff) {
  const runtime = normalizeRuntimeUrl(runtimeUrl);
  const normalizedReviewId = validateReviewId(reviewId);
  const normalizedHandoff = validateBrowserHandoff(handoff);
  return `${runtime}/?review=${encodeURIComponent(normalizedReviewId)}` +
    `&handoff=${encodeURIComponent(normalizedHandoff)}`;
}

export function osc8Hyperlink(label, url) {
  if (typeof label !== "string" || !label || hasControlCharacters(label)) {
    throw new BridgeError("invalid_link_label", "OSC8 link label is not safe");
  }
  if (typeof url !== "string" || !url || hasControlCharacters(url)) {
    throw new BridgeError("invalid_link_url", "OSC8 link URL is not safe");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeError("invalid_link_url", "OSC8 link URL is not valid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BridgeError("invalid_link_url", "OSC8 link URL must use http or https");
  }
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

export function formatReviewLinks(runtimeUrl, reviewId, handoff) {
  const url = reviewUrl(runtimeUrl, reviewId, handoff);
  return {
    url,
    plain: `Review URL: ${url}`,
    osc8: osc8Hyperlink("Open visual plan", url)
  };
}
