const fs = require("fs");
const path = require("path");
const readline = require("readline");
const puppeteer = require("puppeteer");

const EDGE_PATH = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const WORK_DIR = __dirname;
const OUTPUT_DIR = path.join(WORK_DIR, "output");
const USER_DATA_DIR = path.join(WORK_DIR, ".edge-profile");

const START_URL =
  process.argv[2] ||
  "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractFrame(frame) {
  return frame.evaluate(() => {
    const normalizeText = (value) =>
      String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t\r\f\v]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    const textOf = (el) => normalizeText(el?.innerText || el?.textContent || "");

    const uniq = (arr) => [...new Set(arr.filter(Boolean))];

    const blockSelectors = [
      ".TiMu",
      ".Cy_TItle",
      ".Zy_TItle",
      ".questionLi",
      ".question-li",
      ".question-item",
      ".question",
      ".stem_answer",
      ".subject-item",
      "li[id*='question']",
      "div[id*='question']",
      "li",
    ];

    const optionSelectors = [
      "li",
      ".option",
      ".answerOption",
      ".stem_answer li",
      ".Py_answer li",
      ".clearfix",
      "label",
    ];

    const stemSelectors = [
      ".Zy_TItle",
      ".Cy_TItle",
      ".clearfix",
      ".question-title",
      ".stem",
      ".title",
      ".subject",
      "h1,h2,h3,h4",
    ];

    const looksLikeQuestion = (text) => {
      if (!text || text.length < 8) return false;
      return (
        /(^|\n|\s)(单选题|多选题|判断题|填空题|简答题|选择题|题目|第\s*\d+\s*题)/.test(text) ||
        /[A-D][\.．、)]\s*\S+/.test(text) ||
        /正确|错误|对|错/.test(text)
      );
    };

    const detectType = (text, block) => {
      if (/多选题/.test(text)) return "多选题";
      if (/单选题/.test(text)) return "单选题";
      if (/判断题/.test(text)) return "判断题";
      if (/填空题/.test(text)) return "填空题";
      if (/简答题|问答题|论述题/.test(text)) return "主观题";

      const checkboxCount = block.querySelectorAll("input[type='checkbox']").length;
      const radioCount = block.querySelectorAll("input[type='radio']").length;
      const textInputCount = block.querySelectorAll(
        "input[type='text'], textarea"
      ).length;

      if (checkboxCount > 0) return "多选题";
      if (radioCount > 0) return "单选/判断题";
      if (textInputCount > 0) return "填空/主观题";
      return "未知";
    };

    const parseOptions = (block) => {
      const candidates = [];
      for (const selector of optionSelectors) {
        block.querySelectorAll(selector).forEach((el) => {
          const text = textOf(el);
          if (/^[A-H][\.．、)]?\s*\S+/.test(text) || /^(正确|错误|对|错)$/.test(text)) {
            candidates.push(text);
          }
        });
      }

      const whole = textOf(block);
      const inline = whole.match(/[A-H][\.．、)]\s*[^A-H\n]{1,120}/g) || [];
      return uniq([...candidates, ...inline]).slice(0, 12);
    };

    const parseStem = (block, wholeText, options) => {
      const stems = [];
      for (const selector of stemSelectors) {
        block.querySelectorAll(selector).forEach((el) => {
          const text = textOf(el);
          if (text && text.length >= 4) stems.push(text);
        });
      }

      let stem = stems.find((s) => !/^[A-H][\.．、)]/.test(s)) || wholeText;
      for (const option of options) {
        stem = stem.replace(option, "");
      }
      return normalizeText(stem).slice(0, 1200);
    };

    const parseFilledAnswer = (block) => {
      const answers = [];
      block
        .querySelectorAll("input[type='radio']:checked,input[type='checkbox']:checked")
        .forEach((el) => {
          const label =
            el.closest("label") ||
            el.parentElement ||
            document.querySelector(`label[for='${el.id}']`);
          answers.push(textOf(label) || el.value || el.name);
        });

      block.querySelectorAll("input[type='text'], textarea").forEach((el) => {
        if (normalizeText(el.value)) answers.push(normalizeText(el.value));
      });

      const text = textOf(block);
      const answerMatch = text.match(/(?:正确答案|参考答案|答案)\s*[:：]\s*([^\n]+)/);
      if (answerMatch) answers.push(answerMatch[1].trim());

      return uniq(answers);
    };

    const blocks = [];
    const seen = new Set();

    for (const selector of blockSelectors) {
      document.querySelectorAll(selector).forEach((el) => {
        if (seen.has(el)) return;
        const text = textOf(el);
        if (!looksLikeQuestion(text)) return;

        // 避免把整页容器误识别为一道题。
        if (text.length > 4000 && el.querySelectorAll("input,textarea").length > 15) {
          return;
        }

        seen.add(el);
        const options = parseOptions(el);
        blocks.push({
          type: detectType(text, el),
          stem: parseStem(el, text, options),
          options,
          filledAnswer: parseFilledAnswer(el),
          rawText: text.slice(0, 2000),
        });
      });
    }

    return {
      title: document.title,
      url: location.href,
      questions: blocks,
    };
  });
}

async function extractAllQuestions(page) {
  const frames = page.frames();
  const results = [];

  for (const frame of frames) {
    try {
      const data = await extractFrame(frame);
      if (data.questions.length > 0) {
        results.push({
          frameUrl: frame.url(),
          frameTitle: data.title,
          questions: data.questions,
        });
      }
    } catch (error) {
      results.push({
        frameUrl: frame.url(),
        error: error.message,
        questions: [],
      });
    }
  }

  const questions = [];
  for (const result of results) {
    for (const question of result.questions) {
      questions.push({
        frameUrl: result.frameUrl,
        ...question,
      });
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    pageTitle: await page.title(),
    frameCount: frames.length,
    questions,
    frames: results.map((item) => ({
      frameUrl: item.frameUrl,
      frameTitle: item.frameTitle,
      questionCount: item.questions.length,
      error: item.error,
    })),
  };
}

function toMarkdown(data) {
  const lines = [];
  lines.push(`# 学习通题目采集`);
  lines.push("");
  lines.push(`- 页面：${data.pageTitle}`);
  lines.push(`- URL：${data.pageUrl}`);
  lines.push(`- 时间：${data.capturedAt}`);
  lines.push(`- 题目数：${data.questions.length}`);
  lines.push("");

  data.questions.forEach((q, index) => {
    lines.push(`## ${index + 1}. ${q.type}`);
    lines.push("");
    lines.push(q.stem || "(未识别到题干)");
    lines.push("");
    if (q.options.length > 0) {
      lines.push(`**选项：**`);
      q.options.forEach((option) => lines.push(`- ${option}`));
      lines.push("");
    }
    if (q.filledAnswer.length > 0) {
      lines.push(`**页面已填/已显示答案：** ${q.filledAnswer.join("；")}`);
      lines.push("");
    }
    lines.push(`<details><summary>原始文本</summary>`);
    lines.push("");
    lines.push("```text");
    lines.push(q.rawText);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  });

  return lines.join("\n");
}

function writePracticeHtml(data, htmlFile) {
  const payload = JSON.stringify(data.questions, null, 2).replace(
    /</g,
    "\\u003c"
  );

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>本地刷题练习</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f7f9; margin:0; color:#172033; }
    main { max-width: 980px; margin: 32px auto; padding: 0 20px 48px; }
    .card { background:#fff; border:1px solid #e7eaf0; border-radius:14px; padding:20px; margin:16px 0; box-shadow:0 8px 24px rgba(20,30,50,.05); }
    .meta { color:#667085; font-size:13px; margin-bottom:8px; }
    .stem { white-space:pre-wrap; line-height:1.7; font-size:16px; }
    .option { display:block; margin:10px 0; padding:10px 12px; border:1px solid #d8deea; border-radius:10px; background:#fbfcff; cursor:pointer; }
    .toolbar { position:sticky; top:0; background:rgba(246,247,249,.92); backdrop-filter: blur(10px); padding:14px 0; z-index:2; }
    button { border:0; border-radius:10px; padding:10px 14px; background:#2563eb; color:#fff; cursor:pointer; }
    textarea { width:100%; min-height:80px; border:1px solid #d8deea; border-radius:10px; padding:10px; }
    .answer { display:none; margin-top:10px; color:#047857; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:10px; padding:10px; }
    .empty { color:#b45309; background:#fffbeb; border:1px solid #fde68a; }
  </style>
</head>
<body>
<main>
  <div class="toolbar">
    <h1>本地刷题练习</h1>
    <button onclick="toggleAnswers()">显示/隐藏页面已有答案</button>
  </div>
  <div id="app"></div>
</main>
<script>
const questions = ${payload};
let show = false;
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function render(){
  const app = document.querySelector('#app');
  app.innerHTML = questions.map((q,i)=>{
    const opts = (q.options||[]).map(o=>'<label class="option"><input type="'+((q.type||'').includes('多选')?'checkbox':'radio')+'" name="q'+i+'"> '+escapeHtml(o)+'</label>').join('');
    const answer = (q.filledAnswer||[]).length ? escapeHtml(q.filledAnswer.join('；')) : '未在页面识别到答案，请自行作答后订正。';
    const answerClass = (q.filledAnswer||[]).length ? 'answer' : 'answer empty';
    return '<section class="card"><div class="meta">第 '+(i+1)+' 题 · '+escapeHtml(q.type)+' · 来源 iframe: '+escapeHtml(q.frameUrl||'')+'</div><div class="stem">'+escapeHtml(q.stem||'(未识别到题干)')+'</div>'+opts+(opts?'':'<textarea placeholder="在这里写你的答案"></textarea>')+'<div class="'+answerClass+'" style="display:'+(show?'block':'none')+'">参考：'+answer+'</div></section>';
  }).join('');
}
function toggleAnswers(){ show = !show; render(); }
render();
</script>
</body>
</html>`;

  fs.writeFileSync(htmlFile, html, "utf8");
}

async function main() {
  ensureDir(OUTPUT_DIR);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: EDGE_PATH,
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("");
  console.log("已打开 Edge。请手动登录学习通，并进入需要整理的作业/章节测验/练习页面。");
  console.log("进入页面后，回到终端按 Enter 开始采集题目。");
  await ask("按 Enter 开始采集...");

  // 给动态 iframe 和题目区域一点加载时间。
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const data = await extractAllQuestions(page);
  const id = timestamp();
  const jsonFile = path.join(OUTPUT_DIR, `questions-${id}.json`);
  const mdFile = path.join(OUTPUT_DIR, `questions-${id}.md`);
  const htmlFile = path.join(OUTPUT_DIR, `practice-${id}.html`);

  fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2), "utf8");
  fs.writeFileSync(mdFile, toMarkdown(data), "utf8");
  writePracticeHtml(data, htmlFile);

  console.log("");
  console.log(`采集完成：${data.questions.length} 道题`);
  console.log(`JSON：${jsonFile}`);
  console.log(`Markdown：${mdFile}`);
  console.log(`本地练习页：${htmlFile}`);

  const openPractice = (await ask("是否打开本地练习页？输入 y 打开：")).trim().toLowerCase();
  if (openPractice === "y" || openPractice === "yes") {
    await page.goto(`file:///${htmlFile.replace(/\\/g, "/")}`);
  }

  console.log("浏览器保持打开；需要退出时直接关闭窗口或按 Ctrl+C。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
