/**
 * Egern scheduled script for WorkBuddy / CodeBuddy CN check-in.
 *
 * Secrets are deliberately read from ctx.env, never embedded in this file.
 * The upstream endpoint is configurable because the unofficial API may change.
 */
export default async function workBuddyAutoCheckin(ctx) {
  const env = ctx.env || {};
  const checkinUrl = (env.CHECKIN_URL || "").trim();
  const authToken = (env.AUTH_TOKEN || "").trim();
  const notify = (env.NOTIFY || "true").toLowerCase() !== "false";

  function sendNotification(title, body) {
    if (notify) ctx.notify({ title, body });
  }

  if (!checkinUrl) {
    sendNotification("WorkBuddy check-in skipped", "Set CHECKIN_URL in the module Env.");
    return;
  }

  const method = (env.CHECKIN_METHOD || "POST").trim().toUpperCase();
  if (!["GET", "POST", "PUT"].includes(method)) {
    sendNotification("WorkBuddy check-in skipped", "CHECKIN_METHOD must be GET, POST, or PUT.");
    return;
  }

  const headers = { Accept: "application/json, text/plain, */*" };
  if (authToken) {
    const authHeader = (env.AUTH_HEADER || "Authorization").trim();
    const authPrefix = env.AUTH_PREFIX === undefined ? "Bearer " : env.AUTH_PREFIX;
    headers[authHeader] = `${authPrefix}${authToken}`;
  }

  const extraHeaders = (env.EXTRA_HEADERS_JSON || "").trim();
  if (extraHeaders) {
    try {
      const parsedHeaders = JSON.parse(extraHeaders);
      if (!parsedHeaders || Array.isArray(parsedHeaders) || typeof parsedHeaders !== "object") {
        throw new Error("not an object");
      }
      Object.assign(headers, parsedHeaders);
    } catch {
      sendNotification("WorkBuddy check-in skipped", "EXTRA_HEADERS_JSON must be a JSON object.");
      return;
    }
  }

  const request = { headers, timeout: 25000, credentials: "include" };
  const rawBody = (env.CHECKIN_BODY || "").trim();
  if (method !== "GET" && rawBody) {
    try {
      request.body = JSON.parse(rawBody);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    } catch {
      // Some upstreams accept non-JSON form/text bodies. Send those unchanged.
      request.body = rawBody;
    }
  }

  try {
    let response;
    if (method === "GET") response = await ctx.http.get(checkinUrl, request);
    else if (method === "PUT") response = await ctx.http.put(checkinUrl, request);
    else response = await ctx.http.post(checkinUrl, request);

    const rawResponse = await response.text();
    let message = "";
    try {
      const data = JSON.parse(rawResponse);
      message = String(
        data.message ?? data.msg ?? data.statusMessage ?? data.detail ?? data.code ?? ""
      ).trim();
    } catch {
      message = rawResponse.replace(/\s+/g, " ").trim();
    }
    message = message.slice(0, 160) || `HTTP ${response.status}`;

    if (response.status >= 200 && response.status < 300) {
      sendNotification("WorkBuddy check-in complete", message);
    } else {
      sendNotification("WorkBuddy check-in failed", `HTTP ${response.status}: ${message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendNotification("WorkBuddy check-in error", message.slice(0, 160));
  }
}
