function providerMessage(error) {
  const candidates = [
    error?.error?.error?.message,
    error?.error?.message,
    error?.response?.data?.error?.message,
    error?.message,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())
    ?.trim()
    .slice(0, 1000) || "No provider error message was returned.";
}

function redactSecrets(message, secrets) {
  let safeMessage = message;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      safeMessage = safeMessage.replaceAll(secret, "[REDACTED]");
    }
  }
  return safeMessage;
}

export function classifyProviderError(error, {
  provider = "AI provider",
  model = "selected model",
  secrets = [],
} = {}) {
  const parsedStatus = Number(error?.status);
  const status = error?.status !== undefined && error?.status !== null && Number.isInteger(parsedStatus)
    ? parsedStatus
    : null;
  const rawMessage = providerMessage(error);
  const safeProviderMessage = redactSecrets(rawMessage, secrets);
  const lowerMessage = safeProviderMessage.toLowerCase();
  const prefix = `${provider} request`;
  let code = "provider_error";
  let message = `${prefix} failed${status ? ` with HTTP ${status}` : ""}.`;

  if (error?.code === "provider_configuration_error") {
    code = "provider_configuration_error";
    message = `${provider} is not configured correctly. Check AI_PROVIDER, the API key, and model settings.`;
  } else if (error?.name === "AbortError" || /timeout|timed out|aborted/i.test(lowerMessage)) {
    code = "provider_timeout";
    message = `${provider} timed out. Check connectivity and retry.`;
  } else if (/enotfound|econnrefused|econnreset|network error|fetch failed/i.test(lowerMessage)) {
    code = "provider_connection_error";
    message = `Could not connect to ${provider}. Check network and provider availability.`;
  } else if (status === 401) {
    code = "provider_authentication_failed";
    message = `${provider} rejected the API key. Check that the key belongs to this provider and is active.`;
  } else if (status === 403 || status === 404 ||
      /model.{0,30}(not found|does not exist|not available|not have access|no access)/i.test(lowerMessage)) {
    code = "provider_model_access_failed";
    message = `${provider} cannot access model "${model}". Verify the model ID and that this account can use it.`;
  } else if (status === 429) {
    code = "provider_rate_limited";
    message = `${provider} rate-limited the request. Wait and retry; check quota and tokens-per-minute limits.`;
  } else if (status === 413 || /request too large|payload too large|image.{0,30}(too large|size limit)/i.test(lowerMessage)) {
    code = "provider_image_too_large";
    message = `${provider} rejected the image payload as too large. Reduce image dimensions or remove a reference frame.`;
  } else if ((status === 400 || status === 415 || status === 422) &&
      /image|vision|base64|media|mime|format|dimension/i.test(lowerMessage)) {
    code = "provider_image_format_invalid";
    message = `${provider} rejected the image format or encoding. Send a supported JPEG, PNG, or WebP data URL.`;
  } else if (status === 400 || status === 422) {
    code = "provider_request_invalid";
    message = `${provider} rejected the request. Verify the model, message format, and supported request options.`;
  } else if (status === 402) {
    code = "provider_account_billing";
    message = `${provider} reports a billing or account-balance issue. Check the provider console.`;
  } else if (status !== null && status >= 500) {
    code = "provider_unavailable";
    message = `${provider} is temporarily unavailable (HTTP ${status}). Retry later.`;
  } else if (/no.{0,30}(api key|credential)|missing api key|api key.{0,30}(not configured|missing)|credential.{0,30}(not configured|missing)|configuration/i.test(lowerMessage)) {
    code = "provider_configuration_error";
    message = `${provider} is not configured correctly. Check the API key and provider settings.`;
  }

  return {
    code,
    status,
    message,
    providerMessage: safeProviderMessage,
  };
}
