/* ============================================================================
 * TL;DR Crawler — options.js
 * 管两件事：
 *   1. 记住用哪家引擎（DeepSeek / Claude）+ 各自的 Key 和模型名
 *   2. 点「测试连接」经后台脚本校验 Key 和模型名（GET /models，不烧 token）
 * 永远不把 Key 写进任何代码。
 * ==========================================================================*/

'use strict';

const DEFAULTS = {
  deepseek: { keyField: 'deepseekKey', modelField: 'deepseekModel', model: 'deepseek-flash', name: 'DeepSeek' },
  anthropic: { keyField: 'apiKey', modelField: 'model', model: 'claude-sonnet-4-5', name: 'Claude' }
};

const el = {
  seg: document.getElementById('seg'),
  deepseekKey: document.getElementById('deepseekKey'),
  deepseekModel: document.getElementById('deepseekModel'),
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  clear: document.getElementById('clear'),
  status: document.getElementById('status')
};

let provider = 'deepseek';
let statusTimer = 0;

/* ---------- 状态条 ---------- */
function say(text, kind, sticky) {
  el.status.textContent = text;
  el.status.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(statusTimer);
  if (!sticky) {
    statusTimer = setTimeout(function () { el.status.className = ''; }, 3000);
  }
}

function keyOf(p) {
  return p === 'anthropic' ? el.apiKey.value.trim() : el.deepseekKey.value.trim();
}

function modelOf(p) {
  return p === 'anthropic' ? el.model.value.trim() : el.deepseekModel.value.trim();
}

/* ---------- 切换引擎（立即生效，摘要按钮文案会跟着变） ---------- */
function applyProvider(p, persist) {
  provider = p === 'anthropic' ? 'anthropic' : 'deepseek';

  const btns = el.seg.querySelectorAll('.seg-btn');
  for (let i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].getAttribute('data-provider') === provider);
  }
  const panes = document.querySelectorAll('[data-pane]');
  for (let i = 0; i < panes.length; i++) {
    panes[i].hidden = panes[i].getAttribute('data-pane') !== provider;
  }

  if (persist) {
    chrome.storage.local.set({ provider: provider }, function () {
      if (chrome.runtime.lastError) {
        say('切换失败：' + chrome.runtime.lastError.message, 'err', true);
        return;
      }
      say('已切到 ' + DEFAULTS[provider].name, 'ok', false);
    });
  }
}

el.seg.addEventListener('click', function (e) {
  const btn = e.target && e.target.closest ? e.target.closest('.seg-btn') : null;
  if (!btn) return;
  applyProvider(btn.getAttribute('data-provider'), true);
});

/* ---------- 读取已有配置 ---------- */
chrome.storage.local.get(null, function (r) {
  r = r || {};
  let p = r.provider;
  if (p !== 'anthropic' && p !== 'deepseek') {
    const hasAnthropic = !!(r.apiKey && String(r.apiKey).trim());
    const hasDeepSeek = !!(r.deepseekKey && String(r.deepseekKey).trim());
    p = (hasAnthropic && !hasDeepSeek) ? 'anthropic' : 'deepseek';
  }

  if (typeof r.deepseekKey === 'string') el.deepseekKey.value = r.deepseekKey;
  if (typeof r.apiKey === 'string') el.apiKey.value = r.apiKey;

  el.deepseekModel.value = (typeof r.deepseekModel === 'string' && r.deepseekModel) ? r.deepseekModel : DEFAULTS.deepseek.model;
  el.model.value = (typeof r.model === 'string' && r.model) ? r.model : DEFAULTS.anthropic.model;

  applyProvider(p, false);
});

/* ---------- 收配置（两家一起存，切换时不用重填） ---------- */
function collect() {
  return {
    provider: provider,
    deepseekKey: el.deepseekKey.value.trim(),
    deepseekModel: el.deepseekModel.value.trim() || DEFAULTS.deepseek.model,
    apiKey: el.apiKey.value.trim(),
    model: el.model.value.trim() || DEFAULTS.anthropic.model
  };
}

function persist(cb) {
  chrome.storage.local.set(collect(), function () {
    if (chrome.runtime.lastError) {
      say('保存失败：' + chrome.runtime.lastError.message, 'err', true);
      if (cb) cb(false);
      return;
    }
    if (cb) cb(true);
  });
}

/* ---------- 保存 ---------- */
el.save.addEventListener('click', function () {
  const key = keyOf(provider);
  persist(function (ok) {
    if (!ok) return;
    if (!key) {
      say('已保存（' + DEFAULTS[provider].name + ' 未填 Key，将使用本地摘要）', 'ok', false);
      return;
    }
    // 只提醒，不拦着
    if (provider === 'anthropic' && !/^sk-ant-/.test(key)) {
      say('已保存，但这个 Key 不像 Anthropic 的（一般以 sk-ant- 开头）', 'err', true);
      return;
    }
    if (provider === 'deepseek' && !/^sk-/.test(key)) {
      say('已保存，但这个 Key 不像 DeepSeek 的（一般以 sk- 开头）', 'err', true);
      return;
    }
    say('已保存 ✓', 'ok', false);
  });
});

/* ---------- 测试连接（先落盘，再让后台打 /models） ---------- */
el.test.addEventListener('click', function () {
  if (!keyOf(provider)) {
    say('先填 ' + DEFAULTS[provider].name + ' 的 API Key', 'err', true);
    return;
  }
  el.test.disabled = true;
  say('正在连接 ' + DEFAULTS[provider].name + '…', '', true);

  persist(function (ok) {
    if (!ok) { el.test.disabled = false; return; }
    try {
      chrome.runtime.sendMessage({ type: 'TLDR_TEST' }, function (res) {
        el.test.disabled = false;
        if (chrome.runtime.lastError || !res) {
          say('测试失败：后台脚本没响应，重新加载扩展试试', 'err', true);
          return;
        }
        const name = res.name || DEFAULTS[provider].name;
        if (!res.ok) {
          say(describeError(name, res), 'err', true);
          return;
        }
        if (res.modelKnown === false) {
          say(
            '✓ Key 有效，但模型名「' + res.model + '」不在可用列表里，摘要会 400。\n可用模型：' +
            (res.models && res.models.length ? res.models.join(' / ') : '（未返回）'),
            'err', true
          );
          return;
        }
        say('✓ 已连通 ' + name + ' · 模型 ' + res.model, 'ok', true);
      });
    } catch (e) {
      el.test.disabled = false;
      say('测试失败：' + (e && e.message ? e.message : '未知错误'), 'err', true);
    }
  });
});

function describeError(name, res) {
  const code = String((res && res.error) || '');
  if (code === 'no-key') return '还没填 ' + name + ' 的 API Key';
  if (code === 'timeout') return name + ' 超时了，检查网络或代理';
  if (code === 'network') return '连不上 ' + name + '，检查网络 / 代理 / VPN';
  if (code === 'bad-json') return name + ' 返回的内容不是 JSON，可能被代理拦截了';
  if (code.indexOf('http-401') === 0) return name + ' 拒绝了这个 Key（401），去控制台确认一下';
  if (code.indexOf('http-403') === 0) return name + ' 无权限（403），Key 可能被限制或欠费';
  if (code.indexOf('http-402') === 0) return name + ' 账户余额不足（402）';
  if (code.indexOf('http-404') === 0) return name + ' 接口不存在（404），确认 Key 是这家平台的';
  if (code.indexOf('http-429') === 0) return name + ' 限流了（429），等一会儿再试';
  if (code.indexOf('http-') === 0) return name + ' 返回 HTTP ' + code.slice(5) + (res.detail ? '：' + res.detail.slice(0, 120) : '');
  return name + ' 连接失败';
}

/* ---------- 清除当前引擎的 Key ---------- */
el.clear.addEventListener('click', function () {
  const field = DEFAULTS[provider].keyField;
  if (provider === 'anthropic') el.apiKey.value = '';
  else el.deepseekKey.value = '';

  chrome.storage.local.remove(field, function () {
    if (chrome.runtime.lastError) {
      say('清除失败：' + chrome.runtime.lastError.message, 'err', true);
      return;
    }
    say('已清除 ' + DEFAULTS[provider].name + ' 的 Key，这家之后只走本地摘要', 'ok', false);
  });
});

/* ---------- Cmd/Ctrl + S 保存 ---------- */
document.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    el.save.click();
  }
});
