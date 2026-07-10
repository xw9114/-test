# 学习通 AI 答题助手

`chaoxing-ai.user.js` 是一个直接运行在学习通网页中的 Tampermonkey 用户脚本。它读取当前页面及题目 iframe 的题干、选项、公式和图片，调用 OpenAI 兼容的 Chat Completions API，然后回填答案。

## 安装

1. 在 Edge 或 Chrome 中安装 Tampermonkey。
2. 打开 Tampermonkey 管理面板，新建脚本。
3. 用 [`chaoxing-ai.user.js`](./chaoxing-ai.user.js) 的完整内容替换编辑器内容并保存。
4. 登录学习通并进入作业、章节测验或练习页面。

页面右上角会出现“学习通答题助手”面板。脚本支持以下域名：

- `*.chaoxing.com`
- `*.chaoxing.cn`
- `*.chaoxing.net`
- `*.xueyinonline.com`

学校使用独立域名时，需要在 userscript 头部补充对应的 `@match`。

## API 配置

面板接受 OpenAI 兼容配置：

| 字段 | 示例 |
| --- | --- |
| API Base URL | `https://api.openai.com/v1` |
| API Key | `sk-...` |
| Model | `gpt-4.1-mini` |
| 并发数 | `2` |
| 超时 | `60000` |
| 最低置信度 | `0.70` |

Base URL 可以填写到 `/v1`，也可以直接填写完整的 `/chat/completions` 地址。DeepSeek、硅基流动等服务只要兼容 Chat Completions 请求和 `choices[0].message.content` 响应结构即可。

API Key 使用 `GM_setValue` 保存在 Tampermonkey 脚本存储中，不写入学习通页面的 `localStorage`，也不会输出到运行日志。

## 使用

1. 进入题目页面并等待题目加载完成。
2. 填写 API 配置。
3. 根据需要开启或关闭“自动翻页并提交”。
4. 点击“开始答题”，核对确认框后启动。

脚本支持单选、多选、判断、填空和简答题。图片会读取为 data URL 并按 OpenAI multimodal 格式发送，因此图片题需要选择支持视觉输入的模型。图片读取失败但存在有效 `alt` 时会改用替代文本；两者都不可用时停止提交。

只有当前页面所有题目成功解析、成功回填且模型置信度达到阈值时，脚本才会继续翻页或提交。按钮无法唯一识别、页面重复、API 超时、答案格式错误或任意题目回填失败时都会停止。

## AI 返回格式

脚本要求模型返回一个 JSON 对象：

```json
{
  "questionId": "q1",
  "type": "single",
  "answerKeys": ["A"],
  "fillAnswers": [],
  "shortAnswer": "",
  "explanation": "计算或判断依据",
  "confidence": 0.95
}
```

首次响应无法解析或不符合题型约束时，脚本会携带错误原因重试一次。部分兼容服务不支持 `response_format`，收到 `400`、`404` 或 `422` 时会自动移除该字段重试。

## 本地测试

```powershell
npm.cmd test
```

测试只访问本机 fixture，不会登录学习通，也不会向真实 API 发请求。

