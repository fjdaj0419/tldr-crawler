/* ============================================================================
 * TL;DR Crawler — background.js  (Manifest V3 service worker)
 *
 * 只做三件事：
 *   1. 监听工具栏图标点击 → 向当前标签页注入 / 关闭 content.js
 *   2. 代理所有大模型请求（API Key 永远不落到 content script 里）
 *   3. 提供一个"测试连接"接口，供设置页校验 Key 和模型名
 *
 * 支持两家：
 *   - DeepSeek   https://api.deepseek.com   （OpenAI 兼容协议）
 *   - Anthropic  https://api.anthropic.com  （Claude 原生协议）
 *
 * 所有错误一律静默降级：网络失败、超时、非 200、JSON 解析失败、空响应，
 * 统一返回 { ok:false, error }，绝不让页面或蜘蛛停下来。
 * ==========================================================================*/

'use strict';

const TIMEOUT_MS = 45000;   // 摘要最多等 45s：思考模式偶发慢一点也扛得住

const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    modelsEndpoint: 'https://api.deepseek.com/models',
    keyField: 'deepseekKey',
    modelField: 'deepseekModel',
    defaultModel: 'deepseek-flash'
  },
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    endpoint: 'https://api.anthropic.com/v1/messages',
    modelsEndpoint: 'https://api.anthropic.com/v1/models',
    apiVersion: '2023-06-01',
    keyField: 'apiKey',
    modelField: 'model',
    defaultModel: 'claude-sonnet-4-5'
  }
};

/* -------------------------------------------------------------------------
 * 安装时写入默认值（绝不写 Key）
 * 老版本只有 apiKey 没有 provider —— 默认沿用 Anthropic，别把人家配好的搞坏
 * ---------------------------------------------------------------------- */
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get(null, function (r) {
    r = r || {};
    const patch = {};
    const hasAnthropic = !!(r.apiKey && String(r.apiKey).trim());
    const hasDeepSeek = !!(r.deepseekKey && String(r.deepseekKey).trim());
    if (!r.provider) patch.provider = (hasAnthropic && !hasDeepSeek) ? 'anthropic' : 'deepseek';
    if (!r.model) patch.model = PROVIDERS.anthropic.defaultModel;
    if (!r.deepseekModel) patch.deepseekModel = PROVIDERS.deepseek.defaultModel;
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
});

/* -------------------------------------------------------------------------
 * 工具栏点击 → 注入 content.js
 * content.js 自己判断“已运行 / 未运行”，所以这里只管注入。
 * ---------------------------------------------------------------------- */
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || !tab.id) return;
  const url = tab.url || '';
  // chrome:// / edge:// / about: / 扩展页 / Chrome 商店 都不允许注入，直接忽略
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url)) return;
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return;

  chrome.scripting.executeScript(
    { target: { tabId: tab.id }, files: ['content.js'] },
    function () {
      if (chrome.runtime.lastError) {
        // 受限页面（新分页、PDF 阅读器等）注入失败，安静地忽略
        console.warn('[TL;DR] 注入失败：', chrome.runtime.lastError.message);
      }
    }
  );
});

/* -------------------------------------------------------------------------
 * 消息路由
 * ---------------------------------------------------------------------- */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return;
  /* 极轻量探活：不读配置、不发 API，立刻回。
     MV3 的 service worker 会在空闲后被回收，按需调用（大白话）常常撞上冷启动，
     第一次 sendMessage 会因为端口还没建好而拿到 lastError。前端先用它把 SW 唤醒。 */
  if (msg.type === 'PING') {
    sendResponse({ ok: true, pong: true });
    return;
  }
  if (msg.type === 'TLDR_SUMMARIZE') {
    summarizeBatch(msg.sentences || []).then(sendResponse);
    return true; // 异步
  }
  if (msg.type === 'TLDR_VERDICT') {
    verdict(msg.sentences || []).then(sendResponse);
    return true;
  }
  if (msg.type === 'TLDR_PLAIN') {
    /* 大白话是按需调用，触发时机不固定。以前只要 plainChinese 里任何一步抛错，
       Promise 就 reject、sendResponse 永远不执行，前端只收到一个空 res + lastError，
       被翻成没有信息量的「生成失败」。这里保证无论成功失败都一定回一个带错误码的响应。 */
    Promise.resolve()
      .then(function () { return plainChinese(msg.sentences || []); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) {
        sendResponse({ ok: false, error: 'exception', detail: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === 'TLDR_TEST') {
    testConnection().then(sendResponse);
    return true;
  }
  return;
});

/* -------------------------------------------------------------------------
 * 读取配置：provider 决定用哪把 Key、哪个模型
 * ---------------------------------------------------------------------- */
function pickProvider(r) {
  if (!r) return 'deepseek';
  if (r.provider === 'anthropic' || r.provider === 'deepseek') return r.provider;
  // 没存过 provider：有旧 Anthropic Key 就当成 Anthropic，否则走 DeepSeek
  const hasAnthropic = !!(r.apiKey && String(r.apiKey).trim());
  const hasDeepSeek = !!(r.deepseekKey && String(r.deepseekKey).trim());
  return (hasAnthropic && !hasDeepSeek) ? 'anthropic' : 'deepseek';
}

function readConfig() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(null, function (r) {
        const id = pickProvider(r);
        const p = PROVIDERS[id];
        const key = String((r && r[p.keyField]) || '').trim();
        const model = String((r && r[p.modelField]) || '').trim() || p.defaultModel;
        resolve({ provider: id, name: p.name, key: key, model: model });
      });
    } catch (e) {
      resolve({ provider: 'deepseek', name: 'DeepSeek', key: '', model: PROVIDERS.deepseek.defaultModel });
    }
  });
}

/* -------------------------------------------------------------------------
 * 底层请求：超时 / 网络错误 统一收敛
 * ---------------------------------------------------------------------- */
async function request(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
    clearTimeout(timer);
    return { res: res };
  } catch (e) {
    clearTimeout(timer);
    return { error: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
  }
}

/* -------------------------------------------------------------------------
 * 两个协议的请求体 / 响应体差异都收在这两个函数里
 * ---------------------------------------------------------------------- */

/* DeepSeek：OpenAI 兼容，POST /chat/completions + Bearer */
function deepseekHeaders(key) {
  return { 'content-type': 'application/json', authorization: 'Bearer ' + key };
}

function deepseekBody(cfg, prompt, maxTokens, minimal) {
  const body = {
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    stream: false
  };
  if (minimal) return body;   // 兜底：只留必填字段，兼容各种中转端点
  body.max_tokens = maxTokens || 1024;
  body.temperature = 0.1;
  // 新一代 DeepSeek 默认开思考模式，摘要这种活不需要思维链：
  // 关掉能省一大截 token 和等待时间，输出也更稳。
  body.thinking = { type: 'disabled' };
  return body;
}

async function postDeepSeek(cfg, body) {
  const out = await request(PROVIDERS.deepseek.endpoint, {
    method: 'POST',
    headers: deepseekHeaders(cfg.key),
    body: JSON.stringify(body)
  });
  if (out.error) return { ok: false, error: out.error };
  const res = out.res;

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text() || '').slice(0, 300); } catch (e) { /* 忽略 */ }
    return { ok: false, error: 'http-' + res.status, detail: detail };
  }

  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, error: 'bad-json' }; }

  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const text = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content.trim()
    : '';
  if (!text) return { ok: false, error: 'empty' };
  return { ok: true, text: text };
}

/* Claude：原生 /v1/messages + x-api-key */
async function postAnthropic(cfg, prompt, maxTokens) {
  const p = PROVIDERS.anthropic;
  const out = await request(p.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': p.apiVersion,
      // 浏览器环境直连 Anthropic 必须带这个头
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens || 1024,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (out.error) return { ok: false, error: out.error };
  const res = out.res;

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text() || '').slice(0, 300); } catch (e) { /* 忽略 */ }
    return { ok: false, error: 'http-' + res.status, detail: detail };
  }

  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, error: 'bad-json' }; }

  if (!data || !Array.isArray(data.content)) return { ok: false, error: 'empty' };
  let text = '';
  for (let i = 0; i < data.content.length; i++) {
    const part = data.content[i];
    if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
  }
  text = text.trim();
  if (!text) return { ok: false, error: 'empty' };
  return { ok: true, text: text };
}

/* 统一入口：按 provider 分发，返回值都带上 provider/name 方便前端提示 */
async function callModel(prompt, maxTokens) {
  const cfg = await readConfig();
  if (!cfg.key) return { ok: false, error: 'no-key', provider: cfg.provider, name: cfg.name };

  let r;
  if (cfg.provider === 'anthropic') {
    r = await postAnthropic(cfg, prompt, maxTokens);
  } else {
    r = await postDeepSeek(cfg, deepseekBody(cfg, prompt, maxTokens, false));
    // 少数 OpenAI 兼容中转不认 thinking / max_tokens，去掉可选参数重试一次
    if (!r.ok && (r.error === 'http-400' || r.error === 'http-422')) {
      r = await postDeepSeek(cfg, deepseekBody(cfg, prompt, maxTokens, true));
    }
  }
  r.provider = cfg.provider;
  r.name = cfg.name;
  r.model = cfg.model;
  return r;
}

/* -------------------------------------------------------------------------
 * 测试连接：GET /models（不消耗 token），顺便校验模型名在不在列表里
 * ---------------------------------------------------------------------- */
async function testConnection() {
  const cfg = await readConfig();
  if (!cfg.key) return { ok: false, error: 'no-key', provider: cfg.provider, name: cfg.name };

  const p = PROVIDERS[cfg.provider];
  const headers = cfg.provider === 'anthropic'
    ? {
        'x-api-key': cfg.key,
        'anthropic-version': p.apiVersion,
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    : { authorization: 'Bearer ' + cfg.key };

  const out = await request(p.modelsEndpoint, { method: 'GET', headers: headers });
  if (out.error) return { ok: false, error: out.error, provider: cfg.provider, name: cfg.name };

  const res = out.res;
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text() || '').slice(0, 200); } catch (e) { /* 忽略 */ }
    return { ok: false, error: 'http-' + res.status, detail: detail, provider: cfg.provider, name: cfg.name };
  }

  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, error: 'bad-json', provider: cfg.provider, name: cfg.name }; }

  const ids = (data && Array.isArray(data.data) ? data.data : [])
    .map(function (m) { return m && m.id ? String(m.id) : ''; })
    .filter(Boolean);

  return {
    ok: true,
    provider: cfg.provider,
    name: cfg.name,
    model: cfg.model,
    modelKnown: ids.length ? ids.indexOf(cfg.model) !== -1 : true,
    models: ids.slice(0, 8)
  };
}

/* -------------------------------------------------------------------------
 * 从模型输出里抠出 JSON 数组（容忍 ```json 包裹、前后废话）
 * ---------------------------------------------------------------------- */
function parseJsonArray(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  const body = s.slice(start, end + 1);
  try {
    const arr = JSON.parse(body);
    if (!Array.isArray(arr)) return null;
    return arr.map(function (v) { return String(v == null ? '' : v).trim(); });
  } catch (e) {
    // 兜底：按换行切开，去掉序号和引号
    return body
      .replace(/[\[\]]/g, '')
      .split(/\n+/)
      .map(function (l) { return l.replace(/^\s*["'\-\d.)、]+\s*/, '').replace(/["',]\s*$/, '').trim(); })
      .filter(Boolean);
  }
}

/* -------------------------------------------------------------------------
 * 批量摘要 + 蛛网图谱数据：短句 / 所属枝 / 类型 / 页面主题 / 跨枝关联
 * ---------------------------------------------------------------------- */
const WEB_TYPE_KEYS = ['concl', 'data', 'fact', 'view', 'risk', 'time', 'cause', 'quote'];

/* 从模型输出里抠出结构化对象 {"topic","items","links"}（容忍 ```json 包裹、前后废话） */
function parseStructured(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let obj = null;
  const body = s.slice(a, b + 1);
  try {
    obj = JSON.parse(body);
  } catch (e) {
    /* 宽松修复：模型常犯的两类小错——数组/对象尾部多一个逗号、
       用中文引号当字符串引号。修一次再试，别因为一个逗号整张网都不长。 */
    try {
      obj = JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
    } catch (e2) {
      try {
        obj = JSON.parse(
          body
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/,\s*([}\]])/g, '$1')
            /* 模型常把 kw 的值写成不带引号的中文：`"kw": 营收增长,`
               只针对 kw 这一个字段补引号，别动其他字段 */
            .replace(/"kw"\s*:\s*([^",}\]\s][^",}\]]*?)(?=\s*[,}\]])/g, '"kw":"$1"')
        );
      } catch (e3) { return null; }
    }
  }
  if (!obj || !Array.isArray(obj.items)) return null;

  const items = [];
  for (let i = 0; i < obj.items.length; i++) {
    const it = obj.items[i];
    if (!it) continue;
    /* id：模型经常把数字吐成字符串（"1"），两种都收 */
    let id = null;
    if (typeof it.id === 'number' && isFinite(it.id)) id = it.id;
    else if (typeof it.id === 'string' && /^\d+$/.test(it.id.trim())) id = Number(it.id.trim());
    const short = typeof it.short === 'string' ? it.short.trim() : '';
    if (id == null || !short) continue;
    items.push({
      id: id,
      short: short,
      /* kw：2–6 字关键词，只给「词飞入」动效用；模型没给就留空，前端用正则兜底 */
      kw: typeof it.kw === 'string'
        ? it.kw.replace(/[\s"'“”「」『』《》、，。；：!?！？…·]/g, '').trim().slice(0, 6)
        : '',
      branch: (String(it.branch || '').trim().slice(0, 8)) || '其他',
      type: WEB_TYPE_KEYS.indexOf(it.type) !== -1 ? it.type : 'quote'
    });
  }
  if (!items.length) return null;

  const numId = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
    return null;
  };
  const links = [];
  if (Array.isArray(obj.links)) {
    for (let i = 0; i < obj.links.length && links.length < 4; i++) {
      const l = obj.links[i];
      if (!Array.isArray(l) || l.length !== 2) continue;
      const a = numId(l[0]), b = numId(l[1]);
      if (a != null && b != null && a !== b) links.push([a, b]);
    }
  }
  return {
    topic: String(obj.topic || '').trim().slice(0, 16),
    items: items,
    links: links
  };
}

async function summarizeBatch(sentences) {
  const list = sentences
    .map(function (s) {
      return { id: s && s.id, text: String(s && s.text ? s.text : '').replace(/\s+/g, ' ').trim() };
    })
    .filter(function (s) { return s.text.length > 0; })
    .slice(0, 30);

  if (!list.length) return { ok: false, error: 'empty-input' };

  const prompt = [
    '你是网页摘要引擎。输入是一篇文章里摘出的关键句（JSON 数组，每项有 id 和 text）。',
    '为每一句产出四个字段：',
    '1. short：极短摘要。最多 9 个单词（中文最多 14 个字）；保留原文的数字、人名、公司名，数字必须与原文完全一致，不得改写、不得四舍五入；不得夸大、不得推断；',
    '2. branch：这句话所属的话题枝。用 2-4 个字的通用话题词命名（例：产能 / 竞争 / 风险 / 时间 / 影响 / 背景）。讲同一件事的句子必须用完全相同的枝名——枝名要稳定、通用，不要每次发明新说法；',
    '3. type：这句话在干什么，只从这 8 个里选一个：',
    '   concl=中心结论或主张 / data=数字或规模 / fact=事实或事件 / view=观点或评价 / risk=冲突或风险 / time=时间或进度 / cause=原因或机制 / quote=引语（实在判不出才用它）。',
    '4. kw：每句再给一个 2-6 字的关键词，用于动效展示。优先取原文里的名词、术语、数字或专有名词；不要整句、不要包含标点。kw 的值是一个普通 JSON 字符串，照常带双引号。',
    '另外输出两个字段：',
    'topic：整篇文章的主题，8-14 个字；',
    'links：可选，0-3 组最值得画出来的跨枝关联，格式 [[句子id, 句子id], ...]，只挑明确的因果或对比关系，没有就给空数组。',
    '硬性要求：',
    '- 所有输出（short / kw / topic / branch）必须全部用简体中文，即使原文是英文也要翻译成中文；数字、人名、公司名、专有名词保留原文写法；',
    '- id 必须原样返回输入里的数字，不要改成字符串、不要重新编号；',
    '- 严格按输入的 id 返回；只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块。形如：',
    '{"topic":"…","items":[{"id":1,"short":"…","kw":"…","branch":"…","type":"…"}],"links":[[1,5]]}',
    '',
    '输入：',
    JSON.stringify(list, null, 0)
  ].join('\n');

  /* 多了一个 kw 字段，输出变长：给足余量，避免长文被截断成非法 JSON */
  const r = await callModel(prompt, 4000);
  if (!r.ok) return r;

  const web = parseStructured(r.text);

  /* 结构化失败：退回纯字符串数组——列表摘要仍有，但网不长节点（失败不上网） */
  if (!web) {
    const arr = parseJsonArray(r.text);
    if (!arr || !arr.length) return { ok: false, error: 'unparsable', provider: r.provider, name: r.name };
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push(arr[i] && arr[i].length ? arr[i] : localClip(list[i].text));
    }
    return { ok: true, summaries: out, provider: r.provider, name: r.name };
  }

  /* 结构化成功：按 id 对齐输入顺序（对不上的用本地截断兜底） */
  const align = function () {
    const byId = {};
    for (let i = 0; i < web.items.length; i++) {
      const key = String(web.items[i].id);
      if (!(key in byId)) byId[key] = web.items[i];
    }
    const out = [];
    let matched = 0;
    for (let i = 0; i < list.length; i++) {
      const it = byId[String(list[i].id)];
      if (it && it.short) { out.push(it.short); matched++; }
      else out.push(localClip(list[i].text));
    }
    return { out: out, matched: matched };
  };
  let aligned = align();
  /* 一个都没对上、但条数相同：模型自己重编号了，按位置对齐 */
  if (!aligned.matched && web.items.length === list.length) {
    for (let i = 0; i < web.items.length; i++) web.items[i].id = list[i].id;
    aligned = align();
  }
  if (!aligned.matched) return { ok: false, error: 'unparsable', provider: r.provider, name: r.name };
  return { ok: true, summaries: aligned.out, web: web, provider: r.provider, name: r.name };
}

/* -------------------------------------------------------------------------
 * 用模型的语言重写 3 行 TL;DR
 * ---------------------------------------------------------------------- */
async function verdict(sentences) {
  const list = sentences
    .map(function (s) { return String(s && s.text ? s.text : '').replace(/\s+/g, ' ').trim(); })
    .filter(Boolean)
    .slice(0, 60);
  if (!list.length) return { ok: false, error: 'empty-input' };

  const prompt = [
    '下面是一篇文章里被摘出的关键句（JSON 数组）。请用它们写 3 行 TL;DR。',
    '硬性要求：',
    '1. 只能使用这些句子里出现过的事实，不得引入任何新事实、背景或推断；',
    '2. 数字必须与原文完全一致，一个字符都不能改；',
    '3. 正好 3 行，每行一句话，尽量短；',
    '4. 不要编号以外的任何前缀，不要解释，不要 Markdown；',
    '5. 必须全部用简体中文，即使关键句是英文也要翻译（数字、人名、公司名、专有名词保留原文写法）；',
    '6. 输出纯文本，就 3 行。',
    '',
    '关键句：',
    JSON.stringify(list, null, 0)
  ].join('\n');

  const r = await callModel(prompt, 500);
  if (!r.ok) return r;

  const lines = r.text
    .split('\n')
    .map(function (l) { return l.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim(); })
    .filter(function (l) { return l.length > 0; })
    .slice(0, 3);
  if (!lines.length) return { ok: false, error: 'empty', provider: r.provider, name: r.name };
  return { ok: true, lines: lines, provider: r.provider, name: r.name };
}

/* -------------------------------------------------------------------------
 * 中心标题点开用：把已抓到的关键句讲成一段大白话中文（150–250 字）
 * 和 verdict 的区别：verdict 是 3 行极简 TL;DR，这里要连贯成段、讲清楚全文
 * ---------------------------------------------------------------------- */
async function plainChinese(sentences) {
  const list = sentences
    .map(function (s) { return String(s && s.text ? s.text : '').replace(/\s+/g, ' ').trim(); })
    .filter(Boolean)
    .slice(0, 60);
  if (!list.length) return { ok: false, error: 'empty-input' };

  const prompt = [
    '下面是一篇文章里被摘出的关键句（JSON 数组）。请把这篇文章讲给一个没读过原文的朋友听。',
    '硬性要求：',
    '1. 写成一段连贯的大白话，150 到 250 个汉字，不要分点、不要编号、不要小标题；',
    '2. 只用这些句子里出现过的事实，不得引入任何新事实、背景知识或推断；',
    '3. 数字、人名、公司名、专有名词必须与原文完全一致，一个字符都不能改；',
    '4. 先说这篇东西到底在讲什么，再说关键内容，最后说它的结论或意义；',
    '5. 像平时跟人聊天那样讲，不要书面腔、不要堆术语、不要空话套话；',
    '6. 必须全部用简体中文，即使关键句是英文也要翻译（专有名词保留原文写法）；',
    '7. 输出纯文本，就那一段话，不要引号、不要 Markdown、不要任何解释。',
    '',
    '关键句：',
    JSON.stringify(list, null, 0)
  ].join('\n');

  const r = await callModel(prompt, 700);
  if (!r.ok) return r;

  const text = String(r.text || '')
    .replace(/^[\s"“”'']+|[\s"“”'']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { ok: false, error: 'empty', provider: r.provider, name: r.name };
  return { ok: true, text: text, count: list.length, provider: r.provider, name: r.name };
}

/* 本地截断兜底，避免模型少返回时出现空条目 */
function localClip(text) {
  const words = String(text).split(/\s+/);
  return words.length > 9 ? words.slice(0, 9).join(' ') + '…' : String(text);
}
