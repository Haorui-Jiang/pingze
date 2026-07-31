// 平仄格律查询 · 服务端代理（Node 22 原生 http + fetch → 智谱 GLM-5.2）
// 对标 www.zhgc.com/pz/pz.asp，但用大模型实时分析替代逐字字典查表。

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// API Key 改由前端网页输入，经 /api/analyze 请求体传入，服务端不再硬编码。
// 未提供时前端会收到友好的中文报错，不会白屏。
const GLM_MODEL = process.env.GLM_MODEL || 'glm-5.2';
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const SYS_PROMPT = `你是一位精通《平水韵》与诗词格律的学者。用户会提交一段诗词或对联文本（可能含标点、空格）。
请严格按下面的 JSON 格式返回分析结果，不要输出任何多余文字、不要使用 markdown 代码块、不要加解释：

{
  "chars": [{"char":"字","tone":"平|仄|通|？|—"}],
  "form": "文体名称（如 五言律诗 / 七言绝句 / 词牌名 等）",
  "yunbu": ["韵部说明（如 下平七阳）"],
  "note": "一句简短的格律点评"
}

规则：
- tone 取值：平（平声）、仄（上/去/入声）、通（多音字跨平仄）、？（未定，极罕见）、—（非汉字：标点 / 数字 / 字母 / 空格，统一用 —）。
- 逐字对应输入文本顺序；标点与空格也占一位，标为 —。
- 文体须依据句数、每句字数、对仗、押韵判定（如 五言律诗、七言绝句、词牌 等）。
- 韵部按《平水韵》给出（如 上平一东、下平七阳），多韵则列多个。
- 只返回纯 JSON，第一字符必须是 { ，最后字符是 } 。`;

function extractJSON(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  // 去掉可能的 ```json 或 ``` 包裹
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('读取前端页面失败');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
        return;
      }
      const { text, apiKey } = parsed;
      if (!text || !String(text).trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请输入要分析的诗词文本' }));
        return;
      }

      if (!apiKey || apiKey === 'YOUR_KEY_HERE') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请在上方输入框填入你的智谱 API Key 后再点击分析（服务端不再硬编码密钥）。' }));
        return;
      }

      const userContent = `【待分析文本】\n${text}`;

      try {
        const r = await fetch(GLM_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + apiKey,
          },
          body: JSON.stringify({
            model: GLM_MODEL,
            messages: [
              { role: 'system', content: SYS_PROMPT },
              { role: 'user', content: userContent },
            ],
            temperature: 0.3,
          }),
        });

        if (!r.ok) {
          const detail = await r.text();
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `智谱 GLM 调用失败（HTTP ${r.status}）`, detail }));
          return;
        }

        const data = await r.json();
        const content = data.choices?.[0]?.message?.content ?? '';
        const clean = extractJSON(content);
        if (!clean) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'GLM 返回内容不是可解析的 JSON', raw: content.slice(0, 500) }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(content);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务端异常', detail: String(e) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`平仄格律查询站已启动 → http://localhost:${PORT}`);
  console.log('注：API Key 由前端网页输入，经 /api/analyze 请求体传入，服务端不再硬编码。');
});
