const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");
const USERSCRIPT = fs.readFileSync(path.join(ROOT, "chaoxing-ai.user.js"), "utf8");
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixture.html"));
const FRAME = fs.readFileSync(path.join(__dirname, "frame.html"));
const EDGE_PATH = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

let browser;
let topServer;
let frameServer;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function installMockEnvironment(page, { timeout = false, autoSubmit = true } = {}) {
  return page.evaluateOnNewDocument((timeoutMode, shouldSubmit) => {
    const settings = {
      baseUrl: "https://mock.openai.local/v1",
      apiKey: "test-key",
      model: "mock-vision-model",
      timeoutMs: 1000,
      concurrency: 2,
      confidenceThreshold: 0.7,
      autoSubmit: shouldSubmit,
    };
    const store = new Map([["cxai_settings_v1", settings]]);
    globalThis.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
    globalThis.GM_setValue = (key, value) => store.set(key, value);
    globalThis.confirm = () => true;
    globalThis.__mockApiBodies = [];
    globalThis.__questionAttempts = {};
    globalThis.GM_xmlhttpRequest = (options) => {
      if (options.method === "GET") {
        setTimeout(() => options.onload({ status: 200, response: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }) }), 5);
        return;
      }
      if (timeoutMode) {
        setTimeout(() => options.ontimeout(), 15);
        return;
      }
      const body = JSON.parse(options.data);
      globalThis.__mockApiBodies.push(body);
      const userContent = body.messages[1].content;
      const textPart = typeof userContent === "string"
        ? userContent
        : userContent.find((part) => part.type === "text")?.text || "";
      const questionId = textPart.match(/questionId:\s*([^\n]+)/)?.[1] || "unknown";
      const count = (globalThis.__questionAttempts[questionId] || 0) + 1;
      globalThis.__questionAttempts[questionId] = count;

      if (/2 \+ 2/.test(textPart) && body.response_format && !globalThis.__formatRejected) {
        globalThis.__formatRejected = true;
        setTimeout(() => options.onload({ status: 400, responseText: JSON.stringify({ error: { message: "response_format unsupported" } }) }), 5);
        return;
      }

      let answer;
      if (/2 \+ 2/.test(textPart)) answer = { answerKeys: ["A"] };
      else if (/质数/.test(textPart)) answer = { answerKeys: ["A", "C"] };
      else if (/地球围绕太阳/.test(textPart)) answer = { answerKeys: ["A"] };
      else if (/法国首都/.test(textPart)) {
        if (count === 1) {
          setTimeout(() => options.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: "not-json" } }] }) }), 5);
          return;
        }
        answer = { fillAnswers: ["巴黎", "4"] };
      } else if (/单元测试/.test(textPart)) answer = { shortAnswer: "单元测试可以验证行为并降低回归风险。" };
      else if (/我国的首都/.test(textPart)) answer = { answerKeys: ["B"] };
      else if (/固定选项节点/.test(textPart)) answer = { answerKeys: ["B"] };
      else if (/颜色/.test(textPart)) answer = { answerKeys: ["B"] };
      else answer = { answerKeys: ["A"] };

      const type = textPart.match(/type:\s*([^\n]+)/)?.[1] || "single";
      const content = JSON.stringify({
        questionId,
        type,
        answerKeys: answer.answerKeys || [],
        fillAnswers: answer.fillAnswers || [],
        shortAnswer: answer.shortAnswer || "",
        explanation: "fixture explanation",
        confidence: 0.95,
      });
      setTimeout(() => options.onload({
        status: 200,
        responseText: JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
      }), 5);
    };
  }, timeout, autoSubmit);
}

async function injectUserscript(page) {
  await page.evaluateOnNewDocument(USERSCRIPT);
}

async function clickStart(page) {
  await page.waitForFunction(() => document.querySelector("#cx-ai-panel-host")?.shadowRoot?.querySelector("#start"));
  await page.evaluate(() => document.querySelector("#cx-ai-panel-host").shadowRoot.querySelector("#start").click());
}

test.before(async () => {
  topServer = http.createServer((request, response) => {
    if (request.url.startsWith("/empty")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset='utf-8'><title>Empty fixture</title><main>没有题目的测试页面</main><iframe src='about:blank'></iframe>");
      return;
    }
    if (request.url.startsWith("/timeout")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset='utf-8'><section class='question-item'><h3 class='question-title'>单选题：超时测试</h3><label><input type='radio' name='q'>A. A</label><label><input type='radio' name='q'>B. B</label></section>");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  frameServer = http.createServer((request, response) => {
    if (request.url === "/pixel.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(Buffer.from([137, 80, 78, 71]));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FRAME);
  });
  await Promise.all([listen(topServer, 32101), listen(frameServer, 32102)]);
  browser = await puppeteer.launch({ headless: true, executablePath: EDGE_PATH, args: ["--no-sandbox"] });
});

test.after(async () => {
  if (browser) await browser.close();
  await Promise.all([close(topServer), close(frameServer)]);
});

test("fills all common question types across an iframe and submits", async () => {
  const page = await browser.newPage();
  await installMockEnvironment(page);
  await injectUserscript(page);
  await page.goto("http://127.0.0.1:32101/fixture", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.readyState === undefined || document.querySelector("iframe")?.contentWindow);

  const child = page.frames().find((frame) => frame.url().includes(":32102/frame.html"));
  assert.ok(child, "cross-origin fixture frame should load");

  await page.evaluate(() => {
    document.querySelector("iframe").contentWindow.postMessage({
      channel: "cx-ai-v1",
      type: "RPC",
      token: "invalid-token",
      frameId: "invalid-frame",
      requestId: "spoof",
      command: "FILL",
      payload: { questionId: "unknown", answer: { answerKeys: ["A"] } },
    }, "*");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await child.$eval("input[value='A']", (input) => input.checked), false, "spoofed message must be ignored");

  await clickStart(page);
  await page.waitForFunction(() => document.documentElement.dataset.submitted === "true", { timeout: 15000 });

  assert.match(await page.evaluate(() => document.querySelector("#cx-ai-panel-host").shadowRoot.querySelector("h2").textContent), /v1\.0\.3/);

  assert.equal(await page.$eval("#single input[value='A']", (input) => input.checked), true);
  assert.deepEqual(await page.$$eval("#multiple input:checked", (inputs) => inputs.map((input) => input.value)), ["A", "C"]);
  assert.equal(await page.$eval("#judgement input[value='A']", (input) => input.checked), true);
  assert.deepEqual(await page.$$eval("#fill input", (inputs) => inputs.map((input) => input.value)), ["巴黎", "4"]);
  assert.match(await page.$eval("#short textarea", (input) => input.value), /回归风险/);
  assert.equal(await page.$eval("#custom-single .custom-option.selected .custom-key", (element) => element.textContent), "B");
  assert.equal(await page.$eval("#chaoxing-homework-single li:nth-child(2) input", (input) => input.checked), true);
  assert.equal(await child.$eval("input[value='B']", (input) => input.checked), true);

  const evidence = await page.evaluate(() => ({
    bodies: globalThis.__mockApiBodies,
    attempts: globalThis.__questionAttempts,
    events: globalThis.__events,
  }));
  assert.ok(evidence.bodies.some((body) => Array.isArray(body.messages[1].content) && body.messages[1].content.some((part) => part.type === "image_url")), "image should be sent as multimodal content");
  const homeworkRequest = evidence.bodies.find((body) => {
    const content = body.messages[1].content;
    const text = typeof content === "string" ? content : content.find((part) => part.type === "text")?.text || "";
    return text.includes("固定选项节点");
  });
  assert.ok(homeworkRequest, "Chaoxing homework question should be sent to the API");
  assert.match(homeworkRequest.messages[1].content, /type: single[\s\S]*A\. 随机 div[\s\S]*B\. answer_p/);
  assert.ok(evidence.bodies.some((body) => body.response_format === undefined), "unsupported response_format should be retried without it");
  assert.ok(Object.values(evidence.attempts).some((count) => count >= 2), "invalid JSON should trigger a retry");
  assert.ok(evidence.events.input >= 3, "text controls should emit input events");
  assert.ok(evidence.events.change >= 7, "filled controls should emit change events");
  await page.close();
});

test("stops without filling or submitting when the API times out", async () => {
  const page = await browser.newPage();
  await installMockEnvironment(page, { timeout: true, autoSubmit: true });
  await injectUserscript(page);
  await page.goto("http://127.0.0.1:32101/timeout", { waitUntil: "domcontentloaded" });
  await clickStart(page);
  await page.waitForFunction(() => {
    const host = document.querySelector("#cx-ai-panel-host");
    return host?.shadowRoot?.querySelector("#state")?.textContent.includes("处理失败");
  }, { timeout: 8000 });
  assert.equal(await page.$eval("input:checked", (input) => Boolean(input)).catch(() => false), false);
  assert.notEqual(await page.evaluate(() => document.documentElement.dataset.submitted), "true");
  await page.close();
});

test("prints selector and iframe diagnostics when no questions are found", async () => {
  const page = await browser.newPage();
  await installMockEnvironment(page, { autoSubmit: false });
  await injectUserscript(page);
  await page.goto("http://127.0.0.1:32101/empty", { waitUntil: "domcontentloaded" });
  await clickStart(page);
  await page.waitForFunction(() => {
    const root = document.querySelector("#cx-ai-panel-host")?.shadowRoot;
    return root?.querySelector("#log")?.textContent.includes("扫描诊断");
  }, { timeout: 8000 });
  const log = await page.evaluate(() => document.querySelector("#cx-ai-panel-host").shadowRoot.querySelector("#log").textContent);
  assert.match(log, /questionLi=0 mark_name=0 answer_p=0 answertype=0/);
  assert.match(log, /iframes=1/);
  assert.equal(await page.evaluate(() => globalThis.__mockApiBodies.length), 0);
  await page.close();
});
