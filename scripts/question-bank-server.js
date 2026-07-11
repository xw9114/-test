#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const bankPath = path.resolve(process.argv[2] || path.join(ROOT, "data", "question-bank.json"));
const port = Number(process.env.PORT || process.argv[3] || 32109);

function normalize(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[“”"']/g, "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。；;：:、,.!?！？()（）【】\[\]]/g, "")
    .toLowerCase();
}

function similarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length) >= 0.65 ? 0.95 : 0.5;
  }
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function loadBank(file) {
  if (!fs.existsSync(file)) {
    console.error(`题库文件不存在：${file}`);
    console.error(`可先复制示例：copy data\\question-bank.sample.json data\\question-bank.json`);
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  return records.map((record, index) => ({
    ...record,
    id: record.id || crypto.createHash("sha1").update(`${record.question}|${index}`).digest("hex").slice(0, 12),
    normalizedQuestion: normalize(record.question),
    normalizedOptions: (record.options || []).map((option) => normalize(option.text)),
  }));
}

const bank = loadBank(bankPath);

function scoreRecord(record, query) {
  const questionScore = similarity(query.question, record.question);
  const queryOptions = query.options || [];
  let optionScore = 0;
  if (queryOptions.length && record.options?.length) {
    const scores = queryOptions.map((queryOption) => Math.max(...record.options.map((option) => similarity(queryOption.text, option.text))));
    optionScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  }
  const typeScore = !query.type || !record.type || query.type === record.type ? 1 : 0.5;
  return questionScore * 0.72 + optionScore * 0.22 + typeScore * 0.06;
}

function queryBank(query) {
  const ranked = bank
    .map((record) => ({ record, score: scoreRecord(record, query) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.78) return { hit: false, bestScore: best?.score || 0 };
  const second = ranked[1];
  const conflict = second && second.score > 0.78 && best.score - second.score < 0.03;
  if (conflict) {
    return {
      hit: false,
      conflict: true,
      bestScore: best.score,
      candidates: ranked.slice(0, 3).map(({ record, score }) => ({ id: record.id, source: record.source, score })),
    };
  }
  return {
    hit: true,
    id: best.record.id,
    source: best.record.source || "local-bank",
    confidence: Math.min(0.99, Math.max(0.72, best.score)),
    answerKeys: best.record.answerKeys || [],
    answerTexts: best.record.answerTexts || [],
    fillAnswers: best.record.fillAnswers || [],
    shortAnswer: best.record.shortAnswer || "",
    score: best.score,
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, records: bank.length }));
    return;
  }
  if (request.method !== "POST" || !request.url.startsWith("/query")) {
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  try {
    const query = await readJson(request);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(queryBank(query)));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Question bank server: http://127.0.0.1:${port}/query`);
  console.log(`Loaded ${bank.length} records from ${bankPath}`);
});
