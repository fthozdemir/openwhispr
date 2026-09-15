const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const diagnostics = [];
const phoneRemoteModulePath = require.resolve("../../src/helpers/interviewPhoneRemote");
const originalLoad = Module._load;
Module._load = function loadPhoneRemoteWithLoggerStub(request, parent, isMain) {
  if (parent?.filename === phoneRemoteModulePath && request === "./debugLogger") {
    return {
      info: (message, meta, scope) => diagnostics.push({ message, meta, scope }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  InterviewPhoneRemote,
  INTERVIEW_PHONE_REMOTE_ACTIONS,
} = require("../../src/helpers/interviewPhoneRemote");
Module._load = originalLoad;

const labels = {
  language: "en",
  title: "Interview remote",
  description: "Choose the context for the next answer.",
  conversation: "Conversation",
  screenshot: "Screenshot",
  screenshotConversation: "Screenshot + conversation",
};

test("serves a token-gated LAN page with exactly the three Interview actions", async () => {
  const actions = [];
  diagnostics.length = 0;
  const remote = new InterviewPhoneRemote({
    host: "127.0.0.1",
    addresses: () => ["127.0.0.1"],
    labels: () => labels,
    onAction: (action) => {
      actions.push(action);
      return true;
    },
  });

  const info = await remote.start();
  try {
    const parsed = new URL(info.url);
    assert.match(parsed.pathname, /^\/[a-f0-9]{64}$/u);
    assert.deepEqual(info.urls, [info.url]);

    const page = await fetch(info.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/u);

    const html = await page.text();
    assert.equal((html.match(/<button\b/gu) ?? []).length, 3);
    assert.match(html, /class="action-conversation"[^>]*>Conversation</u);
    assert.match(html, /class="action-screenshot"[^>]*>Screenshot</u);
    assert.match(html, /class="action-screenshot-conversation"[^>]*>Screenshot \+ conversation</u);
    assert.match(html, />Conversation</u);
    assert.match(html, />Screenshot</u);
    assert.match(html, />Screenshot \+ conversation</u);
    assert.doesNotMatch(html, /transcript|answer body|api[- ]?key/iu);
    assert.doesNotMatch(html, /<script\b|<link\b/iu);
    assert.doesNotMatch(html, /<iframe\b|target=/iu);

    for (const action of INTERVIEW_PHONE_REMOTE_ACTIONS) {
      const response = await fetch(`${info.url}/${action}`, {
        method: "POST",
        redirect: "manual",
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), parsed.pathname);
      assert.equal(await response.text(), "");
    }
    assert.deepEqual(actions, INTERVIEW_PHONE_REMOTE_ACTIONS);
    assert.deepEqual(
      diagnostics.filter(({ message }) => message === "Phone remote action received"),
      INTERVIEW_PHONE_REMOTE_ACTIONS.map((action) => ({
        message: "Phone remote action received",
        meta: { action },
        scope: "interview",
      }))
    );
  } finally {
    await remote.stop();
  }

  await assert.rejects(fetch(info.url));
});

test("rejects unknown paths, query strings, and request bodies", async () => {
  const actions = [];
  const remote = new InterviewPhoneRemote({
    host: "127.0.0.1",
    addresses: () => ["127.0.0.1"],
    labels: () => labels,
    onAction: (action) => {
      actions.push(action);
      return true;
    },
  });

  const info = await remote.start();
  try {
    assert.equal((await fetch(`${info.url}?probe=1`)).status, 400);
    assert.equal((await fetch(`${info.url}/unknown`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${info.url}/conversation`)).status, 405);
    assert.equal(
      (
        await fetch(`${info.url}/conversation`, {
          method: "POST",
          body: "unexpected content",
        })
      ).status,
      400
    );
    assert.deepEqual(actions, []);
  } finally {
    await remote.stop();
  }
});

test("returns to the remote page when an Interview action is unavailable", async () => {
  const remote = new InterviewPhoneRemote({
    host: "127.0.0.1",
    addresses: () => ["127.0.0.1"],
    labels: () => labels,
    onAction: () => false,
  });

  const info = await remote.start();
  try {
    const response = await fetch(`${info.url}/screenshot`, {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), new URL(info.url).pathname);
    assert.equal(await response.text(), "");
  } finally {
    await remote.stop();
  }
});

test("refuses to publish a loopback URL when no LAN address is available", async () => {
  const remote = new InterviewPhoneRemote({
    host: "127.0.0.1",
    addresses: () => [],
    labels: () => labels,
    onAction: () => true,
  });

  await assert.rejects(remote.start(), /LAN address/u);
  await remote.stop();
});
