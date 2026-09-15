const crypto = require("crypto");
const http = require("http");
const os = require("os");
const debugLogger = require("./debugLogger");

const INTERVIEW_PHONE_REMOTE_ACTIONS = Object.freeze([
  "conversation",
  "screenshot",
  "screenshot-conversation",
]);
const DEFAULT_HOST = "0.0.0.0";
const TOKEN_BYTES = 32;
const MAX_REQUEST_BODY_BYTES = 1024;
const PAGE_STYLE = `
  :root {
    color-scheme: dark;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: #17181c;
    color: #f1f2f5;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body { margin: 0; padding: 24px; }
  main { display: grid; gap: 20px; max-width: 36rem; margin: 0 auto; }
  h1 { margin: 0 0 8px; font-size: 24px; font-weight: 700; }
  p { margin: 0; color: #b5bac7; font-size: 15px; }
  form { margin: 0; }
  button {
    width: 100%;
    min-height: 104px;
    border: 2px solid transparent;
    border-radius: 16px;
    color: #fff;
    font: inherit;
    font-size: 24px;
    font-weight: 700;
    cursor: pointer;
    touch-action: manipulation;
    box-shadow: 0 10px 28px rgb(0 0 0 / 28%);
    transition: filter 120ms ease, transform 120ms ease;
  }
  button:active { filter: brightness(.84); transform: scale(.985); }
  button:focus-visible { outline: 4px solid #fff; outline-offset: 3px; }
  .action-conversation { background: #2563eb; border-color: #60a5fa; }
  .action-screenshot { background: #7c3aed; border-color: #c084fc; }
  .action-screenshot-conversation { background: #059669; border-color: #34d399; }
`;
const PAGE_STYLE_HASH = crypto.createHash("sha256").update(PAGE_STYLE, "utf8").digest("base64");
const PAGE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  `style-src 'sha256-${PAGE_STYLE_HASH}'`,
].join("; ");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!addresses.includes(entry.address)) addresses.push(entry.address);
    }
  }
  return addresses;
}

function responseHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function sendEmpty(response, statusCode) {
  response.writeHead(statusCode, { ...responseHeaders(), "Content-Length": "0" });
  response.end();
}

function renderPage(token, labels) {
  const actionLabels = {
    conversation: labels.conversation,
    screenshot: labels.screenshot,
    "screenshot-conversation": labels.screenshotConversation,
  };
  const forms = INTERVIEW_PHONE_REMOTE_ACTIONS.map(
    (action) => `
      <form method="post" action="/${token}/${action}">
        <button class="action-${action}" type="submit">${escapeHtml(actionLabels[action])}</button>
      </form>`
  ).join("");

  return `<!doctype html>
<html lang="${escapeHtml(labels.language || "en")}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(labels.title)}</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <main>
      <header>
        <h1>${escapeHtml(labels.title)}</h1>
        <p>${escapeHtml(labels.description)}</p>
      </header>${forms}
    </main>
  </body>
</html>`;
}

function requestLocation(request) {
  if (typeof request.url !== "string") return null;
  try {
    const parsed = new URL(request.url, "http://openwhispr.remote");
    return { pathname: parsed.pathname, hasQuery: parsed.search.length > 0 };
  } catch {
    return null;
  }
}

function consumeEmptyBody(request) {
  return new Promise((resolve) => {
    let bytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BODY_BYTES) finish(false);
    });
    request.once("end", () => finish(bytes === 0));
    request.once("aborted", () => finish(false));
    request.once("error", () => finish(false));
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Interview phone remote did not expose a TCP port."));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

class InterviewPhoneRemote {
  constructor({ onAction, labels, host = DEFAULT_HOST, port = 0, addresses = getLanAddresses }) {
    this.onAction = onAction;
    this.labels = labels;
    this.host = host;
    this.port = port;
    this.addresses = addresses;
    this.server = null;
    this.token = null;
    this.startOperation = null;
    this.urls = [];
  }

  async start() {
    if (this.startOperation) return this.startOperation;
    if (this.server && this.token && this.urls.length > 0) {
      return { url: this.urls[0], urls: [...this.urls] };
    }

    const operation = this._start();
    this.startOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.startOperation === operation) this.startOperation = null;
    }
  }

  async _start() {
    const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    const server = http.createServer((request, response) => {
      void this._handle(request, response);
    });
    this.server = server;
    this.token = token;

    try {
      const port = await listen(server, this.port, this.host);
      const addresses = this.addresses();
      if (addresses.length === 0) throw new Error("No LAN address is available.");
      this.urls = addresses.map((address) => `http://${address}:${port}/${token}`);
      return { url: this.urls[0], urls: [...this.urls] };
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      this.server = null;
      this.token = null;
      this.urls = [];
      throw error;
    }
  }

  async stop() {
    const starting = this.startOperation;
    if (starting) await starting.catch(() => undefined);
    const server = this.server;
    this.server = null;
    this.token = null;
    this.urls = [];
    if (server) await closeServer(server).catch(() => undefined);
  }

  async _handle(request, response) {
    const token = this.token;
    if (!token || !this.server) {
      sendEmpty(response, 503);
      return;
    }

    const location = requestLocation(request);
    if (!location || location.hasQuery) {
      sendEmpty(response, 400);
      return;
    }

    const pagePath = `/${token}`;
    if (request.method === "GET" && location.pathname === pagePath) {
      const page = Buffer.from(renderPage(token, this.labels()), "utf8");
      response.writeHead(200, {
        ...responseHeaders("text/html; charset=utf-8"),
        "Content-Security-Policy": PAGE_CSP,
        "Content-Length": String(page.byteLength),
      });
      response.end(page);
      return;
    }

    if (request.method !== "POST") {
      sendEmpty(response, 405);
      return;
    }

    const action = INTERVIEW_PHONE_REMOTE_ACTIONS.find(
      (candidate) => location.pathname === `${pagePath}/${candidate}`
    );
    if (!action) {
      sendEmpty(response, 404);
      return;
    }

    if (!(await consumeEmptyBody(request))) {
      sendEmpty(response, 400);
      return;
    }

    debugLogger.info("Phone remote action received", { action }, "interview");
    try {
      await this.onAction(action);
    } catch {}
    response.writeHead(303, {
      ...responseHeaders(),
      Location: pagePath,
      "Content-Length": "0",
    });
    response.end();
  }
}

module.exports = {
  InterviewPhoneRemote,
  INTERVIEW_PHONE_REMOTE_ACTIONS,
};
