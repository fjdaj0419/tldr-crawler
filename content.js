/* ============================================================================
 * TL;DR Crawler — content.js
 * 一只会爬行的蜘蛛：跟随光标阅读网页、高亮关键句、实时生成 TL;DR。
 *
 * 纯 JavaScript，零依赖。注入即切换：
 *   已运行 → 完整清理、网页恢复原状
 *   未运行 → 新建实例
 * 每个标签页只允许一个实例（window.__TLDR_CRAWLER__）。
 *
 * 结构：
 *   §1  常量与工具
 *   §2  文本采集（主区域、文本块、句子 → DOM Range）
 *   §3  关键句打分与挑选
 *   §4  高亮（CSS Custom Highlight API + canvas 兜底）
 *   §5  故障效果 glitch（可完整撤销）
 *   §6  本地摘要 fallback
 *   §7  蜘蛛：几何 / IK / 步态 / 物理
 *   §8  渲染
 *   §9  踩踏与文本检测
 *   §10 浮动面板
 *   §11 AI 摘要（经 background.js 代理）
 *   §12 生命周期
 * ==========================================================================*/

(function () {
  'use strict';

  /* ---------- 切换开关：已经跑着就先收摊 ---------- */
  const previous = window.__TLDR_CRAWLER__;
  if (previous && !previous.destroyed) {
    try { previous.destroy(); } catch (e) { /* 忽略 */ }
    window.__TLDR_CRAWLER__ = null;
    return;
  }
  if (previous) window.__TLDR_CRAWLER__ = null;  // 残留的已销毁实例，清掉后继续新建

  /* ==========================================================================
   * §1 常量与工具
   * ======================================================================== */

  const HOST_ATTR = 'data-tldr-root';

  const CFG = {
    ACCENT: '#5ab8ff',
    ACCENT_SOFT: 'rgba(90,184,255,.42)',
    FOUND_BG: 'rgba(255,222,110,.45)',
    PINK: '#ff6ea9',
    YELLOW: '#ffd166',

    LEG_SPAN: 108,          // 整只蜘蛛的腿展（占地）：原 180 的 60%
    MAX_SPEED: 420,         // px/s
    STOP_DIST: 30,          // 离目标这么近就不再靠近
    STEP_DIST: 46,          // 脚离理想落点这么远才迈步（≈ 腿展的 42%）
    STEP_TIME: 0.13,        // 每一步用时（秒）
    IDLE_MS: 8000,          // 光标静止多久后开始自己游荡
    SCAN_MS: 80,            // 踩踏文本检测间隔
    GLITCH_CHANCE: 0.25,
    GLITCH_LIFE: 2600,
    MAX_GLITCH: 36,

    DEBOUNCE_SCAN: 1000,    // MutationObserver 防抖
    API_DEBOUNCE: 800,
    API_BATCH: 12,

    MIN_SENTENCE: 12,       // 少于这个长度不算一句
    MAX_SENTENCE: 320       // 超过就找空格强行切开
  };

  const EXCLUDE_TAGS = new Set([
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT',
    'SCRIPT', 'STYLE', 'PRE', 'CODE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS',
    'BUTTON', 'MENU', 'TEMPLATE', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED'
  ]);

  const EXCLUDE_ROLES = new Set([
    'navigation', 'banner', 'complementary', 'contentinfo', 'menu', 'menubar',
    'search', 'dialog', 'alertdialog', 'toolbar'
  ]);

  const EXCLUDE_CLASS = /(^|[\s_-])(nav|navbar|menu|sidebar|side-bar|advert|advertisement|ads?|ad-|sponsor|promo|banner|comment|comments|related|recommend|share|social|footer|header|breadcrumb|toolbar|modal|popup|newsletter|subscribe|cookie|popover|drawer|offcanvas)([\s_-]|$)/i;

  const BLOCK_SELECTOR = 'p, li, blockquote, h2, h3, h4';

  const IMPORTANT_WORDS = [
    '第一', '记录', '启动', '宣布', '新的', '唯一', '最大的', '最快的', '警告', '提高', '削减',
    'first', 'record', 'launch', 'announce', 'new', 'only', 'largest', 'biggest',
    'fastest', 'warn', 'raise', 'cut', 'boost', 'surge', 'plunge', 'unveil'
  ];

  const TERMINATORS = '.!?。！？…；;';
  const CLOSERS = '"\'”’)]}）】》>';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function dist(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function easeInOut(p) {
    return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  }
  function angleLerp(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  function isCJK(ch) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch || '');
  }
  function isWordChar(ch) {
    return !!ch && /[0-9A-Za-z_\-\u00c0-\u024f\u0400-\u04ff']/.test(ch);
  }

  /* 超椭圆（squircle）路径：p=2 就是普通椭圆，p 越大越接近圆角矩形。
     身体两节用它画，才能还原参考图里「腹部下缘比椭圆更饱满」的形状。
     Append 版不 beginPath，用来把两节身体拼成一条路径做 clip（扫光要跨过两节）。 */
  function superEllipseAppend(ctx, g, k) {
    const n = 72;
    const e = 2 / (g.p || 2);
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const c = Math.cos(t), s = Math.sin(t);
      const x = g.x * k + g.rx * k * Math.sign(c) * Math.pow(Math.abs(c), e);
      const y = g.y * k + g.ry * k * Math.sign(s) * Math.pow(Math.abs(s), e);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function superEllipsePath(ctx, g, k) {
    ctx.beginPath();
    superEllipseAppend(ctx, g, k);
  }

  function superEllipse(ctx, g, k) {
    superEllipsePath(ctx, g, k);
    ctx.fill();
  }

  /* 屏幕固定的光向：左上打光。蜘蛛一直在转身，光不能在屏幕里跟着转，
     所以画身体（上下文已经 rotate 过）时要把它反向旋转回局部坐标。 */
  const LIGHT = (function () {
    const x = -0.42, y = -0.91;
    const l = Math.sqrt(x * x + y * y) || 1;
    return { x: x / l, y: y / l };
  })();

  function lightLocal(r) {
    const c = Math.cos(r), s = Math.sin(r);
    return { x: LIGHT.x * c + LIGHT.y * s, y: -LIGHT.x * s + LIGHT.y * c };
  }

  /* 沿方向 L 从中心到超椭圆轮廓的距离。
     直接按参数式采样取最大投影，比用椭圆公式近似准 ——
     亮弧能不能"贴"在边上就取决于这个值，差 5% 时那道边光就会浮在形状中间。 */
  function superEllipseRadius(g, k, L) {
    let best = 0;
    const n = 48;
    const e = 2 / (g.p || 2);
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const c = Math.cos(t), s = Math.sin(t);
      const x = g.rx * k * Math.sign(c) * Math.pow(Math.abs(c), e);
      const y = g.ry * k * Math.sign(s) * Math.pow(Math.abs(s), e);
      const d = x * L.x + y * L.y;
      if (d > best) best = d;
    }
    return best || 1;
  }

  /* 沿光轴的一条线性渐变：t=0 在背光侧轮廓，t=1 在受光侧轮廓 */
  function rimGradient(ctx, cx, cy, L, R, stops) {
    const g = ctx.createLinearGradient(
      cx - L.x * R, cy - L.y * R,
      cx + L.x * R, cy + L.y * R
    );
    for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  }

  /* 扩展自己创建的元素？ */
  function isOurs(el) {
    let n = el;
    while (n) {
      if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute(HOST_ATTR)) return true;
      n = n.parentNode;
      if (n && n.nodeType === 11 && n.host) n = n.host; // shadow
    }
    return false;
  }

  /* 元素是否真的可见（含祖先） */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
          // content-visibility 之外的场景，再补一次尺寸判断
          if (!el.getClientRects().length) return false;
        }
      } catch (e) { /* 老版本忽略参数 */ }
    }
    const rects = el.getClientRects();
    if (!rects.length) return false;
    for (let i = 0; i < rects.length; i++) {
      if (rects[i].width > 0 || rects[i].height > 0) return true;
    }
    return false;
  }

  /* 向上找有没有不该读的祖先（导航、广告、自身 UI……） */
  function hasBadAncestor(el, stopAt) {
    let n = el;
    let depth = 0;
    while (n && n !== stopAt && depth < 64) {
      if (n.nodeType === 1) {
        if (isOurs(n)) return true;
        if (EXCLUDE_TAGS.has(n.tagName)) return true;
        const role = n.getAttribute && n.getAttribute('role');
        if (role && EXCLUDE_ROLES.has(role.toLowerCase())) return true;
        const ariaHidden = n.getAttribute && n.getAttribute('aria-hidden');
        if (ariaHidden === 'true') return true;
        const cls = n.getAttribute && n.getAttribute('class');
        if (cls && EXCLUDE_CLASS.test(cls)) return true;
        const id = n.getAttribute && n.getAttribute('id');
        if (id && EXCLUDE_CLASS.test(id)) return true;
      }
      n = n.parentElement;
      depth++;
    }
    return false;
  }

  /* ==========================================================================
   * §7 蜘蛛的几何常量 —— 全部按参考图逐像素量出来
   *
   * 参考图 1024×1024：整体 599×670，身体 123 宽，
   * 只有两种前景色：#565657（大腿/腰/触肢/关节实心点）、#aeafb0（身体/小腿），
   * 关节是「白色圆环 + 深灰实心点」，外径 30、实心点直径 21，腿宽 20。
   * 下面的坐标都是「参考图像素、原点在身体中心、**+Y 朝前**」——参考图里两条触肢
   * （口器）在 y≈175~198，也就是大身子那一端的正前方，所以 +Y 才是蜘蛛的脸朝的方向。
   * 绘制时统一乘 S（见下）。 */

  /* ---- 尺寸的两个开关 ----
     CFG.LEG_SPAN  整只蜘蛛的占地面积（左右脚尖墨迹的间距）
     LEG_STRETCH   腿长相对身体的倍数：髋点不动，膝和脚尖沿腿轴往外推
     顺序很关键：先把腿拉长，再用「拉伸后的真实腿展」反推等比系数 S。
     这样「腿变长」不会顺带把占地撑大 —— 多出来的长度是从身体上省下来的
     （身体跟着 S 等比缩小，宽高比不变，只是在腿的衬托下显得更瘦）。 */
  const LEG_STRETCH = 1.45;

  /* 配色：跟参考图完全一致的纯色块，不再加描边/光泽 */
  const C_DARK = '#565657';
  const C_LIGHT = '#aeafb0';
  const C_TEAL = '#32b8ae';
  const C_JOINT = '#fbfcfd';                    // 关节白圈（参考图是白底，用近白）
  const C_SPECK_DARK = '#8e9092';               // 大腿上的反光（比 #565657 亮一档）
  const C_SPECK_LIGHT = '#e2e3e6';              // 小腿上的反光（比 #aeafb0 亮一档）

  /* 金属光泽（伪金属）：全部是「裁剪在形状里的一道渐变 / 一条细线」，
     不加描边、不动轮廓 —— 所以整体仍然是平涂矢量风，只是有了被光打到的意思。
     所有强度都乘 SHEEN 这一个总倍数：想整体调轻调重，只改它（0 = 完全关掉）。 */
  const SHEEN = 1;
  const METAL = {
    RIM: 0.46,          // 受光侧亮弧峰值（不透明度）
    SHADE: 0.20,        // 背光侧暗边峰值
    SPECK: 0.50,        // 腿上反光的强度
    SPECK_W: 0.40,      // 反光宽度 = 腿宽 × 这个
    SPECK_OFF: 0.26,    // 反光偏移 = 腿宽 × 这个（往受光侧）
    SWEEP_ON: true,     // 极低频扫光总开关
    SWEEP_PERIOD: 7600, // 多久扫一次（毫秒）
    SWEEP_LIFE: 320,    // 一次扫光持续多久（毫秒）
    SWEEP_ALPHA: 0.52,  // 扫光峰值（这一下是「闪」，要能看见，所以比亮弧重）
    SWEEP_HALF: 0.22    // 亮带半宽 = 身体半径 × 这个
  };

  /* 腿的线宽 / 关节尺寸都跟着 S 走（下面 S 算出来后统一给） */

  /* 身体：两节 + 中间一道深灰腰 + 腹部上的青点（相对身体中心）
     p 是超椭圆指数：p=2 是标准椭圆，>2 越接近圆角矩形。参考图里腹部下缘明显比椭圆
     更「饱满」，按逐行量出来的宽度剖面拟合得 p≈2.2；另一节 p≈2.1。
     命名提醒：key 沿用旧名，但实际角色是 —— `abdo`（大的一节，+Y 端）才是头胸部，
     8 条腿的髋点和那一对触肢（口器）全长在它身上；`head`（小的一节，-Y 端）是腹部。 */
  const BODY_GEO = {
    head: { x: -0.5, y: -77, rx: 58, ry: 71.5, p: 2.1 },     // 小的一节（-Y 端，腹部）
    abdo: { x: 0.5, y: 84, rx: 61.5, ry: 83, p: 2.2 },       // 大的一节（+Y 端，头胸部＋青点）
    waist: { x: -0.5, y: -2.3, rx: 12.5, ry: 5.5 },          // 两节之间的深灰连接
    dot: { x: 0, y: 125.5, r: 10.75 }                        // 青色斑点
  };

  /* 那一对短触肢（口器）：在 +Y 端，也就是蜘蛛的正前方
     一段二次贝塞尔（量到的是墨迹端点，这里同样是中心线端点） */
  const PALPS = [
    { a: { x: -32, y: 175 }, c: { x: -35, y: 185 }, b: { x: -28, y: 198 } },
    { a: { x: 32, y: 175 }, c: { x: 35, y: 185 }, b: { x: 28, y: 198 } }
  ];

  /* 每侧 4 条腿（下面只写左侧，右侧 x 取反自动生成）。
     hip  髋点（藏在身体轮廓里，被身体盖住）
     knee 膝关节中心
     foot 脚尖（这里写的是参考图墨迹的最外缘，构建时会自动回缩半个腿宽）
     mid  后两对腿在小腿上的第二个关节圆心（前两对腿没有） */
  const LEG_DEFS = [
    {
      hip: { x: -47.2, y: 36.6 }, knee: { x: -150.5, y: -92.5 },
      foot: { x: -112.5, y: -244.5 }, mid: null
    },
    {
      hip: { x: -53.7, y: 69.1 }, knee: { x: -174.5, y: 3 },
      foot: { x: -299.5, y: 75.5 }, mid: null
    },
    {
      hip: { x: -49.5, y: 106.8 }, knee: { x: -174.5, y: 98 },
      foot: { x: -284.5, y: 290.5 }, mid: { x: -237.5, y: 193 }
    },
    {
      hip: { x: -51.5, y: 109 }, knee: { x: -136.5, y: 204.5 },
      foot: { x: -105.5, y: 424.5 }, mid: { x: -145.5, y: 299.5 }
    }
  ];

  /* 把腿拉长 LEG_STRETCH 倍：绕髋点，把「髋→膝」「膝→脚」两段各自乘这个倍数。
     两段的方向不变、只变长，所以整条腿是「顺着原姿态再伸出去一截」，
     既不会变粗、也不会改变膝盖的弯向；mid 跟着膝一起走，相对位置自动保持。 */
  const STRETCHED_DEFS = [];
  for (let i = 0; i < LEG_DEFS.length; i++) {
    const d = LEG_DEFS[i];
    const kx = d.hip.x + (d.knee.x - d.hip.x) * LEG_STRETCH;
    const ky = d.hip.y + (d.knee.y - d.hip.y) * LEG_STRETCH;
    STRETCHED_DEFS.push({
      hip: { x: d.hip.x, y: d.hip.y },
      knee: { x: kx, y: ky },
      foot: {
        x: kx + (d.foot.x - d.knee.x) * LEG_STRETCH,
        y: ky + (d.foot.y - d.knee.y) * LEG_STRETCH
      },
      mid: d.mid ? {
        x: kx + (d.mid.x - d.knee.x) * LEG_STRETCH,
        y: ky + (d.mid.y - d.knee.y) * LEG_STRETCH
      } : null
    });
  }

  /* 拉伸后的真实腿展（左右脚尖墨迹的最外缘，含两端圆头端帽） */
  let STRETCHED_SPAN = 0;
  for (let i = 0; i < STRETCHED_DEFS.length; i++) {
    STRETCHED_SPAN = Math.max(STRETCHED_SPAN, Math.abs(STRETCHED_DEFS[i].foot.x) * 2);
  }

  /* 等比系数：用拉伸后的腿展反推，保证占地始终 = CFG.LEG_SPAN */
  const S = CFG.LEG_SPAN / STRETCHED_SPAN;
  const BODY_W = 123 * S;                       // 腹部最宽处（等比缩，宽高比不变）
  const BODY_H = 315 * S;                       // 头胸顶 → 腹部底
  const LEG_W = 21 * S;                         // 腿的线宽（参考图垂直量出来 21）
  const JOINT_R = 15 * S;                       // 关节白圈外半径
  const JOINT_DOT = 10.5 * S;                   // 关节深灰实心点半径

  /* 展开成 8 条：0-3 左侧，4-7 右侧（右侧 x 镜像）
     参考图里脚尖坐标量的是「墨迹最外缘」，而画线用的是圆头端帽，帽沿还要再往外
     伸半个腿宽，所以脚尖要沿小腿方向回缩 CAP_R，画出来的外缘才能和参考图重合。 */
  const CAP_R = 10.5;
  const LEGS = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < LEG_DEFS.length; i++) {
      const d = STRETCHED_DEFS[i];
      const mx = pass === 0 ? 1 : -1;

      // 先在不镜像的坐标系里回缩脚尖，再整体镜像
      const anchor = d.mid || d.knee;
      let fdx = d.foot.x - anchor.x, fdy = d.foot.y - anchor.y;
      const fl = Math.sqrt(fdx * fdx + fdy * fdy) || 1;
      const tipX = d.foot.x - (fdx / fl) * CAP_R;
      const tipY = d.foot.y - (fdy / fl) * CAP_R;

      const leg = {
        side: pass === 0 ? -1 : 1,
        hip: { x: d.hip.x * mx, y: d.hip.y },
        knee: { x: d.knee.x * mx, y: d.knee.y },
        foot: { x: tipX * mx, y: tipY },
        mid: d.mid ? { x: d.mid.x * mx, y: d.mid.y } : null
      };
      // 段长（乘 S 换成 canvas 像素）：大腿、合并小腿
      leg.lenThigh = dist(leg.hip.x, leg.hip.y, leg.knee.x, leg.knee.y) * S;
      leg.lenShin = dist(leg.knee.x, leg.knee.y, leg.foot.x, leg.foot.y) * S;
      leg.reach = leg.lenThigh + leg.lenShin;

      /* 静止时膝盖在「髋→脚」连线的哪一侧。运行时 IK 有两个解，用这个符号挑对的那个，
         保证不管蜘蛛转到什么朝向、脚被甩到哪里，膝盖都对身体外侧弓 */
      const vx = leg.foot.x - leg.hip.x, vy = leg.foot.y - leg.hip.y;
      const wx = leg.knee.x - leg.hip.x, wy = leg.knee.y - leg.hip.y;
      leg.bend = Math.sign(vx * wy - vy * wx) || 1;

      /* 后两对腿的第二个关节：在「膝→脚」这条弦上取投影比例与垂直偏移，
         都存成无量纲比例，渲染时随实际弦长等比缩放（镜像后符号自动正确） */
      if (leg.mid) {
        const chord = dist(leg.knee.x, leg.knee.y, leg.foot.x, leg.foot.y) || 1;
        const ux = (leg.foot.x - leg.knee.x) / chord;
        const uy = (leg.foot.y - leg.knee.y) / chord;
        const pmx = leg.mid.x - leg.knee.x, pmy = leg.mid.y - leg.knee.y;
        leg.midT = (pmx * ux + pmy * uy) / chord;
        leg.midH = (-pmx * uy + pmy * ux) / chord;
      } else {
        leg.midT = 0;
        leg.midH = 0;
      }

      LEGS.push(leg);
    }
  }

  /* 交替步态：两条腿一组，永远对角 */
  const GAIT_A = [0, 5, 2, 7];
  const GAIT_B = [1, 4, 3, 6];

  const GLITCH_EFFECTS = [
    /* 1 等宽字体 */
    function (el) {
      el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';
    },
    /* 2 蓝色轮廓 */
    function (el) {
      el.style.color = '#5ab8ff';
      el.style.webkitTextStroke = '0.7px #5ab8ff';
      el.style.textShadow = '0 0 7px rgba(90,184,255,.8)';
    },
    /* 3 蓝色高亮 */
    function (el) {
      el.style.backgroundColor = 'rgba(90,184,255,.26)';
      el.style.borderRadius = '2px';
      el.style.boxShadow = '0 0 0 2px rgba(90,184,255,.12)';
    },
    /* 4 轻微旋转 */
    function (el) {
      el.style.display = 'inline-block';
      el.style.transform = 'rotate(' + rand(-7, 7).toFixed(2) + 'deg)';
      el.style.transformOrigin = '50% 60%';
    },
    /* 5 增加字间距 */
    function (el) {
      el.style.letterSpacing = (rand(0.08, 0.2)).toFixed(3) + 'em';
    },
    /* 6 模糊 */
    function (el) {
      el.style.filter = 'blur(0.8px)';
      el.style.opacity = '0.86';
    },
    /* 7 大写 */
    function (el) {
      el.style.textTransform = 'uppercase';
    }
  ];

  /* ==========================================================================
   * 面板的样式与结构（都在 Shadow DOM 里，网页 CSS 碰不到）
   * ======================================================================== */

  const PANEL_CSS = `
:host { font-synthesis: none; }
*, *::before, *::after { box-sizing: border-box; }
.panel {
  position: fixed;
  top: 18px;
  right: 18px;
  width: 372px;
  max-height: min(82vh, 700px);
  display: flex;
  flex-direction: column;
  background: #16181c;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0,0,0,.55), 0 0 0 1px rgba(90,184,255,.05);
  color: #e8eaed;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro SC", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
  pointer-events: auto;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,.14) transparent;
  animation: tldr-in .3s cubic-bezier(.2,.9,.3,1);
  contain: layout style;
}
/* 放大：面板变宽，蛛网按新尺寸重画（内容区更宽，胶囊排得更开） */
.panel.wide {
  width: min(620px, calc(100vw - 36px));
  max-height: min(94vh, 880px);
}
.panel::-webkit-scrollbar { width: 6px; }
.panel::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,.14);
  border-radius: 3px;
}
/* ── 鼠标压到面板上：只有底板和蛛丝褪色；按钮、列表等操作界面始终清晰 ── */
.panel {
  transition: background-color .2s cubic-bezier(.2,.9,.3,1),
              border-color .2s cubic-bezier(.2,.9,.3,1),
              box-shadow .2s cubic-bezier(.2,.9,.3,1);
}
.panel:hover {
  background: rgba(22,24,28,.81);
  border-color: rgba(255,255,255,.06);
  box-shadow: 0 18px 44px rgba(0,0,0,.46);
}
/* 丝单独淡一档：胶囊、详情卡是内容，不跟着淡；toast / AI 报错徽标也不淡 */
.websilk { transition: opacity .2s cubic-bezier(.2,.9,.3,1); }
.panel:hover .websilk { opacity: .81; }
.hd { flex: none; }
.track { flex: none; }
.ai { flex: none; }
.ctl { flex: none; }
.acts { flex: none; }
.panel.dragging { cursor: grabbing; transition: none; }
@keyframes tldr-in {
  from { opacity: 0; transform: translateY(-8px) scale(.98); }
  to   { opacity: 1; transform: none; }
}
.hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 8px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.hd:active { cursor: grabbing; }
.mark {
  width: 7px; height: 7px; border-radius: 50%;
  background: #cfd4dc;
  box-shadow: 0 0 8px rgba(255,255,255,.5);
  flex: none;
}
.title {
  color: #e8eaed;
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: .7px;
}
.ver {
  color: #565c66;
  font: 500 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: .3px;
}
.zoom {
  appearance: none;
  flex: none;
  width: 21px; height: 21px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 5px;
  background: transparent;
  color: #b0b7c1;
  font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  cursor: pointer;
  transition: color .15s, background .15s, border-color .15s;
}
.zoom:hover {
  color: #e8eaed;
  background: rgba(255,255,255,.07);
  border-color: rgba(255,255,255,.2);
}
.cnt {
  margin-left: auto;
  color: #7d838d;
  font: 11.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: .3px;
}
.cnt b { color: #e8eaed; font-weight: 600; }
.track {
  height: 3px;
  margin: 0 12px 8px;
  background: rgba(255,255,255,.07);
  border-radius: 2px;
  overflow: hidden;
}
.track i {
  display: block;
  height: 100%;
  width: 0%;
  border-radius: 2px;
  background: linear-gradient(90deg, #7d838d, #d7dbe2);
  box-shadow: 0 0 9px rgba(255,255,255,.28);
  transition: width .35s cubic-bezier(.2,.9,.3,1);
}
/* ── 蛛网图谱：丝全白，颜色只贴在节点端 ── */
.webwrap {
  position: relative;
  margin: 0 0 2px;
  flex: none;
}
.web {
  position: relative;
  margin: 0 auto;
}
.webhint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 54px;
  text-align: center;
  font-size: 11.5px;
  line-height: 1.6;
  color: #6b717b;
  pointer-events: none;
  padding: 0 26px;
}
.webhint b {
  display: block;
  color: #9aa1ab;
  font-weight: 600;
  margin-bottom: 3px;
  font-size: 12px;
}
.pill {
  position: absolute;
  transform: translate(-50%, -50%);
  width: max-content;
  max-width: 84px;
  padding: 2px 6px;
  border-radius: 7px;
  border: 1px solid rgba(255,255,255,.16);
  background: rgba(18,21,25,.93);
  color: #dbe1e9;
  font-size: 9.5px;
  line-height: 1.34;
  text-align: center;
  cursor: pointer;
  z-index: 2;
  transition: border-color .16s, background .16s, box-shadow .16s, transform .16s;
}
.pill:hover {
  background: rgba(34,39,47,.99);
  transform: translate(-50%, -50%) scale(1.06);
  z-index: 6;
}
.pill.hub {
  font-size: 10.5px;
  font-weight: 700;
  color: #ffe9b0;
  max-width: 104px;
  padding: 3px 8px;
  border-color: rgba(255,209,102,.5);
  background: linear-gradient(180deg, rgba(46,38,20,.98), rgba(26,22,14,.98));
  box-shadow: 0 0 16px rgba(255,209,102,.16);
  cursor: pointer;
}
.pill.hub:hover {
  border-color: rgba(255,209,102,.9);
  box-shadow: 0 0 22px rgba(255,209,102,.32);
  transform: translate(-50%, -50%) scale(1.05);
  z-index: 6;
}
.pill.hub::after {
  content: " ›";
  font-size: 11px;
  opacity: .72;
  letter-spacing: 0;
}
.pill.br {
  font-size: 10px;
  font-weight: 600;
  color: #eef3f9;
  max-width: 94px;
  padding: 3px 6px;
  border-color: rgba(255,255,255,.22);
  background: rgba(22,25,30,.96);
}
.pill .tp { display: inline-flex; gap: 2px; margin-left: 4px; vertical-align: middle; }
.pill .tp i { width: 4px; height: 4px; border-radius: 50%; display: inline-block; }
/* 话题枝末端（层级网）：带 › 提示可点开下一层，边框略亮一点区别于普通叶子 */
.pill.grp::after { content: " ›"; opacity: .62; font-size: .92em; }
.pill.grp { border-style: dashed; }
.pill.grp:hover { border-style: solid; }
/* 放大态：网大了，胶囊和文字同比放大一档，别缩成蚂蚁 */
.panel.wide .pill { font-size: 11px; max-width: 108px; padding: 3px 8px; }
.panel.wide .pill.hub { font-size: 12px; max-width: 132px; padding: 4px 10px; }
.panel.wide .pill.br { font-size: 11.5px; max-width: 120px; padding: 4px 8px; }
/* 要点很多（>28）：胶囊收小一号，全文去详情卡里看，别让网变成一坨 */
.web.dense .pill { font-size: 8.5px; max-width: 70px; padding: 1.5px 4px; line-height: 1.3; }
.web.dense .pill.br { font-size: 9px; max-width: 66px; padding: 2px 4px; }
.web.dense .pill.hub { font-size: 9.5px; max-width: 92px; padding: 3px 6px; }
/* ── 织网动画：丝从中心抽出、胶囊由内而外依次弹出 ──
   结束态刻意等于默认态，胶囊用 backwards（不用 forwards），
   这样动画播完 hover 的 scale(1.06) 照常生效。 */
@keyframes tldr-silk-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes tldr-silk-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes tldr-pill-pop {
  from { opacity: 0; transform: translate(-50%,-50%) scale(.45); }
  to   { opacity: 1; transform: translate(-50%,-50%) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .pill, .websilk path, .websilk circle { animation: none !important; }
}
.panel.wide .list { max-height: min(34vh, 320px); }
.pill.on {
  background: rgba(34,39,47,.99);
  border-color: rgba(255,255,255,.8) !important;
  box-shadow: 0 0 0 1px rgba(255,255,255,.22), 0 4px 14px rgba(0,0,0,.5);
  z-index: 7;
}
/* ── 点开胶囊：详情卡（贴在网上，不遮住整张图）── */
.webcard {
  position: absolute;
  z-index: 9;
  width: 238px;
  max-height: 212px;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 9px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,.16);
  border-left-width: 2px;
  background: linear-gradient(180deg, rgba(24,28,34,.985), rgba(15,18,22,.985));
  box-shadow: 0 10px 26px rgba(0,0,0,.62), 0 0 0 1px rgba(0,0,0,.35);
  color: #dbe1e9;
  cursor: default;
  animation: wcIn .14s cubic-bezier(.2,.9,.3,1);
}
@keyframes wcIn {
  from { opacity: 0; transform: translateY(-3px) scale(.985); }
  to   { opacity: 1; transform: none; }
}
.webcard .wc-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin-bottom: 5px;
}
.webcard .wc-ty {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 9.5px;
  letter-spacing: .2px;
  color: #aeb6c1;
}
.webcard .wc-ty i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  display: inline-block;
}
.webcard .wc-br {
  font-size: 9.5px;
  color: #6f7681;
  padding-left: 6px;
  border-left: 1px solid rgba(255,255,255,.1);
  max-width: 82px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.webcard .wc-x {
  margin-left: auto;
  appearance: none;
  border: 0;
  background: transparent;
  color: #6b727c;
  font: 600 13px/1 inherit;
  padding: 1px 3px;
  cursor: pointer;
  border-radius: 4px;
}
.webcard .wc-x:hover { color: #e8eaed; background: rgba(255,255,255,.06); }
.webcard .wc-sum {
  flex: none;
  font-size: 11.5px;
  line-height: 1.5;
  color: #eef2f7;
  font-weight: 600;
  word-break: break-word;
}
.webcard .wc-lb {
  flex: none;
  margin: 7px 0 3px;
  font-size: 9px;
  letter-spacing: .6px;
  color: #5f6670;
}
.webcard .wc-full {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 10.5px;
  line-height: 1.58;
  color: #98a0ab;
  padding-right: 2px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,.14) transparent;
  -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 13px), transparent);
  mask-image: linear-gradient(180deg, #000 calc(100% - 13px), transparent);
}
.webcard .wc-ft {
  flex: none;
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.webcard .wc-ft button {
  appearance: none;
  flex: 1;
  border: 1px solid rgba(255,255,255,.11);
  background: rgba(255,255,255,.04);
  color: #b9c0ca;
  font: 500 10.5px/1 inherit;
  padding: 5px 0;
  border-radius: 6px;
  cursor: pointer;
  transition: color .15s, background .15s, border-color .15s;
}
.webcard .wc-ft button:hover {
  color: #eef1f5;
  border-color: rgba(255,255,255,.3);
  background: rgba(255,255,255,.08);
}
/* 放大态：详情卡跟着放宽，正文也大一档 */
.panel.wide .webcard .wc-sum { font-size: 12.5px; }
.panel.wide .webcard .wc-full { font-size: 11.5px; line-height: 1.62; }
/* 大白话卡：比单句详情卡宽一档，正文是连贯一段，带底部重试/更新条 */
.webcard.plain {
  width: 300px;
  max-height: 300px;
  border-left-color: rgba(255,209,102,.75);
}
.panel.wide .webcard.plain { width: 340px; max-height: 340px; }
.webcard .wc-plain {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 11.5px;
  line-height: 1.78;
  color: #e2e8ef;
  word-break: break-word;
  padding-right: 3px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,.14) transparent;
}
.panel.wide .webcard .wc-plain { font-size: 12.5px; line-height: 1.8; }
.webcard .wc-plain.wait { color: #7d838d; font-size: 11px; }
.webcard .wc-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255,255,255,.08);
}
.webcard .wc-meta .wc-n {
  font-size: 9.5px;
  color: #6b727c;
  white-space: nowrap;
}
.webcard .wc-meta button {
  appearance: none;
  margin-left: auto;
  border: 1px solid rgba(255,209,102,.28);
  background: rgba(255,209,102,.08);
  color: #e8d8a8;
  font: 500 10px/1 inherit;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.webcard .wc-meta button:hover { background: rgba(255,209,102,.16); color: #ffe9b0; }
.foldhd {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 12px;
  padding: 8px 0 7px;
  border-top: 1px dashed rgba(255,255,255,.07);
  font-size: 11.5px;
  color: #8a919b;
  cursor: pointer;
  user-select: none;
  flex: none;
}
.foldhd:hover { color: #c3c9d2; }
.foldhd .chev { color: #5f646c; font-size: 10px; transition: transform .18s; }
.foldhd .k { margin-left: auto; color: #5f646c; font-size: 10.5px; }
.panel.folded .foldhd .chev { transform: rotate(-90deg); }
.panel.folded .list { display: none; }

.list {
  list-style: none;
  margin: 0 9px 6px;
  padding: 2px 0 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  max-height: min(30vh, 230px);
  flex: none;
  position: relative;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,.14) transparent;
}
.list::-webkit-scrollbar { width: 6px; }
.list::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,.14);
  border-radius: 3px;
}
.list:empty::after {
  content: "蜘蛛还没踩到关键句，动一下鼠标，让它爬一爬";
  display: block;
  padding: 10px 4px 14px;
  color: #6b717b;
  font-size: 12px;
  line-height: 1.6;
}
.item {
  display: flex;
  gap: 7px;
  padding: 6px 6px;
  border-radius: 7px;
  font-size: 12.5px;
  line-height: 1.55;
  color: #ccd2da;
  user-select: text;
}
.item .num {
  flex: none;
  min-width: 15px;
  color: #6f7681;
  opacity: .8;
  font: 10.5px/1.9 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.item .txt { word-break: break-word; }
.item.fresh { animation: tldr-flash 1s ease; }
@keyframes tldr-flash {
  0%   { background: rgba(255,209,102,.30); color: #fff6da; }
  60%  { background: rgba(255,209,102,.14); }
  100% { background: transparent; }
}
.ai {
  margin: 2px 12px 8px;
  padding: 9px 11px;
  border-radius: 8px;
  background: rgba(255,255,255,.035);
  border: 1px solid rgba(255,255,255,.09);
  font-size: 12px;
  line-height: 1.6;
  color: #cdd3db;
  user-select: text;
}
.ai p { margin: 0 0 5px; }
.ai p:last-child { margin-bottom: 0; }
.ai.busy { color: #7d838d; }
/* 出错只能靠明度和结构区分（面板除蛛网外一律中性灰） */
.ai.err {
  background: rgba(255,255,255,.07);
  border-color: rgba(255,255,255,.26);
  color: #f2f5f8;
  box-shadow: inset 2px 0 0 rgba(255,255,255,.6);
}
.acts {
  display: flex;
  gap: 8px;
  padding: 6px 12px 10px;
  flex-wrap: wrap;
  align-items: center;
}
.acts.sub { padding: 0 12px 11px; }

/* ── AI 开关条：左边连接状态，右边「自动 / AI 总结」── */
.ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 12px 4px;
}
.conn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.09);
  background: rgba(255,255,255,.03);
  color: #7d838d;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  cursor: default;
  transition: color .18s, border-color .18s, background .18s;
}
.conn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6b717b;
  transition: background .2s, box-shadow .2s;
}
.conn.live {
  color: #dbe1e9;
  border-color: rgba(255,255,255,.24);
  background: rgba(255,255,255,.05);
}
.conn.live .dot {
  background: #e8eaed;
  box-shadow: 0 0 6px rgba(255,255,255,.65);
}
.conn.off { cursor: pointer; }
.conn.off:hover {
  color: #cfd4dc;
  border-color: rgba(255,255,255,.18);
  background: rgba(255,255,255,.06);
}
.modes {
  margin-left: auto;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.09);
  background: rgba(0,0,0,.28);
}
.mode {
  appearance: none;
  border: 0;
  background: transparent;
  color: #7d838d;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  padding: 3px 9px;
  border-radius: 999px;
  cursor: pointer;
  transition: color .18s, background .18s;
}
.mode:hover { color: #cfd4dc; }
.mode.on { color: #16181c; background: #dfe3e9; }
.btn {
  appearance: none;
  border: 1px solid rgba(255,255,255,.16);
  background: linear-gradient(180deg, rgba(255,255,255,.11), rgba(255,255,255,.04));
  color: #e8ecf2;
  padding: 7px 12px;
  border-radius: 8px;
  font: 600 11.5px/1 inherit;
  letter-spacing: .3px;
  cursor: pointer;
  transition: background .16s, border-color .16s, transform .1s;
}
.btn:hover { background: rgba(255,255,255,.17); border-color: rgba(255,255,255,.3); }
.btn:active { transform: translateY(1px); }
.btn.ghost {
  border-color: rgba(255,255,255,.1);
  background: transparent;
  color: #868d97;
  font-weight: 500;
  padding: 5px 9px;
}
.btn.ghost:hover { color: #e8eaed; background: rgba(255,255,255,.05); }
.toast {
  margin-left: auto;
  color: #cfd4dc;
  font-size: 11.5px;
  opacity: 0;
  transition: opacity .24s;
}
.toast.show { opacity: 1; }
/* 出错提示可能带原因（"DeepSeek 余额不足（402）"），放不下就自己占一行 */
#aiBadge {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[hidden] { display: none !important; }
`;

  const PANEL_HTML = `
<div class="hd">
  <span class="mark"></span>
  <span class="title">TL;DR</span>
  <span class="ver" id="ver" title="插件版本（确认改动生效用）"></span>
  <span class="cnt"><b id="found">0</b> / <span id="total">0</span></span>
  <button type="button" class="zoom" id="zoom" data-act="zoom" title="放大查看（再点还原）" aria-label="放大查看">⤢</button>
</div>
<div class="track"><i id="fill"></i></div>
<div class="webwrap">
  <div class="web" id="web"></div>
  <div class="webcard" id="webCard" hidden></div>
  <div class="webhint" id="webHint"></div>
</div>
<div class="ai" id="ai" hidden></div>
<div class="foldhd" id="foldhd" data-act="fold">
  <span class="chev">▾</span>
  <span>原文列表</span>
  <span id="foldCnt" style="color:#6b717b">（0 条）</span>
  <span class="k" id="foldK">收起</span>
</div>
<ol class="list" id="list"></ol>
<div class="ctl">
  <button type="button" class="conn off" id="conn" data-act="conn"><i class="dot"></i><span id="connText">未连接 AI</span></button>
  <div class="modes" id="modes">
    <button type="button" class="mode on" data-act="mode" data-mode="auto">自动</button>
    <button type="button" class="mode" data-act="mode" data-mode="ai">AI 总结</button>
  </div>
</div>
<div class="acts">
  <button type="button" class="btn" data-act="copy">复制 TL;DR</button>
  <button type="button" class="btn ai-btn" data-act="ai" id="btnAi" hidden>智能总结 TL;DR</button>
</div>
<div class="acts sub">
  <button type="button" class="btn ghost" data-act="restart">重新启动</button>
  <button type="button" class="btn ghost" data-act="close">关闭</button>
  <span class="toast" id="toast"></span>
  <span class="toast" id="aiBadge" hidden>AI 不可用</span>
</div>
`;

  /* ==========================================================================
   * 蛛网图谱 —— 结构由内容聚合，材料全是蛛丝
   *   线型 = 结构：主枝丝（最粗）/ 子枝丝 / 同枝垂弧 / 跨枝虚线
   *   颜色 = 类型：只贴在丝的最后 11px 和交点亮点上，丝本身一律白
   * ======================================================================== */

  const WEB_TYPES = {
    concl: { c: '#ffd166', n: '结论' },
    data:  { c: '#5ab8ff', n: '数字' },
    fact:  { c: '#32b8ae', n: '事实' },
    view:  { c: '#b28dff', n: '观点' },
    risk:  { c: '#ff6ea9', n: '冲突' },
    time:  { c: '#ffa94d', n: '时间' },
    cause: { c: '#8fe36b', n: '原因' },
    quote: { c: '#c3ccd8', n: '引语' }
  };

  /* （网中心那只装饰小蜘蛛已移除：真正的蜘蛛在网页上爬，网里只留节点） */

  /* 网的容量：普通宽度最多铺 24 个，再多就自动切放大态（620px 铺得下 50 个） */
  const MAX_POINTS = 50;      // 上网的要点硬上限
  const WIDE_AT = 24;         // 超过这个数自动放大（层级网主网画到话题枝，普通态放宽到 ~24）
  const DENSE_AT = 32;        // 超过这个数胶囊进入紧凑样式

  function clipPill(s, max) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  /**
   * opt.data = { hub, branches:[{ t, a, leaves:[{ t, ty, sid, full }] }], chords:[[sid,sid]] }
   * opt.deco = 0..1 装饰丝密度（越空越密）；opt.full = 整圈织网（空网用）
   */
  function renderWebMap(host, opt) {
    opt = opt || {};
    const doc = host.ownerDocument || document;
    const S = opt.S || 370;
    const H = opt.H || 336;
    const k = S / 372;
    const kw = Math.max(k, 0.72);
    const big = S >= 520;                      // 放大态：画布大了，文案也放宽
    const C = S / 2, CY = H / 2;
    const RX = 0.352 * S, RY = 0.395 * H;      // 叶子所在椭圆（横扁，给宽胶囊让位）
    const BX = 0.205 * S, BY = 0.235 * H;      // 主枝节点
    const data = opt.data || { hub: '', branches: [], chords: [] };
    const branches = data.branches || [];

    /* 织网动画：由 paintWeb 节流后决定要不要播。丝按阶段错峰，胶囊由内而外弹。 */
    const animate = !!opt.animate;
    let animSeq = 0;
    let phase = null;                 // { mode:'draw'|'fade', delay, dur, step }
    const setPhase = (mode, delay, dur, step) => {
      animSeq = 0;
      phase = { mode: mode, delay: delay, dur: dur, step: step || 0 };
    };
    const pillSeq = { hub: 0, br: 0, leaf: 0 };

    host.innerHTML = '';
    host.style.width = S + 'px';
    host.style.height = H + 'px';

    const pt = (a, rx, ry) => ({
      x: C + Math.cos(a * Math.PI / 180) * rx,
      y: CY + Math.sin(a * Math.PI / 180) * ry
    });

    const mk = (cls) => {
      const el = doc.createElement('div');
      el.className = 'pill' + (cls ? ' ' + cls : '');
      el.style.visibility = 'hidden';
      if (animate) {
        /* 中心先落子 → 枝 → 叶，同层按出现顺序再错开一点 */
        const kind = cls === 'hub' ? 'hub' : (cls === 'br' ? 'br' : 'leaf');
        const base = kind === 'hub' ? 40 : (kind === 'br' ? 170 : 300);
        const gap = kind === 'hub' ? 0 : (kind === 'br' ? 34 : 26);
        const dl = base + (pillSeq[kind]++) * gap;
        el.style.animation = 'tldr-pill-pop .34s cubic-bezier(.18,.9,.28,1.12) ' + dl + 'ms backwards';
      }
      host.appendChild(el);
      return el;
    };
    const place = (el, x, y) => {
      const w = el.offsetWidth || 60, h = el.offsetHeight || 18;
      el.style.left = Math.min(Math.max(x, w / 2 + 2), S - w / 2 - 2) + 'px';
      el.style.top = Math.min(Math.max(y, h / 2 + 2), H - h / 2 - 2) + 'px';
      el.style.visibility = 'visible';
      return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
    };

    /* ── 中心：页面主题 ── */
    const hubEl = mk('hub');
    hubEl.textContent = clipPill(data.hub || '等待织网', big ? 18 : 14);
    hubEl.title = (data.hub ? data.hub + '\n' : '') + '点开看全文的大白话总结';
    const hubPos = place(hubEl, C, CY);

    /* ── 主枝胶囊：枝名 + 这一枝的类型构成小点 ── */
    const branchEls = [];
    for (let bi = 0; bi < branches.length; bi++) {
      const b = branches[bi];
      const el = mk('br');
      /* 枝多的时候枝名收短，别让 9 个枝胶囊互相顶 */
      const many = branches.length > 6;
      el.textContent = clipPill(b.t, many ? 4 : (big ? 8 : 6));
      if (many) el.style.maxWidth = '74px';
      el.title = b.t;
      const counts = {};
      for (let i = 0; i < b.leaves.length; i++) {
        const ty = b.leaves[i].ty;
        counts[ty] = (counts[ty] || 0) + 1;
      }
      const keys = Object.keys(counts).slice(0, 4);
      if (keys.length) {
        const tp = doc.createElement('span');
        tp.className = 'tp';
        for (let i = 0; i < keys.length; i++) {
          const dotEl = doc.createElement('i');
          dotEl.style.background = (WEB_TYPES[keys[i]] || WEB_TYPES.quote).c;
          tp.appendChild(dotEl);
        }
        el.appendChild(tp);
      }
      const bp = pt(b.a, BX, BY);
      branchEls.push({ el: el, dot: bp, b: b, pos: place(el, bp.x, bp.y) });
    }

    /* ── 叶子：沿主轴分 1–3 层扇出 ──
       层次（径向）解决「一枝要点多」，扇角按可用角均分，不侵入邻枝；
       按 li 轮转分层，深浅交替，看上去才像真的网眼而不是三圈同心环。 */
    const leafEls = [];
    const LANE_R = [1.0, 0.845, 0.705];
    for (let bi = 0; bi < branches.length; bi++) {
      const b = branches[bi];
      const n = b.leaves.length;
      if (!n) continue;
      /* 可用角距：到左右邻枝的最近角度，扇出不得超过它 */
      const prev = branches[(bi - 1 + branches.length) % branches.length];
      const next = branches[(bi + 1) % branches.length];
      const dPrev = ((b.a - prev.a) % 360 + 360) % 360;
      const dNext = ((next.a - b.a) % 360 + 360) % 360;
      const avail = Math.min(dPrev || 360, dNext || 360);
      const lanes = n <= 2 ? 1 : (n <= 5 ? 2 : 3);
      const fan = Math.min(avail * 0.72, n <= 2 ? 52 : 118);   // 这一枝总共张多开
      const tilt = (bi % 2) ? 0.985 : 1.0;                     // 相邻枝错开，叶子不顶到一起
      for (let li = 0; li < n; li++) {
        const l = b.leaves[li];
        const ty = WEB_TYPES[l.ty] || WEB_TYPES.quote;
        const el = mk(l.grp ? 'grp' : '');
        el.textContent = clipPill(l.t, big ? 18 : 13);
        el.title = l.grp ? ((l.kids ? l.kids.length : 0) + ' 条要点 · 点开看下一层') : (l.full || l.t);
        el.style.borderColor = ty.c + 'cc';
        el.style.boxShadow = '0 0 0 1px ' + ty.c + '22, 0 3px 10px rgba(0,0,0,.55)';
        if (l.grp) {
          /* 话题枝末端：记下它在树里的坐标，点开时据此取 kids */
          el.setAttribute('data-grp', bi + '-' + li);
        } else if (l.sid != null) {
          el.setAttribute('data-sid', String(l.sid));
        }
        const lane = li % lanes;
        const qi = Math.floor(li / lanes);                  // 这一层里的第几颗
        const qc = Math.ceil((n - lane) / lanes);           // 这一层共几颗
        const step = qc > 1 ? fan / (qc - 1) : 0;
        const a = b.a + (qi - (qc - 1) / 2) * step;
        const rr = LANE_R[lane] * tilt;
        const p = pt(a, RX * rr, RY * rr);
        leafEls.push({ el: el, dot: p, a: a, ty: ty, bi: bi, li: li, sid: l.sid, pos: place(el, p.x, p.y) });
      }
    }

    /* ── 碰撞消解：胶囊两两推开，hub 与主枝固定，叶子让位 ──
       要点越多轮数越多；50 个胶囊时 8 轮推不开，会叠成一片 */
    const fixedEls = [{ el: hubEl, pos: hubPos }].concat(branchEls.map(b => ({ el: b.el, pos: b.pos })));
    const allEls = fixedEls.concat(leafEls);
    const halfW = (el) => (el.offsetWidth || 40) / 2 + 3;
    const halfH = (el) => (el.offsetHeight || 16) / 2 + 2;
    /* 边界的钳制必须在每一轮里做：只在最后钳一次，贴边的胶囊会被推回去重新叠上 */
    const clampPos = (o) => {
      const w = o.el.offsetWidth || 40, h = o.el.offsetHeight || 16;
      o.pos.x = Math.min(Math.max(o.pos.x, w / 2 + 2), S - w / 2 - 2);
      o.pos.y = Math.min(Math.max(o.pos.y, h / 2 + 2), H - h / 2 - 2);
    };
    const rounds = allEls.length > 36 ? 90 : (allEls.length > 24 ? 30 : 14);
    for (let iter = 0; iter < rounds; iter++) {
      let moved = false;
      for (let i = 0; i < allEls.length; i++) {
        for (let j = i + 1; j < allEls.length; j++) {
          const A = allEls[i], B = allEls[j];
          const ox = halfW(A.el) + halfW(B.el) - Math.abs(B.pos.x - A.pos.x);
          if (ox <= 0) continue;
          const oy = halfH(A.el) + halfH(B.el) - Math.abs(B.pos.y - A.pos.y);
          if (oy <= 0) continue;
          const fixA = i < fixedEls.length, fixB = j < fixedEls.length;
          if (fixA && fixB) continue;
          const dy = B.pos.y - A.pos.y, dx = B.pos.x - A.pos.x;
          if (oy <= ox) {
            const s = (dy >= 0 ? 1 : -1) * ((fixA || fixB) ? oy : oy / 2);
            if (!fixA) A.pos.y -= s;
            if (!fixB) B.pos.y += s;
          } else {
            const s = (dx >= 0 ? 1 : -1) * ((fixA || fixB) ? ox : ox / 2);
            if (!fixA) A.pos.x -= s;
            if (!fixB) B.pos.x += s;
          }
          if (!fixA) clampPos(A);
          if (!fixB) clampPos(B);
          moved = true;
        }
      }
      if (!moved) break;
    }
    /* 应用最终位置：钳在网框内，丝的连接点跟着胶囊走 */
    for (let i = 0; i < leafEls.length; i++) {
      const o = leafEls[i];
      const w = o.el.offsetWidth || 40, h = o.el.offsetHeight || 16;
      o.pos.x = Math.min(Math.max(o.pos.x, w / 2 + 2), S - w / 2 - 2);
      o.pos.y = Math.min(Math.max(o.pos.y, h / 2 + 2), H - h / 2 - 2);
      o.el.style.left = o.pos.x + 'px';
      o.el.style.top = o.pos.y + 'px';
      o.dot = { x: o.pos.x, y: o.pos.y };
    }

    /* ── 障碍框：装饰丝绝不压到胶囊 ── */
    const obstacles = [];
    const addObs = (pos, hw, hh) => obstacles.push({
      x1: pos.x - hw - 4, x2: pos.x + hw + 4,
      y1: pos.y - hh - 4, y2: pos.y + hh + 4
    });
    addObs(hubPos, hubEl.offsetWidth / 2, hubEl.offsetHeight / 2);
    branchEls.forEach(o => addObs(o.pos, o.el.offsetWidth / 2, o.el.offsetHeight / 2));
    leafEls.forEach(o => addObs(o.pos, o.el.offsetWidth / 2, o.el.offsetHeight / 2));

    /* ── 丝 ── */
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('width', S);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + S + ' ' + H);
    svg.setAttribute('class', 'websilk');
    svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible';
    host.insertBefore(svg, host.firstChild);
    const g = doc.createElementNS(ns, 'g');
    svg.appendChild(g);

    const path = (d, o) => {
      const p = doc.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', o.c || 'rgba(255,255,255,.55)');
      p.setAttribute('stroke-width', (o.w || 1) * kw);
      if (o.dash) p.setAttribute('stroke-dasharray', o.dash);
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('opacity', o.o == null ? 1 : o.o);
      if (animate && phase) {
        const dl = phase.delay + (animSeq++) * phase.step;
        if (phase.mode === 'draw' && !o.dash) {
          /* pathLength=1：不管丝实际多长，都用 0→1 的 dashoffset 抽出来 */
          p.setAttribute('pathLength', '1');
          p.setAttribute('stroke-dasharray', '1');
          p.setAttribute('stroke-dashoffset', '1');
          p.style.animation = 'tldr-silk-draw ' + phase.dur + 'ms cubic-bezier(.3,.7,.3,1) ' + dl + 'ms forwards';
        } else {
          /* 背景细丝 / 虚线：整条淡入，别逐段抽（太多会糊成一片） */
          p.style.animation = 'tldr-silk-fade 420ms ease-out ' + dl + 'ms backwards';
        }
      }
      g.appendChild(p);
      return p;
    };
    const dotAt = (x, y, c, r) => {
      const e = doc.createElementNS(ns, 'circle');
      e.setAttribute('cx', x);
      e.setAttribute('cy', y);
      e.setAttribute('r', r * kw);
      e.setAttribute('fill', c);
      e.style.filter = 'drop-shadow(0 0 4px ' + c + ')';
      if (animate && phase) {
        e.style.animation = 'tldr-silk-fade 300ms ease-out ' + (phase.delay + (animSeq++) * 3) + 'ms backwards';
      }
      g.appendChild(e);
    };

    /* 残环：只画断续弧，网边永远没织完 */
    if (animate) setPhase('fade', 0, 0, 8);          // 背景先铺，越早越淡入
    for (let i = 0; i < 10; i++) {
      const a1 = i * 36 + 6, a2 = a1 + 22;
      const p1 = pt(a1, RX * 1.14, RY * 1.12), p2 = pt(a2, RX * 1.14, RY * 1.12);
      const cp = pt((a1 + a2) / 2, RX * 1.08, RY * 1.06);
      path('M' + p1.x + ',' + p1.y + ' Q' + cp.x + ',' + cp.y + ' ' + p2.x + ',' + p2.y,
        { c: 'rgba(255,255,255,.17)', w: 1.05 });
    }
    /* 锚丝：从外环甩向四角 */
    if (animate) setPhase('fade', 90, 0, 30);
    if (branches.length) {
      const corners = [[0, 0], [S, 0], [0, H], [S, H]];
      for (let i = 0; i < corners.length; i++) {
        const b = branches[i % branches.length];
        const p1 = pt(b.a, RX, RY);
        const cq = corners[i];
        const mx = (p1.x + cq[0]) / 2, my = (p1.y + cq[1]) / 2;
        const dx = mx - C, dy = my - CY, dl = Math.hypot(dx, dy) || 1;
        path('M' + p1.x + ',' + p1.y + ' Q' + (mx - dx / dl * 8) + ',' + (my - dy / dl * 8) + ' ' + cq[0] + ',' + cq[1],
          { c: 'rgba(255,255,255,.13)', w: 1.05 });
      }
    }

    /* ── 装饰丝：缝隙里没长成话题的小网眼 + 四角游丝，越空越密 ── */
    const deco = opt.deco == null ? 1 : opt.deco;
    if (animate) setPhase('fade', 120, 0, 1.4);      // 装饰细丝铺开，step 小、fade 统一
    if (deco > 0.02) {
      let sd = 20261103;
      const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      const hits = (p, q) => {
        const x1 = Math.min(p.x, q.x) - 1.5, x2 = Math.max(p.x, q.x) + 1.5;
        const y1 = Math.min(p.y, q.y) - 1.5, y2 = Math.max(p.y, q.y) + 1.5;
        for (let i = 0; i < obstacles.length; i++) {
          const r = obstacles[i];
          if (x2 > r.x1 && x1 < r.x2 && y2 > r.y1 && y1 < r.y2) return true;
        }
        return false;
      };
      const dA = Math.max(1, Math.min(2.4, 1 / Math.max(k, 0.42)));
      const C1 = 'rgba(255,255,255,' + Math.min(.34, .20 * dA).toFixed(3) + ')';
      const C2 = 'rgba(255,255,255,' + Math.min(.30, .16 * dA).toFixed(3) + ')';
      const C3 = 'rgba(255,255,255,' + Math.min(.32, .19 * dA).toFixed(3) + ')';
      /* 横丝受重力向下垂：真网最关键的形状特征，向心塌会变成鱼鳞 */
      const drop = (p, q, pull) => ((p.x + q.x) / 2) + ',' + ((p.y + q.y) / 2 + pull);
      /* 竖丝的中间点向圆心轻塌，避免绷成直棍 */
      const sag = (p, q, pull) => {
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        const dx = C - mx, dy = CY - my, dl = Math.hypot(dx, dy) || 1;
        return (mx + dx / dl * pull) + ',' + (my + dy / dl * pull);
      };

      const angs = branches.map(b => b.a).sort((x, y) => x - y);
      const RSTART = 0.36, REND = 1.04, RINGS = 9;
      const trim0 = 5 + (1 - Math.min(deco, 1)) * 6;
      let gaps;
      if (opt.full || angs.length < 2) {
        gaps = [[0, 360]];
      } else {
        gaps = [];
        for (let i = 0; i < angs.length; i++) {
          const nxt = i === angs.length - 1 ? angs[0] + 360 : angs[i + 1];
          gaps.push([angs[i] + trim0, nxt - trim0]);
        }
      }
      for (let gi = 0; gi < gaps.length; gi++) {
        const a1 = gaps[gi][0], a2 = gaps[gi][1];
        const span = a2 - a1;
        if (span < 18) continue;
        const whole = !!opt.full || angs.length < 2;
        const nS = Math.max(3, Math.round(span / (whole ? 11.5 : 6.5)));
        const spokes = [];
        for (let s2 = 0; s2 < nS; s2++) {
          const sDeg = a1 + span * (s2 + 0.5) / nS;
          /* 边缘羽化：越靠楔形边界越容易断，避免出现笔直的栅栏边 */
          const edge = Math.min(sDeg - a1, a2 - sDeg) / span;
          const fade = whole ? 1 : Math.min(1, edge / 0.22);
          const ring = [];
          for (let r = 0; r < RINGS; r++) {
            const rr = RSTART + (REND - RSTART) * r / (RINGS - 1);
            ring.push(pt(sDeg + (rnd() - 0.5) * 0.9,
              RX * (rr + (rnd() - 0.5) * 0.016),
              RY * (rr + (rnd() - 0.5) * 0.016)));
          }
          spokes.push({ ring: ring, fade: fade });
        }
        /* 径向细丝：一段段画，撞到胶囊就断 */
        for (let sp = 0; sp < spokes.length; sp++) {
          const o = spokes[sp];
          for (let r = 0; r < RINGS - 1; r++) {
            if (rnd() > (0.12 + o.fade * 0.82) * Math.max(deco, 0.2)) continue;
            if (hits(o.ring[r], o.ring[r + 1])) continue;
            path('M' + o.ring[r].x + ',' + o.ring[r].y + ' Q' +
              sag(o.ring[r], o.ring[r + 1], (rnd() - 0.5) * 2.6) + ' ' +
              o.ring[r + 1].x + ',' + o.ring[r + 1].y, { c: C1, w: .72 });
          }
        }
        /* 横向弧：连相邻两根辐丝，受重力下垂 */
        for (let r = 0; r < RINGS; r++) {
          for (let s2 = 0; s2 < nS - 1; s2++) {
            const fade = Math.min(spokes[s2].fade, spokes[s2 + 1].fade);
            if (rnd() > (0.1 + fade * 0.8) * Math.max(deco, 0.2)) continue;
            const p1 = spokes[s2].ring[r], p2 = spokes[s2 + 1].ring[r];
            if (hits(p1, p2)) continue;
            path('M' + p1.x + ',' + p1.y + ' Q' + drop(p1, p2, 2.2 + rnd() * 1.0) + ' ' + p2.x + ',' + p2.y,
              { c: C2, w: .66 });
          }
        }
      }

      /* 外圈羽化：网边碎成一段段短发丝 */
      const fray = Math.max(2, Math.round(30 * deco));
      for (let i = 0; i < fray; i++) {
        const a = rnd() * 360;
        const r0 = 1.0 + rnd() * 0.16;
        const p1 = pt(a, RX * r0, RY * r0);
        const p2 = pt(a + 4 + rnd() * 6, RX * r0, RY * r0);
        if (hits(p1, p2)) continue;
        path('M' + p1.x + ',' + p1.y + ' Q' + drop(p1, p2, 1.4) + ' ' + p2.x + ',' + p2.y,
          { c: C2, w: .66 });
      }

      /* 游丝：四角甩出去的飘丝，短、弯、中途会断 */
      const cornersA = [45, 135, 225, 315];
      const goss = Math.max(1, Math.round(7 * deco));
      for (let i = 0; i < goss; i++) {
        const base = cornersA[i % 4] + (rnd() - 0.5) * 44;
        const p0 = pt(base, RX * (0.97 + rnd() * 0.1), RY * (0.97 + rnd() * 0.1));
        const p1 = pt(base + (rnd() - 0.5) * 42, RX * (1.18 + rnd() * 0.2), RY * (1.18 + rnd() * 0.2));
        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
        const dx = mx - C, dy = my - CY, dl = Math.hypot(dx, dy) || 1;
        const bend = (rnd() * 2 - 1) * 32 * k;
        const cx = mx - dy / dl * bend, cy = my + dx / dl * bend;
        let prev = p0;
        for (let s3 = 1; s3 <= 8; s3++) {
          const t = s3 / 8, it = 1 - t;
          const q = {
            x: it * it * p0.x + 2 * it * t * cx + t * t * p1.x,
            y: it * it * p0.y + 2 * it * t * cy + t * t * p1.y
          };
          if (rnd() < 0.16 || hits(prev, q)) { prev = q; continue; }
          path('M' + prev.x + ',' + prev.y + ' L' + q.x + ',' + q.y, { c: C3, w: .72 });
          prev = q;
        }
      }
    }

    /* 主枝丝：白、最粗、轻弯 —— 从中心抽出 */
    if (animate) setPhase('draw', 150, 480, 46);
    for (let i = 0; i < branchEls.length; i++) {
      const br = branchEls[i];
      const p1 = { x: C, y: CY }, p2 = br.dot;
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const dx = mx - C, dy = my - CY, dl = Math.hypot(dx, dy) || 1;
      const bow = (i % 2 ? 1 : -1) * 5 * k;
      path('M' + p1.x + ',' + p1.y + ' Q' + (mx - dy / dl * bow) + ',' + (my + dx / dl * bow) + ' ' + p2.x + ',' + p2.y,
        { c: 'rgba(255,255,255,.78)', w: 1.8, o: .92 });
    }

    /* 子枝丝：白、细、弯到叶子的交点 —— 跟着枝往外抽 */
    if (animate) setPhase('draw', 340, 400, 14);
    for (let i = 0; i < leafEls.length; i++) {
      const lf = leafEls[i];
      const br = branchEls[lf.bi];
      if (!br) continue;
      const p1 = br.dot, p2 = lf.dot;
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const dx = mx - C, dy = my - CY, dl = Math.hypot(dx, dy) || 1;
      const bow = 4 * k;
      path('M' + p1.x + ',' + p1.y + ' Q' + (mx - dy / dl * bow) + ',' + (my + dx / dl * bow) + ' ' + p2.x + ',' + p2.y,
        { c: 'rgba(255,255,255,.60)', w: 1.25, o: .95 });
    }

    /* 彩色末端：丝的最后 11px 是类型色 —— 颜色只贴在节点端 */
    if (animate) setPhase('fade', 560, 0, 10);
    for (let i = 0; i < leafEls.length; i++) {
      const lf = leafEls[i];
      const br = branchEls[lf.bi];
      if (!br) continue;
      const p1 = lf.dot, p2 = br.dot;
      const vx = p1.x - p2.x, vy = p1.y - p2.y, len = Math.hypot(vx, vy) || 1;
      const ux = vx / len, uy = vy / len;
      const L = 11 * k;
      path('M' + (p1.x - ux * L) + ',' + (p1.y - uy * L) + ' L' + p1.x + ',' + p1.y,
        { c: lf.ty.c, w: 2.6, o: .95 });
    }

    /* 同枝下垂弧：一条枝里的要点本来就是并列的 */
    for (let bi = 0; bi < branches.length; bi++) {
      const arr = leafEls.filter(l => l.bi === bi).sort((x, y) => x.li - y.li);
      for (let i = 0; i < arr.length - 1; i++) {
        const p1 = arr[i].dot, p2 = arr[i + 1].dot;
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        const dx = mx - C, dy = my - CY, dl = Math.hypot(dx, dy) || 1;
        path('M' + p1.x + ',' + p1.y + ' Q' + (mx - dx / dl * 7 * k) + ',' + (my - dy / dl * 7 * k) + ' ' + p2.x + ',' + p2.y,
          { c: 'rgba(255,255,255,.42)', w: 1.15, o: .9 });
      }
    }

    /* 跨枝虚线：因果 / 对比，整张图唯一斜着走且断开的线 */
    const chords = data.chords || [];
    for (let i = 0; i < chords.length; i++) {
      const A = leafEls.filter(l => String(l.sid) === String(chords[i][0]))[0];
      const B = leafEls.filter(l => String(l.sid) === String(chords[i][1]))[0];
      if (!A || !B || A === B) continue;
      const p1 = A.dot, p2 = B.dot;
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const dx = mx - C, dy = my - CY, dl = Math.hypot(dx, dy) || 1;
      path('M' + p1.x + ',' + p1.y + ' Q' + (mx + dx / dl * 16 * k) + ',' + (my + dy / dl * 16 * k) + ' ' + p2.x + ',' + p2.y,
        { c: 'rgba(255,255,255,.46)', w: 1.2, o: 1, dash: (3.4 * k) + ' ' + (3.8 * k) });
    }

    /* 交点亮点：这里能抓 */
    if (animate) setPhase('fade', 640, 0, 6);
    for (let i = 0; i < leafEls.length; i++) dotAt(leafEls[i].dot.x, leafEls[i].dot.y, leafEls[i].ty.c, 2.1);
    for (let i = 0; i < branchEls.length; i++) dotAt(branchEls[i].dot.x, branchEls[i].dot.y, 'rgba(255,255,255,.85)', 2.3);
    dotAt(C, CY, '#fff', 2);
  }

  /* ==========================================================================
   * 主类
   * ======================================================================== */

  class Crawler {
    constructor() {
      this.destroyed = false;
      this.href = location.href;
      this.dpr = 1;
      this.vw = window.innerWidth;
      this.vh = window.innerHeight;

      /* DOM */
      this.host = null;
      this.shadow = null;
      this.canvas = null;
      this.ctx = null;
      this.panelEl = null;
      this.styleEl = null;
      this.sheet = null;
      this.prevSheets = null;
      this.foundBg = CFG.FOUND_BG;

      /* 文本 */
      this.blocks = [];
      this.blockSeen = new WeakSet();
      this.sentences = [];
      this.byId = new Map();
      this.nodeIndex = new Map();      // Text -> [{s,e,id}]，只索引关键句
      this.protectedNodes = new WeakSet();
      this.keySentences = [];
      this.seq = 0;

      /* 高亮 */
      this.hl = null;
      this.highlightMode = 'none';
      this.highlightRects = [];
      this.highlightRectsDirty = true;

      /* glitch */
      this.glitches = [];

      /* 蜘蛛 */
      this.spider = null;
      this.feet = [];
      this.ripples = [];
      this.flyers = [];                 // 关键词飞入蛛网的飞行物（canvas 绘制）
      this.firstWeaveDone = false;      // 首次织网是否已完成：首次用整体动画，之后用「飞入」
      this.onWebSids = new Set();       // 上一轮已在网上的句子 id，用来判断「本轮新增」
      this.webData = null;              // 当前网的数据树（层级/扁平），展开视图据此取 kids
      this.webFocus = null;             // 层级网点开的话题枝坐标 {bi,li}；null=全图
      this.motionScale = 1;
      this.stepScale = 1;
      this.glowT = 0;

      /* 指针 / 视口 */
      this.pointer = {
        cx: window.innerWidth * 0.5,
        cy: window.innerHeight * 0.45,
        has: false,
        lastMove: 0
      };
      this.pointer.lastMove = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.hasMoved = false;
      this.wander = { x: 0, y: 0, next: 0 };

      /* 计时器 / 动画 */
      this.raf = 0;
      this.lastFrame = 0;
      this.acc = 0;
      this.scanTimer = 0;
      this.apiTimer = 0;
      this.debounceTimer = 0;
      this.observer = null;

      /* 面板 */
      this.entries = new Map();         // sentence.id -> li
      this.found = 0;
      this.total = 0;
      this.folded = true;               // 原文列表默认折叠：图谱是主角
      this.wide = false;                // 面板放大态（蛛网按大尺寸重绘）
      this.autoWide = false;            // 这次放大是不是「要点太多」自动触发的
      this.wideOptOut = false;          // 手动收起过：别再加自动放大
      this.webGen = 0;                  // 网的重启代数：在途的旧 AI 响应按代数丢弃

      /* 蛛网图谱 */
      this.webHost = null;
      this.webTopic = '';               // AI 给的页面主题，只认第一次
      this.webChords = [];              // 跨枝关联 [[sid, sid]]
      this.webTimer = 0;
      this.webFlashTimer = 0;
      this.lastWeaveAt = 0;             // 上次播织网动画的时间，节流用（爬取中每 200ms 重画，不能每次从头播）
      this.webHovered = null;
      this.webCardSid = -1;             // 详情卡当前对应的句子 id（-1 = 关着，-2 = 中心标题的大白话卡）
      this.webCardSent = null;
      this.plainCache = null;           // 大白话总结缓存 {text, count} 或 {error}，本次会话有效
      this.plainBusy = false;
      this.aiAvailable = false;
      this.aiProvider = 'deepseek';   // 'deepseek' | 'anthropic'
      this.aiName = 'DeepSeek';       // 按钮上显示的名字
      this.sumMode = 'auto';          // 'auto' 本地规则 | 'ai' 交给模型
      this.aiAutoVerdictAt = 0;       // 上次自动刷 TL;DR 的时间
      this.lastVerdictCount = 0;      // 上次自动刷 TL;DR 时的关键句数量
      this.aiBusy = false;
      this.pendingApi = [];
      this.toastTimer = 0;
      this.aiBadgeTimer = 0;
      this.aiDiag = '';                 // 最近一次「AI 没把要点挂上网」的原因，显示在空网提示里
      this.aiDiagAt = 0;

      /* 整篇层级归纳（AI 动态分块 → 话题枝 → 句子），替代 h2 那套 */
      this.structTimer = 0;             // 空闲防抖：爬取告一段落才发一次整篇归纳
      this.structBusy = false;          // 在途的层级归纳请求
      this.structDone = false;          // 本次会话已经成功归纳过（避免每批重复调用烧额度）
      this.structGen = 0;               // 归纳请求的代数，重启后旧结果作废（跟 webGen 同步）

      /* 绑定的事件（统一注销） */
      this.bound = [];
    }

    /* ---------------------------------------------------------------------
     * §12 启动
     * ------------------------------------------------------------------ */
    start() {
      this.prefersReduced = false;
      try {
        this.prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) { /* 忽略 */ }
      if (this.prefersReduced) {
        this.motionScale = 0.55;
        this.stepScale = 1.7;
      }

      this.buildShadow();
      this.buildPanel();
      this.rebuildWeb();          // 先把空网立起来，面板高度不跳
      this.initSpider();
      this.initHighlights();
      this.scanPage();

      this.bindEvents();
      this.startLoop();
      this.startObserver();
      this.scanTimer = setInterval(this.tickScan.bind(this), CFG.SCAN_MS);

      // API Key 状态（决定是否显示“用模型写 TL;DR”按钮、按钮写哪家名字）
      this.refreshApiState();
    }

    on(target, type, handler, opts) {
      target.addEventListener(type, handler, opts);
      this.bound.push([target, type, handler, opts]);
    }

    bindEvents() {
      const p = { passive: true };
      this.on(window, 'mousemove', this.onPointerMove.bind(this), p);
      this.on(window, 'pointermove', this.onPointerMove.bind(this), p);
      this.on(window, 'resize', this.onResize.bind(this), p);
      this.on(window, 'popstate', this.onRouteChange.bind(this));
      this.on(window, 'keydown', (e) => {
        if (e.key === 'Escape' && this.webCardSid != null && this.webCardSid !== -1) this.closeWebCard();
      });
      if (window.visualViewport) {
        this.on(window.visualViewport, 'resize', this.onResize.bind(this), p);
      }
      this.on(document, 'scroll', this.onScroll.bind(this), { passive: true, capture: true });

      // 配置变化时更新按钮
      this.storageListener = (changes) => {
        if (changes.provider || changes.apiKey || changes.deepseekKey ||
            changes.model || changes.deepseekModel || changes.sumMode) this.refreshApiState();
      };
      chrome.storage.onChanged.addListener(this.storageListener);
    }

    onPointerMove(e) {
      if (this.destroyed) return;
      if (typeof e.clientX !== 'number') return;
      this.pointer.cx = e.clientX;
      this.pointer.cy = e.clientY;
      this.pointer.has = true;
      this.pointer.lastMove = performance.now();
      this.hasMoved = true;
    }

    onScroll() {
      // 画布是 fixed 的，坐标每帧按滚动量换算，这里只标记高亮矩形需要重算
      this.highlightRectsDirty = true;
    }

    onResize() {
      this.vw = window.innerWidth;
      this.vh = window.innerHeight;
      this.resizeCanvas();
      this.highlightRectsDirty = true;
      if (this.wide) this.rebuildWeb(140);   // 放大态跟着窗口宽度重排
    }

    onRouteChange() {
      // SPA 前进/后退：延后一点再重扫，等新内容渲染完
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(this.handleMutations.bind(this), CFG.DEBOUNCE_SCAN);
    }

    /* =====================================================================
     * §2 文本采集
     * ================================================================== */

    /* 找主要可读区域：article → main → 段落文本密度最高的元素 */
    findMainArea() {
      const pickRichest = (list) => {
        let best = null, bestLen = 0;
        for (const el of list) {
          if (!isVisible(el) || hasBadAncestor(el, null)) continue;
          const len = (el.innerText || '').length;
          if (len > bestLen) { bestLen = len; best = el; }
        }
        return bestLen >= 400 ? best : null;
      };

      const article = pickRichest(Array.from(document.querySelectorAll('article')));
      if (article) return article;

      const main = pickRichest(Array.from(document.querySelectorAll('main, [role="main"]')));
      if (main) return main;

      // 密度法：每个 p/li/blockquote 给它的祖先加分，取分最高的那层
      const scores = new Map();
      const ps = document.querySelectorAll('p, li, blockquote');
      for (let i = 0; i < ps.length; i++) {
        const el = ps[i];
        if (!isVisible(el) || hasBadAncestor(el, null)) continue;
        const len = (el.textContent || '').trim().length;
        if (len < 40) continue;
        let n = el.parentElement, d = 0;
        while (n && n !== document.body && d < 4) {
          scores.set(n, (scores.get(n) || 0) + len / (1 + d * 0.4));
          n = n.parentElement;
          d++;
        }
      }
      let best = null, bestScore = 0;
      scores.forEach((score, el) => {
        if (score > bestScore) { bestScore = score; best = el; }
      });
      return best || document.body;
    }

    /* 收集文本块（p / li / blockquote / h2-h4） */
    collectBlocks(root) {
      const out = [];
      if (!root) return out;
      const list = root.querySelectorAll(BLOCK_SELECTOR);
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (this.blockSeen.has(el)) continue;
        if (!isVisible(el)) continue;
        if (hasBadAncestor(el, root.parentElement)) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length < CFG.MIN_SENTENCE) continue;
        // li 里嵌 li 时只取最内层
        if (el.querySelector(BLOCK_SELECTOR) && el.tagName !== 'BLOCKQUOTE') {
          if (el.tagName === 'LI' && el.querySelector('li')) continue;
        }
        this.blockSeen.add(el);
        out.push(el);
      }

      /* 兜底：邮件、文档、后台系统这类页面，正文全在 div/section/td 里，
         一个 p/li/blockquote 都没有，标准选择器会一块都收不到（表现为 0 / 0）。
         这时退一步，把「只含文本、不再套块级容器」的叶子 div 也当段落。 */
      if (out.length < 3) {
        const loose = root.querySelectorAll('div, section, td');
        for (let i = 0; i < loose.length; i++) {
          const el = loose[i];
          if (this.blockSeen.has(el)) continue;
          if (!isVisible(el)) continue;
          if (hasBadAncestor(el, root.parentElement)) continue;
          /* 只要叶子：内部还套着块级容器的，留给更内层去收，避免整篇被当一段 */
          if (el.querySelector('p, li, blockquote, div, section, td, table')) continue;
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length < CFG.MIN_SENTENCE) continue;
          this.blockSeen.add(el);
          out.push(el);
        }
      }
      return out;
    }

    /* 从文本块里切句，每句保存成 DOM Range */
    splitBlock(blockEl) {
      const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, null);
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) {
        const v = n.nodeValue;
        if (!v || !v.trim()) continue;
        const parent = n.parentElement;
        if (!parent) continue;
        if (EXCLUDE_TAGS.has(parent.tagName)) continue;
        if (parent.tagName === 'A' && !parent.textContent.trim()) continue;
        nodes.push(n);
      }
      if (!nodes.length) return [];

      /* 字符表：每个字符记住它来自哪个文本节点、第几个偏移 */
      const chars = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const v = node.nodeValue;
        for (let k = 0; k < v.length; k++) chars.push({ node: node, off: k, ch: v.charAt(k) });
      }
      if (chars.length < CFG.MIN_SENTENCE) return [];

      const results = [];
      let s = 0;
      let i = 0;

      const emit = (endEx) => {
        let a = s, b = endEx;
        while (a < b && /\s/.test(chars[a].ch)) a++;
        while (b > a && /\s/.test(chars[b - 1].ch)) b--;
        if (b - a < CFG.MIN_SENTENCE) return false;
        const built = this.buildSentence(chars, a, b);
        if (built) results.push(built);
        s = endEx;
        return true;
      };

      while (i < chars.length) {
        const ch = chars[i];
        let cut = -1;

        if (TERMINATORS.indexOf(ch.ch) !== -1) {
          let j = i + 1;
          while (j < chars.length && TERMINATORS.indexOf(chars[j].ch) !== -1) j++;
          let k = j;
          while (k < chars.length && CLOSERS.indexOf(chars[k].ch) !== -1) k++;
          const next = k < chars.length ? chars[k].ch : '';
          // 后面是空白 / 结束 / 收尾符号 / 中日文 → 这里断句；
          // 后面还紧贴着字母数字（3.14、U.S.A）→ 不断
          if (!next || /\s/.test(next) || isCJK(next) || CLOSERS.indexOf(next) !== -1) {
            cut = k;
          }
        } else if (ch.ch === '\n') {
          cut = i + 1;
        } else if (ch.ch === '，' || ch.ch === ',') {
          // 中文长句：逗号处切开，避免出现一整段没有任何停顿的巨型 Range
          if (i - s > 120) cut = i + 1;
        }

        if (cut > 0) {
          const short = (cut - s) < CFG.MIN_SENTENCE;
          if (!short) emit(cut);
          // 太短就继续累计，等下一个终止符
        }

        if (i - s >= CFG.MAX_SENTENCE) {
          let k = i;
          while (k > s && !/\s/.test(chars[k].ch)) k--;
          if (k <= s) k = i;
          emit(k + 1);
        }
        i++;
      }
      if (s < chars.length) emit(chars.length);

      return results;
    }

    buildSentence(chars, s, e) {
      const a = chars[s], b = chars[e - 1];
      let text = '';
      for (let i = s; i < e; i++) text += chars[i].ch;
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) return null;

      const range = document.createRange();
      try {
        range.setStart(a.node, a.off);
        range.setEnd(b.node, b.off + 1);
      } catch (err) {
        return null;
      }

      /* 这句横跨了哪些文本节点，各自占哪段 —— 用于踩踏命中判定 */
      const spans = [];
      let cur = null;
      for (let i = s; i < e; i++) {
        const c = chars[i];
        if (!cur || cur.node !== c.node) {
          cur = { node: c.node, s: c.off, e: c.off + 1 };
          spans.push(cur);
        } else {
          cur.e = c.off + 1;
        }
      }

      const id = ++this.seq;
      return {
        id: id,
        text: text,
        range: range,
        spans: spans,
        articleIndex: null,
        blockIndex: null,
        section: '',            // 所属原文子部分（最近的前置 h2/h3/h4 标题），无标题页留空
        hint: '',               // 块前的短标签行（Talk 1: / Speaker: 等），给层级归纳当结构信号
        score: 0,
        key: false,
        found: false,
        summary: ''
      };
    }

    /* 全量扫描 / 增量扫描（只处理新块） */
    scanPage() {
      if (this.destroyed) return;
      const root = this.findMainArea();
      if (!root) return;

      const blocks = this.collectBlocks(root);
      if (!blocks.length) {
        // 可能是 SPA 换页了，清掉失效句子后重新找区域
        this.pruneDetached();
        if (!this.sentences.length) {
          const retry = this.findMainArea();
          if (retry && retry !== root) {
            const more = this.collectBlocks(retry);
            if (more.length) this.ingestBlocks(more);
          }
        }
        return;
      }
      this.ingestBlocks(blocks);
    }

    /* 找块所属的原文子部分：先找最近的 h2/h3/h4 祖先，再退而求其次找 DOM 前序里最近的前置标题。
       标题块（h2/h3/h4）自己也返回它自己的文本，方便标题句归到自己名下。
       没有标题的页面返回 ''，后面建树时降级为原来的扁平结构。 */
    sectionForBlock(blockEl) {
      if (!blockEl || !blockEl.tagName) return '';
      const TAG = /^H[1-6]$/;
      // 1) 块自己是标题 / 块被标题包着
      let up = blockEl;
      let guard = 0;
      while (up && guard++ < 8) {
        if (TAG.test(up.tagName)) {
          const t = (up.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return t.slice(0, 16);
        }
        up = up.parentElement;
      }
      // 2) DOM 前序里最近的前置标题（只看 h2-h4，h1 通常是整页大标题，留给 hub）
      //    用文档顺序的 TreeWalker 向前找，能跨过嵌套的 div/section。
      const PREV = 'h2, h3, h4, [role="heading"][aria-level="2"], [role="heading"][aria-level="3"]';
      let node = blockEl;
      guard = 0;
      while (node && guard++ < 4000) {
        let prev = node.previousElementSibling;
        while (!prev && node.parentElement) { node = node.parentElement; prev = node.previousElementSibling; }
        if (!prev) break;
        // 在这个前置兄弟子树里找最后一个标题（DOM 序最靠后的那个）
        let found = null;
        if (prev.matches && prev.matches(PREV)) found = prev;
        const inner = prev.querySelectorAll ? prev.querySelectorAll(PREV) : null;
        if (inner && inner.length) found = inner[inner.length - 1];
        if (found) {
          const t = (found.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return t.slice(0, 16);
        }
        node = prev;
      }
      return '';
    }

    /* 找块前面最近的「短标签行」文本（Talk 1: / Speaker: / Abstract: / 时间： …）。
       这些行 <12 字被 collectBlocks 丢弃、不成句，但对层级归纳是宝贵的结构信号：
       单独用 hint 字段带给 AI，不改 sent.text（text 必须和 DOM Range 对齐做高亮）。
       判定保守：短（≤16）且以冒号结尾，或是常见邮件字段标签，避免把普通短句误当标签。 */
    hintForBlock(blockEl) {
      if (!blockEl || !blockEl.tagName) return '';
      const LABEL_RE = /^(talk|speaker|title|abstract|biography|registration|date|venue|time|location|name|topic|section|part)\s*\d*\s*[:：]?/i;
      const looksLabel = (t) => {
        if (!t || t.length > 16) return false;
        if (/[:：]\s*$/.test(t)) return true;              // 以冒号结尾（Talk 1: / 时间：）
        if (LABEL_RE.test(t) && /[:：]/.test(t)) return true; // 字段标签
        return false;
      };
      let node = blockEl, guard = 0;
      while (node && guard++ < 200) {
        let prev = node.previousElementSibling;
        while (!prev && node.parentElement) { node = node.parentElement; prev = node.previousElementSibling; }
        if (!prev) break;
        const t = (prev.textContent || '').replace(/\s+/g, ' ').trim();
        if (looksLabel(t)) return t;
        /* 前置兄弟内部也可能含标签行（如 <div>Talk 1:</div><p>正文</p> 的兄弟包裹） */
        if (prev.children && prev.children.length <= 3) {
          for (let c = prev.children.length - 1; c >= 0; c--) {
            const ct = (prev.children[c].textContent || '').replace(/\s+/g, ' ').trim();
            if (looksLabel(ct)) return ct;
          }
        }
        node = prev;
      }
      return '';
    }

    ingestBlocks(blocks) {
      let added = 0;
      for (let i = 0; i < blocks.length; i++) {
        const blockEl = blocks[i];
        const parts = this.splitBlock(blockEl);
        if (!parts.length) continue;
        const blockIndex = this.blocks.length;
        this.blocks.push(blockEl);
        const section = this.sectionForBlock(blockEl);
        const hint = this.hintForBlock(blockEl);
        for (let k = 0; k < parts.length; k++) {
          const sent = parts[k];
          sent.blockIndex = blockIndex;
          sent.articleIndex = this.sentences.length;
          sent.section = section;
          sent.hint = hint;
          sent.score = this.scoreSentence(sent.text);
          this.sentences.push(sent);
          this.byId.set(sent.id, sent);
          added++;
        }
      }
      if (!added) return;
      this.pruneDetached();
      this.recomputeKeys();
      this.updatePanelCounts();
    }

    /**
     * 只给“关键句”建索引 —— 踩踏检测只关心关键句，索引越小越快。
     * 同时把这些句子的文本节点全部标记为受保护：glitch 永远不拆它们，
     * 这样 Custom Highlight 用的 Range 不会因为拆节点而失效。
     */
    rebuildKeyIndex() {
      this.nodeIndex = new Map();
      this.protectedNodes = new WeakSet();
      for (let i = 0; i < this.keySentences.length; i++) {
        const sent = this.keySentences[i];
        for (let k = 0; k < sent.spans.length; k++) {
          const sp = sent.spans[k];
          if (!sp.node.isConnected) continue;
          this.protectedNodes.add(sp.node);
          let arr = this.nodeIndex.get(sp.node);
          if (!arr) { arr = []; this.nodeIndex.set(sp.node, arr); }
          arr.push({ s: sp.s, e: sp.e, id: sent.id });
        }
      }
    }

    pruneDetached() {
      const alive = [];
      for (let i = 0; i < this.sentences.length; i++) {
        const s = this.sentences[i];
        let ok = false;
        try { ok = s.range.startContainer.isConnected && s.range.endContainer.isConnected; } catch (e) { ok = false; }
        if (ok) alive.push(s);
      }
      if (alive.length === this.sentences.length) return;
      this.sentences = alive;
      this.recomputeKeys(true);
      this.rebuildHighlight();
    }

    /* 从 (文本节点, 偏移) 找回句子 */
    lookupSentence(node, offset) {
      const arr = this.nodeIndex.get(node);
      if (!arr) return null;
      for (let i = 0; i < arr.length; i++) {
        if (offset >= arr[i].s && offset < arr[i].e) return this.byId.get(arr[i].id) || null;
      }
      return null;
    }

    /* =====================================================================
     * §3 关键句打分
     * ================================================================== */

    scoreSentence(text) {
      let score = 0;
      if (/\d/.test(text)) score += 2;
      if (/%/.test(text)) score += 2;
      if (/\$/.test(text)) score += 2;
      if (/€/.test(text)) score += 2;
      if (/百万|million/i.test(text)) score += 2;
      if (/十亿|billion/i.test(text)) score += 2;

      const lower = text.toLowerCase();
      for (let i = 0; i < IMPORTANT_WORDS.length; i++) {
        if (lower.indexOf(IMPORTANT_WORDS[i].toLowerCase()) !== -1) score += 1.5;
      }

      const caps = (text.match(/[A-Z]/g) || []).length;
      score += Math.min(caps * 0.3, 2);

      const len = text.length;
      if (len < 40) score -= 2;
      if (len > 260) score -= 2;

      return score;
    }

    /* 取前 25%，夹在 5..80 之间，并做空间分散 */
    recomputeKeys(keepOnly = false) {
      const all = this.sentences;
      if (!all.length) {
        this.keySentences = [];
        this.total = 0;
        this.nodeIndex = new Map();
        this.protectedNodes = new WeakSet();
        return;
      }

      const target = clamp(Math.round(all.length * 0.25), 5, 80);
      const chosen = new Set();

      // 已经发现的句子永远保留为关键句，避免重扫后掉高亮
      if (!keepOnly) {
        for (let i = 0; i < all.length; i++) {
          if (all[i].key && all[i].found) chosen.add(all[i].id);
        }
      }

      // 空间分散：按文章顺序切 K 段，每段至少挑一个最高分
      const K = clamp(Math.round(target * 0.9), 3, 18);
      const buckets = new Array(K);
      for (let i = 0; i < K; i++) buckets[i] = [];
      const n = all.length;
      for (let i = 0; i < n; i++) {
        const idx = Math.min(K - 1, Math.floor((i / n) * K));
        buckets[idx].push(all[i]);
      }
      for (let i = 0; i < K && chosen.size < target; i++) {
        let best = null;
        const b = buckets[i];
        for (let k = 0; k < b.length; k++) {
          if (chosen.has(b[k].id)) continue;
          if (!best || b[k].score > best.score) best = b[k];
        }
        if (best) chosen.add(best.id);
      }

      // 剩下的名额按全局分数补
      const sorted = all.slice().sort((x, y) => y.score - x.score);
      for (let i = 0; i < sorted.length && chosen.size < target; i++) {
        chosen.add(sorted[i].id);
      }

      for (let i = 0; i < all.length; i++) all[i].key = chosen.has(all[i].id);
      this.keySentences = all.filter(function (s) { return s.key; })
        .sort(function (a, b) { return a.articleIndex - b.articleIndex; });
      this.total = this.keySentences.length;
      this.found = this.keySentences.reduce(function (n2, s) { return n2 + (s.found ? 1 : 0); }, 0);
      this.rebuildKeyIndex();
    }

    /* =====================================================================
     * §4 高亮
     * ================================================================== */

    initHighlights() {
      this.foundBg = this.pickHighlightColor();
      const canUse = typeof CSS !== 'undefined' && CSS.highlights &&
        typeof Highlight === 'function';
      if (!canUse) {
        this.highlightMode = 'canvas';
        return;
      }
      this.highlightMode = 'api';
      const css = '::highlight(tldr-found){background-color:' + this.foundBg + ';' +
        'color:inherit;text-shadow:none;}' +
        '::highlight(tldr-hover){background-color:#ffe1a0;color:#241a05;text-shadow:none;}';

      /* 优先用「可构造样式表」注入：它在严格 CSP 的网站（很多新闻站）上也不会被拦。
         不支持时退回普通 <style> 标签，两者关闭时都会拆干净。 */
      let injected = false;
      try {
        if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          this.sheet = sheet;
          this.prevSheets = document.adoptedStyleSheets;
          document.adoptedStyleSheets = this.prevSheets.concat([sheet]);
          injected = true;
        }
      } catch (e) { injected = false; }

      if (!injected) {
        this.styleEl = document.createElement('style');
        this.styleEl.setAttribute('data-tldr-style', '1');
        this.styleEl.textContent = css;
        (document.head || document.documentElement).appendChild(this.styleEl);
      }

      this.hl = new Highlight();
      try { CSS.highlights.set('tldr-found', this.hl); } catch (e) { this.highlightMode = 'canvas'; }
    }

    /* 深色主题的网页给一条更淡的高亮，不然黄色会把正文盖住 */
    pickHighlightColor() {
      let luma = 255;
      try {
        let el = document.body;
        while (el) {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg && bg !== 'transparent' && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg)) {
            const m = bg.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
            if (m) luma = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
            break;
          }
          el = el.parentElement;
        }
      } catch (e) { /* 保持默认 */ }
      this.pageIsDark = luma < 110;
      return this.pageIsDark ? 'rgba(255,209,102,.20)' : CFG.FOUND_BG;
    }

    addHighlight(sent) {
      if (this.highlightMode !== 'api' || !this.hl) {
        this.highlightRectsDirty = true;
        return;
      }
      try { this.hl.add(sent.range); } catch (e) { /* Range 失效就跳过 */ }
    }

    rebuildHighlight() {
      if (this.highlightMode !== 'api' || !this.hl) { this.highlightRectsDirty = true; return; }
      this.hl.clear();
      for (let i = 0; i < this.sentences.length; i++) {
        const s = this.sentences[i];
        if (s.found) {
          try { this.hl.add(s.range); } catch (e) { /* 忽略 */ }
        }
      }
    }

    /* canvas 兜底：把已发现句子画成半透明黄块 */
    collectFallbackRects() {
      const rects = [];
      const sx = window.scrollX, sy = window.scrollY;
      for (let i = 0; i < this.sentences.length; i++) {
        const s = this.sentences[i];
        if (!s.found) continue;
        let list;
        try { list = s.range.getClientRects(); } catch (e) { continue; }
        for (let k = 0; k < list.length; k++) {
          const r = list[k];
          if (r.width < 1 || r.height < 1) continue;
          if (r.bottom < -200 || r.top > this.vh + 200) continue;
          rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
      this.highlightRects = rects;
      this.highlightRectsDirty = false;
      return rects;
    }

    /* =====================================================================
     * §5 glitch（可完整撤销）
     * ================================================================== */

    maybeGlitch(node, offset) {
      if (this.destroyed || this.glitches.length >= CFG.MAX_GLITCH) return;
      // 蜘蛛每秒检查 12 次，限流一下，不然整段文字会被刷爆
      const now = performance.now();
      if (now - (this.lastGlitchAt || 0) < 240) return;
      const chance = CFG.GLITCH_CHANCE * (this.prefersReduced ? 0.35 : 1);
      if (Math.random() > chance) return;
      if (!node || node.nodeType !== 3) return;
      if (this.protectedNodes && this.protectedNodes.has(node)) return;  // 关键句的节点不能拆
      const parent = node.parentElement;
      if (!parent) return;
      if (parent.closest('[data-tldr-glitch]')) return;
      if (parent.closest('a, button, label, h1, h2, h3, h4')) return;

      const v = node.nodeValue;
      if (!v || v.length < 6) return;
      let a = offset, b = offset;
      const ch = v.charAt(offset);
      if (!isWordChar(ch) && !isCJK(ch)) {
        // 光标落在空格/标点上，往左右各找一个词
        let l = offset, r = offset;
        while (l > 0 && !isWordChar(v.charAt(l - 1)) && !isCJK(v.charAt(l - 1))) l--;
        if (l === 0) return;
        a = l - 1; b = l;
      }

      if (isCJK(v.charAt(a))) {
        // 中文：取相邻 2 个字作为一个“词”
        if (v.length - a < 2) return;
        b = Math.min(v.length, a + 2);
      } else {
        while (a > 0 && isWordChar(v.charAt(a - 1))) a--;
        while (b < v.length && isWordChar(v.charAt(b))) b++;
        if (b - a < 3) return;
      }
      if (a > 0 && isWordChar(v.charAt(a - 1))) return;

      const word = v.slice(a, b);
      if (!word.trim()) return;

      let after, tail, span;
      try {
        after = node.splitText(a);            // node: [0,a) 之后的部分独立成 after
        tail = after.splitText(b - a);        // after 只剩“这个词”，tail 是词后面的内容
        span = document.createElement('span');
        span.textContent = word;
        span.setAttribute('data-tldr-glitch', '1');
        parent.replaceChild(span, after);     // 用 span 顶替“词”这个节点，tail 原地保留
      } catch (e) {
        return;
      }

      // 拆过节点，原节点偏移已经不可信，从索引里摘掉
      this.nodeIndex.delete(node);
      this.nodeIndex.delete(tail);

      // 随机 1~2 种效果
      const picked = [];
      const pool = GLITCH_EFFECTS.slice();
      const n = Math.random() < 0.45 ? 2 : 1;
      for (let i = 0; i < n && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        picked.push(pool[idx]);
        pool.splice(idx, 1);
      }
      for (let i = 0; i < picked.length; i++) {
        try { picked[i](span); } catch (e) { /* 忽略 */ }
      }
      span.style.color = span.style.color || '#4a4f56';

      const rec = {
        span: span,
        parent: parent,
        before: node,
        after: after,
        timer: 0
      };
      this.lastGlitchAt = now;
      this.glitches.push(rec);
      rec.timer = setTimeout(() => this.revertGlitch(rec), CFG.GLITCH_LIFE);
      if (this.glitches.length > CFG.MAX_GLITCH) {
        this.revertGlitch(this.glitches[0]);
      }
    }

    revertGlitch(rec) {
      if (!rec || rec.done) return;
      rec.done = true;
      clearTimeout(rec.timer);
      const i = this.glitches.indexOf(rec);
      if (i >= 0) this.glitches.splice(i, 1);
      try {
        if (rec.span && rec.span.parentNode) {
          const text = document.createTextNode(rec.span.textContent);
          rec.span.parentNode.replaceChild(text, rec.span);
        }
      } catch (e) { /* 页面可能已经把这块干掉了 */ }
      // 注意：这里不做 parent.normalize()，避免合并文本节点导致已有 Range 失效
    }

    revertAllGlitches() {
      const list = this.glitches.slice();
      for (let i = 0; i < list.length; i++) this.revertGlitch(list[i]);
      this.glitches.length = 0;
    }

    /* =====================================================================
     * §6 本地摘要 fallback
     * ================================================================== */

    localSummary(text) {
      let s = String(text).replace(/\s+/g, ' ').trim();
      s = s.replace(
        /^(and|but|however|also|according to|so|then|in addition|meanwhile|moreover|furthermore|nevertheless|nonetheless|as a result|in fact|of course|that said|still|yet)\b[\s,，:：-]*/i,
        ''
      );
      s = s.replace(/^(不过|但是|而且|此外|然而|据悉|同时|另外|因此|所以|而且|并且|可是|只是|至于)[\s,，、:：]*/, '');

      const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
      const isCjkHeavy = cjk > s.length * 0.25;

      if (isCjkHeavy) {
        // 中文：9 个单词 ≈ 16~18 个字
        const limit = 18;
        if (s.length > limit) {
          let cut = -1;
          for (let i = Math.min(s.length - 1, limit); i > 6; i--) {
            if ('，。；、,;：'.indexOf(s.charAt(i)) !== -1) { cut = i; break; }
          }
          s = (cut > 0 ? s.slice(0, cut) : s.slice(0, limit)).replace(/[，,。；;：:\s]+$/, '') + '…';
        }
        return s;
      }

      const words = s.split(/\s+/).filter(Boolean);
      if (words.length > 9) return words.slice(0, 9).join(' ') + '…';
      if (s.length > 78) {
        const clipped = s.slice(0, 78);
        const sp = clipped.lastIndexOf(' ');
        return (sp > 40 ? clipped.slice(0, sp) : clipped) + '…';
      }
      return s;
    }

    /* =====================================================================
     * §7 蜘蛛：构建 / 物理 / 步态
     * ================================================================== */

    initSpider() {
      const cx = this.pointer.cx + window.scrollX;
      const cy = this.pointer.cy + window.scrollY;
      this.spider = {
        x: cx,
        y: cy,
        vx: 0,
        vy: 0,
        heading: -Math.PI / 2,
        bob: 0
      };
      this.feet = [];
      for (let i = 0; i < LEGS.length; i++) {
        const rest = this.restFootWorld(i, this.spider);
        this.feet.push({
          x: rest.x,
          y: rest.y,
          from: { x: rest.x, y: rest.y },
          to: { x: rest.x, y: rest.y },
          state: 'planted',
          t: 0,
          dur: CFG.STEP_TIME * this.stepScale,
          delay: 0,
          lift: 0,
          err: 0,
          group: GAIT_A.indexOf(i) >= 0 ? 'A' : 'B'
        });
      }
      this.wander = { x: cx, y: cy, next: 0 };
    }

    /* 几何坐标（参考图像素）→ 页面坐标。
       参考图里「大身子 + 两条触肢」那一端在 +Y（触肢 y≈175~198），那才是嘴脸朝的方向，
       所以要让 +Y 对准 heading：rotate(heading - π/2)。
       以前写的是 +π/2，把 -Y（小身子那端）对准了前进方向 —— 于是触肢拖在屁股后面、
       整只蜘蛛倒着爬。 */
    spriteRotation(body) { return body.heading - Math.PI / 2; }

    toWorld(p, body) {
      const r = this.spriteRotation(body);
      const c = Math.cos(r), s = Math.sin(r);
      const lx = p.x * S, ly = p.y * S;
      return { x: body.x + lx * c - ly * s, y: body.y + lx * s + ly * c };
    }

    hipWorld(i, body) { return this.toWorld(LEGS[i].hip, body); }

    restFootWorld(i, body) { return this.toWorld(LEGS[i].foot, body); }

    /* 两段式 IK（余弦定理精确解）：大腿长、小腿长不相等，所以不能按「中垂线等分」算。
       两个解里按静止姿态记下的 bend 符号选，保证膝盖永远朝身体外侧顶出去。 */
    solveKnee(i, hip, foot, body) {
      const L = LEGS[i];
      const a = L.lenThigh, b = L.lenShin;
      let dx = foot.x - hip.x, dy = foot.y - hip.y;
      let d = Math.sqrt(dx * dx + dy * dy);

      // 够不着 / 太近都要夹一下，否则腿会拉断或对折。
      // 上限放到 98%：留一点点余量让膝盖始终保持可见的弯。以前是 0.94，
      // 脚一落后腿就被压缩回去，走动时看起来「脚变短了」。
      const maxD = (a + b) * 0.98;
      const minD = Math.abs(a - b) + 1.5;
      let reach = d;
      if (reach > maxD) reach = maxD;
      if (reach < minD) reach = minD;

      if (d < 0.001) { dx = 0; dy = 1; d = 1; }
      const ux = dx / d, uy = dy / d;
      const base = Math.atan2(dy, dx);
      const cosA = clamp((a * a + reach * reach - b * b) / (2 * a * reach), -1, 1);
      const A = Math.acos(cosA);

      const k1 = { x: hip.x + Math.cos(base + A) * a, y: hip.y + Math.sin(base + A) * a };
      const k2 = { x: hip.x + Math.cos(base - A) * a, y: hip.y + Math.sin(base - A) * a };
      const cross1 = ux * (k1.y - hip.y) - uy * (k1.x - hip.x);
      const knee = (Math.sign(cross1) === L.bend) ? k1 : k2;

      return {
        knee: knee,
        foot: { x: hip.x + ux * reach, y: hip.y + uy * reach }
      };
    }

    /* 固定时间步长的物理：加速 / 减速 / 转向都由弹簧阻尼完成 */
    stepPhysics(dt) {
      const body = this.spider;
      if (!body) return;
      const now = performance.now();
      const idle = now - this.pointer.lastMove > CFG.IDLE_MS;
      const maxSp = CFG.MAX_SPEED * this.motionScale;

      let tx, ty;
      if (!idle && this.pointer.has) {
        // 目标 = 光标的视口坐标 + 滚动量 → 滚动时自动跟着走
        tx = this.pointer.cx + window.scrollX;
        ty = this.pointer.cy + window.scrollY;
      } else {
        // 光标久未动：在当前视口里小范围游走
        if (now > this.wander.next) {
          this.wander.x = window.scrollX + rand(this.vw * 0.16, this.vw * 0.84);
          this.wander.y = window.scrollY + rand(this.vh * 0.18, this.vh * 0.82);
          this.wander.next = now + rand(2400, 4200);
        }
        tx = this.wander.x;
        ty = this.wander.y;
      }

      const dx = tx - body.x, dy = ty - body.y;
      const d = Math.sqrt(dx * dx + dy * dy);

      if (d <= CFG.STOP_DIST) {
        const damp = Math.exp(-9 * dt);
        body.vx *= damp;
        body.vy *= damp;
      } else {
        const desired = Math.min(maxSp, Math.max(70, d * 2.4));
        const tvx = (dx / d) * desired;
        const tvy = (dy / d) * desired;
        const k = 1 - Math.exp(-5.5 * dt);
        body.vx += (tvx - body.vx) * k;
        body.vy += (tvy - body.vy) * k;
      }

      let sp = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
      if (sp > maxSp && sp > 0) {
        body.vx = (body.vx / sp) * maxSp;
        body.vy = (body.vy / sp) * maxSp;
        sp = maxSp;
      }

      body.x += body.vx * dt;
      body.y += body.vy * dt;

      if (sp > 14) {
        const target = Math.atan2(body.vy, body.vx);
        body.heading = angleLerp(body.heading, target, 1 - Math.exp(-9 * dt));
      }

      body.speed = sp;
      body.bob = Math.sin(now / 90) * Math.min(1.6, sp / 260);
    }

    /* 交替步态：一组着地、另一组迈步，绝不两条腿同时离地 */
    updateFeet(dt) {
      const body = this.spider;
      if (!body) return;

      /* A. 先把“撇得太远、腿已经够不着”的脚拉回可达范围。
             每帧都做（包括正有脚在迈步时），保证画出来的脚尖 = 逻辑位置。 */
      for (let i = 0; i < this.feet.length; i++) {
        const f = this.feet[i];
        if (f.state === 'step') continue;
        const hip = this.hipWorld(i, body);
        const rest = this.restFootWorld(i, body);

        // 相对髋部的距离不能超过这条腿的总长，否则腿会被画成“够不到”
        const maxReach = LEGS[i].reach - 2;
        const hd = dist(f.x, f.y, hip.x, hip.y);
        if (hd > maxReach) {
          const k = maxReach / hd;
          f.x = hip.x + (f.x - hip.x) * k;
          f.y = hip.y + (f.y - hip.y) * k;
        }
        f.err = dist(f.x, f.y, rest.x, rest.y);
      }

      /* B. 推进正在迈的脚 */
      let stepping = false;
      for (let i = 0; i < this.feet.length; i++) {
        const f = this.feet[i];
        if (f.state !== 'step') continue;
        stepping = true;
        f.t += dt;
        const p = clamp((f.t - f.delay) / f.dur, 0, 1);
        if (p <= 0) continue;
        const e = easeInOut(p);
        f.x = lerp(f.from.x, f.to.x, e);
        f.y = lerp(f.from.y, f.to.y, e);
        f.lift = Math.sin(Math.PI * p) * (this.prefersReduced ? 4 : 9);
        if (p >= 1) {
          f.state = 'planted';
          f.lift = 0;
          f.x = f.to.x;
          f.y = f.to.y;
          this.onFootfall(i);
        }
      }
      if (stepping) return; // 有步态在跑，不发起新的一步

      /* C. 决定下一组要不要迈 */
      const groupErr = { A: 0, B: 0 };
      for (let i = 0; i < this.feet.length; i++) {
        const f = this.feet[i];
        if (f.err > groupErr[f.group]) groupErr[f.group] = f.err;
      }

      let pick = null;
      const spd = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
      /* 步距阈值：按速度算。落脚点固定落在静止位前方 lead*v 处，要让腿扇面在身体
         两侧保持居中，阈值就该是 (2*STEP_TIME - lead)*v；封顶用规格里的 80px。 */
      const thresh = spd < 20 ? 3.5
        : clamp((2 * CFG.STEP_TIME - 0.11) * spd, 16, CFG.STEP_DIST);
      let best = thresh;
      if (groupErr.A > best) { pick = 'A'; best = groupErr.A; }
      if (groupErr.B > best) { pick = 'B'; }
      if (!pick) return;

      // 另一组必须全部着地
      for (let i = 0; i < this.feet.length; i++) {
        if (this.feet[i].state !== 'planted') return;
      }

      const group = pick === 'A' ? GAIT_A : GAIT_B;
      const fwdX = Math.cos(body.heading), fwdY = Math.sin(body.heading);
      // 落脚点做一点前导，抵消迈步这 0.13s 里身体继续跑掉的位移。
      // 前导与抖动都按速度缩放：站着不动时脚必须精确回到静止位，否则膝盖会被
      // 两圆求交放大成肉眼可见的偏差，整只蜘蛛的姿态就跟参考图对不上了。
      const lead = 0.11;
      const moveK = clamp(spd / 160, 0, 1);
      const jitter = 2.2 * moveK;
      for (let g = 0; g < group.length; g++) {
        const idx = group[g];
        const f = this.feet[idx];
        const rest = this.restFootWorld(idx, body);
        const hip = this.hipWorld(idx, body);
        f.from = { x: f.x, y: f.y };
        f.to = {
          x: rest.x + body.vx * lead + fwdX * 4 * moveK + rand(-jitter, jitter),
          y: rest.y + body.vy * lead + fwdY * 4 * moveK + rand(-jitter, jitter)
        };
        // 落点也得在这条腿够得着的范围内
        const legReach = LEGS[idx].reach - 2;
        const td = dist(f.to.x, f.to.y, hip.x, hip.y);
        if (td > legReach) {
          const k = legReach / td;
          f.to.x = hip.x + (f.to.x - hip.x) * k;
          f.to.y = hip.y + (f.to.y - hip.y) * k;
        }
        f.state = 'step';
        f.t = 0;
        // 轻微的错峰让动作更有生命感，但整组仍然在 0.13s 内落完
        f.delay = g * 0.012;
        f.dur = Math.max(0.05, CFG.STEP_TIME * this.stepScale - f.delay);
      }
    }

    onFootfall(i) {
      const f = this.feet[i];
      if (!f) return;
      this.spawnRipple(f.x, f.y);
      this.probe(f.x - window.scrollX, f.y - window.scrollY);
    }

    spawnRipple(x, y) {
      if (this.prefersReduced) return;
      if (this.ripples.length > 24) this.ripples.shift();
      this.ripples.push({ x: x, y: y, t: 0, life: 0.42 });
    }

    updateRipples(dt) {
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        this.ripples[i].t += dt;
        if (this.ripples[i].t >= this.ripples[i].life) this.ripples.splice(i, 1);
      }
    }

    /* =====================================================================
     * §8 渲染
     * ================================================================== */

    buildShadow() {
      const host = document.createElement('div');
      host.setAttribute(HOST_ATTR, '1');
      host.style.cssText =
        'position:fixed!important;left:0!important;top:0!important;' +
        'width:100%!important;height:100%!important;margin:0!important;padding:0!important;' +
        'border:0!important;background:transparent!important;' +
        'pointer-events:none!important;z-index:2147483646!important;' +
        'display:block!important;transform:none!important;';
      this.host = host;

      const shadow = host.attachShadow({ mode: 'open' });
      this.shadow = shadow;

      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      shadow.appendChild(style);

      const canvas = document.createElement('canvas');
      canvas.style.cssText =
        'position:fixed;left:0;top:0;width:100%;height:100%;display:block;' +
        'pointer-events:none;background:transparent;';
      shadow.appendChild(canvas);
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resizeCanvas();

      const panel = document.createElement('div');
      panel.className = 'panel';
      // 用 DOMParser 而不是 innerHTML：遇到要求 Trusted Types 的网站也不会抛错
      try {
        const parsed = new DOMParser().parseFromString(
          '<body>' + PANEL_HTML + '</body>', 'text/html'
        );
        while (parsed.body.firstChild) panel.appendChild(parsed.body.firstChild);
      } catch (e) {
        // 极端环境下的兜底：至少把标题和按钮放进去了，功能仍可用
        const hd = document.createElement('div');
        hd.className = 'hd';
        hd.textContent = 'TL;DR';
        panel.appendChild(hd);
      }
      shadow.appendChild(panel);
      this.panelEl = panel;

      (document.body || document.documentElement).appendChild(host);
    }

    resizeCanvas() {
      if (!this.canvas) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.vw = window.innerWidth;
      this.vh = window.innerHeight;
      const w = Math.round(this.vw * this.dpr);
      const h = Math.round(this.vh * this.dpr);
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    render() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.vw, this.vh);

      // 兜底高亮不能先画：身体和腿之间那道缝是用 destination-out 擦出来的，
      // 先画的高亮会被一起擦出个缺口，所以留到「腿之后、身体之前」再画。
      const canvasHl = this.highlightMode === 'canvas';

      const body = this.spider;
      const sx = window.scrollX, sy = window.scrollY;
      if (!body) {
        if (canvasHl) this.drawFallbackHighlights(ctx);
        /* 蜘蛛还没建好也要画飞行的关键词，否则词飞到一半会消失 */
        ctx.save();
        ctx.translate(-sx, -sy);
        this.drawFlyers(ctx);
        ctx.restore();
        return;
      }

      ctx.save();
      ctx.translate(-sx, -sy);   // 之后一律用页面坐标画
      this.drawSpider(ctx, body, canvasHl ? () => {
        ctx.save();
        ctx.translate(sx, sy);
        this.drawFallbackHighlights(ctx);
        ctx.restore();
      } : null);

      // 脚落地涟漪
      for (let i = 0; i < this.ripples.length; i++) {
        const r = this.ripples[i];
        const p = r.t / r.life;
        const rad = 3 + p * 16;
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(90,184,255,' + (0.45 * (1 - p)).toFixed(3) + ')';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      /* 关键词飞入：和蜘蛛同一层（页面坐标），压在涟漪之上 */
      this.drawFlyers(ctx);
      ctx.restore();
    }

    /* =====================================================================
     * §8.5 关键词飞入蛛网
     * AI 返回、胶囊长出来后，从原文那句的位置拉一根蛛丝，把抽出的关键词
     * 送到胶囊上方停一下再淡出。纯视觉强调，不动网上的数据和布局。
     * ================================================================== */

    /* 从关键句里抽一个 2–6 字关键词（纯正则启发式，只服务视觉，不强求语义完美） */
    extractKeyword(text) {
      const s = String(text || '').replace(/\s+/g, ' ').trim();
      if (!s) return '';
      let m;

      /* 1) 书名号 / 引号里的话，往往就是核心名词 */
      m = s.match(/《([^》]{2,6})》/);
      if (m) return m[1];
      m = s.match(/[“"「『]([^”"」』]{2,6})[”"」』]/);
      if (m) return m[1];

      /* 2) 数字 + 单位：12% / 3.5 亿 / 20 万台 —— 有数字时这是最硬的词 */
      m = s.match(/(\d+(?:\.\d+)?\s*(?:%|％|亿|万|千|倍|个百分点|美元|欧元|元|人|台|家|项|个|年|月|天|小时|分钟|秒))/);
      if (m) return m[1].replace(/\s+/g, '').slice(0, 6);

      /* 3) 英文专名 / 缩写：GPT-4 / iPhone / EU */
      m = s.match(/\b([A-Z][A-Za-z0-9.\-]{1,5})\b/);
      if (m) return m[1];

      /* 4) 术语后缀：利用率 / 破碎化 / 产能 …… 只保留不易误伤的后缀
            （单个「数/量/比/期/额」太容易在任意句子里误匹配，去掉） */
      m = s.match(/([\u4e00-\u9fa5]{2,4})(?:率|性|化|型|效应|成本|风险|产能|市场|政策|需求|供给|趋势|结构|机制|模式|能力|水平|规模|周期)/);
      if (m) return m[0].slice(0, 6);

      /* 5) 兜底：第一个不是「的/了/我们/可以」这类虚词开头的 2–6 字汉字串 */
      const runs = s.match(/[\u4e00-\u9fa5]{2,6}/g) || [];
      for (let i = 0; i < runs.length; i++) {
        if (!/^(的|了|是|在|和|与|也|就|都|而|及|或|对|从|把|被|让|使|这|那|我们|他们|可以|已经|表示|认为|一个|一种|进行|通过|因为|所以|但是|如果|以及|以上|以下|目前|现在|其中|此外|同时)/.test(runs[i])) {
          return runs[i];
        }
      }
      return '';
    }

    /* 起点的视口坐标：句子可能滚出屏幕，夹到最近的视口边缘 */
    startOf(sent) {
      if (!sent || !sent.range) return null;
      let rects = null;
      try { rects = sent.range.getClientRects(); } catch (e) { return null; }
      if (!rects || !rects.length) return null;
      const r = rects[0];
      if (!r || (r.width < 1 && r.height < 1)) return null;
      let x = r.left + r.width / 2;
      let y = r.top + r.height / 2;
      const m = 22;
      if (x < m) x = m; else if (x > this.vw - m) x = this.vw - m;
      if (y < m) y = m; else if (y > this.vh - m) y = this.vh - m;
      return { x: x, y: y };
    }

    /* 给「本轮新增」的胶囊各派一个飞行的词；silent=true 时只记 id 不飞（首次织网） */
    spawnKeywords(nodes, silent) {
      const next = new Set();
      for (let i = 0; i < nodes.length; i++) next.add(String(nodes[i].id));
      const prev = this.onWebSids;
      this.onWebSids = next;

      if (silent || this.prefersReduced || !this.webHost || !this.flyers) return;

      let fired = 0;
      for (let i = 0; i < nodes.length && fired < 8; i++) {
        const s = nodes[i];
        const key = String(s.id);
        if (prev.has(key)) continue;                    // 上轮就在网上，不再飞
        const pill = this.webHost.querySelector('.pill[data-sid="' + s.id + '"]');
        if (!pill) continue;
        const st = this.startOf(s);
        if (!st) continue;
        /* AI 抽的 kw 最准；模型没给（旧缓存 / 解析失败）才用正则兜底 */
        const kw = (s.web && s.web.kw) || this.extractKeyword(s.text) || String(s.summary || s.text || '').slice(0, 6);
        if (!kw) continue;

        const r = pill.getBoundingClientRect();
        if (!r || (r.width < 1 && r.height < 1)) continue;
        const x1 = r.left + r.width / 2;
        const y1 = r.top + r.height / 2;
        const dx = x1 - st.x, dy = y1 - st.y;
        this.flyers.push({
          sid: s.id,
          kw: kw,
          x0: st.x, y0: st.y,
          x1: x1, y1: y1,
          cx: st.x + dx * 0.5,
          cy: st.y + dy * 0.5 - Math.min(80, Math.abs(dx) * 0.18 + 26),
          ph: r.height || 16,
          t: -fired * 0.11,                             // 错峰 110ms，词多也能一个个看清
          dur: 0.95, hold: 0.85, fade: 0.50             // 飞慢一点、停久一点，别一闪而过
        });
        fired++;
      }
    }

    /* 重画后胶囊换了新 DOM：让在飞的词改追新位置，别飞到旧位置上 */
    retargetFlyers() {
      if (!this.flyers || !this.flyers.length || !this.webHost) return;
      for (let i = 0; i < this.flyers.length; i++) {
        const f = this.flyers[i];
        const pill = this.webHost.querySelector('.pill[data-sid="' + f.sid + '"]');
        if (!pill) continue;
        const r = pill.getBoundingClientRect();
        if (!r || (r.width < 1 && r.height < 1)) continue;
        f.x1 = r.left + r.width / 2;
        f.y1 = r.top + r.height / 2;
        f.ph = r.height || 16;
        const dx = f.x1 - f.x0, dy = f.y1 - f.y0;
        f.cx = f.x0 + dx * 0.5;
        f.cy = f.y0 + dy * 0.5 - Math.min(80, Math.abs(dx) * 0.18 + 26);
      }
    }

    updateFlyers(dt) {
      if (!this.flyers || !this.flyers.length) return;
      for (let i = this.flyers.length - 1; i >= 0; i--) {
        const f = this.flyers[i];
        f.t += dt;
        if (f.t >= f.dur + f.hold + f.fade) this.flyers.splice(i, 1);
      }
    }

    /* 二次贝塞尔求值（弧线像蛛丝自然垂坠，不用直线） */
    bez(a, b, c, t) {
      const it = 1 - t;
      return it * it * a + 2 * it * t * b + t * t * c;
    }

    /* 在「页面坐标」上下文里画丝和词（render 已 translate(-scrollX,-scrollY)） */
    drawFlyers(ctx) {
      if (!this.flyers || !this.flyers.length) return;
      const sx = window.scrollX, sy = window.scrollY;
      for (let i = 0; i < this.flyers.length; i++) {
        const f = this.flyers[i];
        if (f.t < 0) continue;

        let px, py, alpha = 1, flying = false, e = 1;
        if (f.t < f.dur) {
          flying = true;
          /* 缓入缓出：起手和落点都慢，中段才快——比 easeOut 的「开头猛冲」看得清 */
          const p = f.t / f.dur;
          e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          px = this.bez(f.x0, f.cx, f.x1, e);
          py = this.bez(f.y0, f.cy, f.y1, e);
        } else if (f.t < f.dur + f.hold) {
          px = f.x1;
          py = f.y1 - f.ph / 2 - 11;                     // 停在胶囊正上方
        } else {
          const q = (f.t - f.dur - f.hold) / f.fade;
          alpha = Math.max(0, 1 - q);
          px = f.x1;
          py = f.y1 - f.ph / 2 - 11 - q * 9;             // 淡出时轻轻上飘
        }

        /* 飞行途中拉一根白丝，到位置就收 */
        if (flying && e > 0.02) {
          ctx.beginPath();
          const steps = 12;
          for (let k = 0; k <= steps; k++) {
            const t = e * k / steps;
            const x = this.bez(f.x0, f.cx, f.x1, t) + sx;
            const y = this.bez(f.y0, f.cy, f.y1, t) + sy;
            if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * (1 - e * 0.55)).toFixed(3) + ')';
          ctx.lineWidth = 1.1;
          ctx.stroke();
        }

        /* 词：深色描边 + 金色填充，压在网页上也读得清 */
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = '700 13.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tx = px + sx, ty = py + sy;
        ctx.lineWidth = 3.8;
        ctx.strokeStyle = 'rgba(9,11,15,.88)';
        ctx.strokeText(f.kw, tx, ty);
        ctx.fillStyle = '#ffd166';
        ctx.fillText(f.kw, tx, ty);
        ctx.restore();
      }
    }

    drawFallbackHighlights(ctx) {
      if (this.highlightRectsDirty) this.collectFallbackRects();
      if (!this.highlightRects.length) return;
      ctx.save();
      ctx.fillStyle = this.foundBg || CFG.FOUND_BG;
      for (let i = 0; i < this.highlightRects.length; i++) {
        const r = this.highlightRects[i];
        ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      }
      ctx.restore();
    }

    /* 蜘蛛本体：8 条腿（深灰大腿 + 白圈关节 + 浅灰小腿）+ 一对触肢 + 两节身体。
       配色、分段、关节样式照参考图；额外加的是「伪金属」——腿的受光侧一条细反光、
       身体受光侧一道亮弧和背光侧一道暗边、外加极低频的一次扫光。
       全部是渐变/描线，不改轮廓、不加外描边，所以整体还是平涂矢量风。 */
    drawSpider(ctx, body, midHook) {
      const TAU = Math.PI * 2;
      const bob = body.bob || 0;
      const lw = LEG_W;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      /* 先把每条腿的关节位置算出来 */
      const chains = [];
      for (let i = 0; i < this.feet.length; i++) {
        const f = this.feet[i];
        const L = LEGS[i];
        const hip = this.toWorld(L.hip, body);
        const solved = this.solveKnee(i, hip, { x: f.x, y: f.y - f.lift }, body);
        const knee = solved.knee;
        const foot = solved.foot;

        // 后两对腿：小腿上半段再折一次，折点就是参考图上那个第二个关节
        let mid = null;
        if (L.mid) {
          const vx = foot.x - knee.x, vy = foot.y - knee.y;
          const len = Math.sqrt(vx * vx + vy * vy) || 1;
          const ux = vx / len, uy = vy / len;
          mid = {
            x: knee.x + ux * (L.midT * len) - uy * (L.midH * len),
            y: knee.y + uy * (L.midT * len) + ux * (L.midH * len)
          };
        }
        chains.push({ hip: hip, knee: knee, mid: mid, foot: foot });
      }

      /* 1+2. 腿：先按段铺底色（大腿深灰、小腿浅灰），
              再在每段的受光侧补一条更细的亮线 —— 就是「金属管」那种高光。
              拆成单段数组是因为反光要按段算方向，拐点处不能连成一条折线。 */
      const segs = [];
      for (let i = 0; i < chains.length; i++) {
        const c = chains[i];
        segs.push({ a: c.hip, b: c.knee, dark: true });
        if (c.mid) {
          segs.push({ a: c.knee, b: c.mid, dark: false });
          segs.push({ a: c.mid, b: c.foot, dark: false });
        } else {
          segs.push({ a: c.knee, b: c.foot, dark: false });
        }
      }

      ctx.lineWidth = lw;
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? C_DARK : C_LIGHT;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (s.dark !== (pass === 0)) continue;
          ctx.beginPath();
          ctx.moveTo(s.a.x, s.a.y);
          ctx.lineTo(s.b.x, s.b.y);
          ctx.stroke();
        }
      }

      /* 反光：往受光那一侧平移「腿宽 × SPECK_OFF」，再用更细的线重描一遍。
         亮度按「段的法线朝不朝光」衰减 —— 正对光的段最亮、掠射的段几乎看不见，
         这样 8 条腿的高光位置是一致的（像同一盏灯照的），不会各亮各的。 */
      if (SHEEN > 0 && METAL.SPECK > 0) {
        ctx.lineWidth = lw * METAL.SPECK_W;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          let dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          dx /= len; dy /= len;
          let nx = -dy, ny = dx;
          let lit = nx * LIGHT.x + ny * LIGHT.y;
          if (lit < 0) { nx = -nx; ny = -ny; lit = -lit; }
          const alpha = METAL.SPECK * SHEEN * (0.22 + 0.78 * lit);
          if (alpha < 0.03) continue;
          const off = lw * METAL.SPECK_OFF;
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = s.dark ? C_SPECK_DARK : C_SPECK_LIGHT;
          ctx.beginPath();
          ctx.moveTo(s.a.x + nx * off, s.a.y + ny * off);
          ctx.lineTo(s.b.x + nx * off, s.b.y + ny * off);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      /* 3. 关节：白色圆环 + 深灰实心点，卡在两段接缝上 */
      for (let i = 0; i < chains.length; i++) {
        const c = chains[i];
        const pts = c.mid ? [c.knee, c.mid] : [c.knee];
        for (let k = 0; k < pts.length; k++) {
          ctx.beginPath();
          ctx.arc(pts[k].x, pts[k].y, JOINT_R, 0, TAU);
          ctx.fillStyle = C_JOINT;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(pts[k].x, pts[k].y, JOINT_DOT, 0, TAU);
          ctx.fillStyle = C_DARK;
          ctx.fill();
        }
      }

      /* 4. 触肢、身体、以及身体和腿之间那道缝。
            参考图是分层画的：腿先画，身体再压上去，身体一圈还留了白边。
            这里照同样的次序做 —— 先画触肢，再沿身体轮廓擦掉一圈（destination-out），
            最后才把身体填上去，于是腿在贴近身体的地方自然断开一道缝。 */
      ctx.save();
      ctx.translate(body.x, body.y + bob);
      ctx.rotate(this.spriteRotation(body));

      ctx.strokeStyle = C_DARK;
      ctx.lineWidth = 17 * S;
      for (let i = 0; i < PALPS.length; i++) {
        const p = PALPS[i];
        ctx.beginPath();
        ctx.moveTo(p.a.x * S, p.a.y * S);
        ctx.quadraticCurveTo(p.c.x * S, p.c.y * S, p.b.x * S, p.b.y * S);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 8 * S;
      ctx.lineJoin = 'round';
      superEllipsePath(ctx, BODY_GEO.head, S);
      ctx.stroke();
      superEllipsePath(ctx, BODY_GEO.abdo, S);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';

      // 兜底高亮插在这里：比腿晚（不会被擦出缺口）、比身体早（不会盖住蜘蛛）
      if (midHook) midHook();

      /* 身体两节：平涂底色 + 受光侧亮弧 + 背光侧暗边（伪金属）。
         光向先反解成局部坐标，这样光在屏幕上是钉住的 —— 蜘蛛转身时高光会真的换边。 */
      const Lloc = lightLocal(this.spriteRotation(body));
      this.fillMetalLobe(ctx, BODY_GEO.head, Lloc, S);
      this.fillMetalLobe(ctx, BODY_GEO.abdo, Lloc, S);
      this.drawSheenSweep(ctx, BODY_GEO, Lloc, S, performance.now());

      // 两节之间那道深灰腰
      ctx.fillStyle = C_DARK;
      ctx.beginPath();
      ctx.ellipse(BODY_GEO.waist.x * S, BODY_GEO.waist.y * S,
        BODY_GEO.waist.rx * S, BODY_GEO.waist.ry * S, 0, 0, TAU);
      ctx.fill();

      // 腹部上的青色斑点
      ctx.fillStyle = C_TEAL;
      ctx.beginPath();
      ctx.arc(BODY_GEO.dot.x * S, BODY_GEO.dot.y * S, BODY_GEO.dot.r * S, 0, TAU);
      ctx.fill();

      ctx.restore();
    }

    /* 一节身体：平涂 + 受光侧一道亮弧 + 背光侧一道暗边。
       两道都用「裁剪进形状里」的线性渐变画，所以不会糊出轮廓、也不需要描边；
       亮弧的位置和宽度由 RIM_T 控制 —— 越接近 1 越贴边，看着就是 1~2px 的一道边光。 */
    fillMetalLobe(ctx, g, L, k) {
      ctx.save();
      superEllipsePath(ctx, g, k);
      ctx.fillStyle = C_LIGHT;
      ctx.fill();
      ctx.clip();

      const cx = g.x * k, cy = g.y * k;
      const rx = Math.max(g.rx * k, 0.5), ry = Math.max(g.ry * k, 0.5);
      const R = superEllipseRadius(g, k, L);   // 沿光轴到轮廓的真实距离
      const bx = cx - rx * 1.4, by = cy - ry * 1.4, bw = rx * 2.8, bh = ry * 2.8;

      if (SHEEN > 0) {
        const rim = METAL.RIM * SHEEN;
        /* 亮弧要「贴边」：只有靠近轮廓的那一小段才亮，中间保持平涂本色。
           所以前面 80% 全是 0，峰值压在 0.97 上 —— 换算下来就是边上 1~2px 的一道。 */
        ctx.fillStyle = rimGradient(ctx, cx, cy, L, R, [
          [0, 'rgba(255,255,255,0)'],
          [0.80, 'rgba(255,255,255,0)'],
          [0.90, 'rgba(255,255,255,' + (rim * 0.16).toFixed(3) + ')'],
          [0.97, 'rgba(255,255,255,' + rim.toFixed(3) + ')'],
          [1, 'rgba(255,255,255,' + (rim * 0.55).toFixed(3) + ')']
        ]);
        ctx.fillRect(bx, by, bw, bh);

        /* 暗边同理：只在背光侧贴边的 15% 范围内压暗，不往中间糊 */
        const sh = METAL.SHADE * SHEEN;
        ctx.fillStyle = rimGradient(ctx, cx, cy, L, R, [
          [0, 'rgba(0,0,0,' + sh.toFixed(3) + ')'],
          [0.05, 'rgba(0,0,0,' + (sh * 0.78).toFixed(3) + ')'],
          [0.16, 'rgba(0,0,0,0)'],
          [1, 'rgba(0,0,0,0)']
        ]);
        ctx.fillRect(bx, by, bw, bh);
      }

      ctx.restore();
    }

    /* 极低频扫光：每 SWEEP_PERIOD 从身体上快速滑过一道窄亮带（约 300ms）。
       其余时间什么都不画，所以平时看到的就是静态高光，扫光只当偶尔的一次「反光」。 */
    drawSheenSweep(ctx, geo, L, k, now) {
      if (!METAL.SWEEP_ON || SHEEN <= 0 || this.prefersReduced) return;
      const t = now % METAL.SWEEP_PERIOD;
      if (t > METAL.SWEEP_LIFE) return;

      const p = t / METAL.SWEEP_LIFE;
      const fade = Math.sin(Math.PI * p);          // 两头淡入淡出，不硬切
      const A = { x: -L.y, y: L.x };               // 扫光方向：与光轴垂直
      const cx = geo.abdo.x * k;
      const cy = (geo.abdo.y + geo.head.y) * 0.5 * k;
      const R = Math.max(geo.abdo.rx, geo.abdo.ry) * k;
      const pos = (p * 2 - 1) * R * 1.05;
      const half = R * METAL.SWEEP_HALF;

      const a = METAL.SWEEP_ALPHA * SHEEN * fade;
      const grad = ctx.createLinearGradient(
        cx + A.x * (pos - half), cy + A.y * (pos - half),
        cx + A.x * (pos + half), cy + A.y * (pos + half)
      );
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,' + a.toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(255,255,255,0)');

      ctx.save();
      ctx.beginPath();
      superEllipseAppend(ctx, geo.head, k);
      superEllipseAppend(ctx, geo.abdo, k);
      ctx.clip();
      ctx.fillStyle = grad;
      ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
      ctx.restore();
    }

    /* =====================================================================
     * §9 踩踏与文本检测
     * ================================================================== */

    /* 主循环每 80ms 跑一次：身体中心 + 所有着地的脚 */
    tickScan() {
      if (this.destroyed || !this.spider) return;
      const body = this.spider;
      const sx = window.scrollX, sy = window.scrollY;
      this.probe(body.x - sx, body.y - sy);
      for (let i = 0; i < this.feet.length; i++) {
        if (this.feet[i].state !== 'planted') continue;
        this.probe(this.feet[i].x - sx, this.feet[i].y - sy);
      }
    }

    probe(clientX, clientY) {
      if (clientX < 0 || clientY < 0 || clientX > this.vw || clientY > this.vh) return;
      const hit = this.caretAt(clientX, clientY);
      if (!hit || !hit.node || hit.node.nodeType !== 3) return;
      const sent = this.lookupSentence(hit.node, hit.offset);
      if (sent) this.discover(sent);
      else this.maybeGlitch(hit.node, hit.offset);
    }

    caretAt(x, y) {
      if (typeof document.caretRangeFromPoint === 'function') {
        try {
          const r = document.caretRangeFromPoint(x, y);
          if (r) return { node: r.startContainer, offset: r.startOffset };
        } catch (e) { /* 继续走 fallback */ }
      }
      if (typeof document.caretPositionFromPoint === 'function') {
        try {
          const p = document.caretPositionFromPoint(x, y);
          if (p && p.offsetNode) return { node: p.offsetNode, offset: p.offset };
        } catch (e) { /* 继续 */ }
      }
      // 最后的兜底：命中元素里的第一个文本节点
      const el = document.elementFromPoint(x, y);
      if (!el || isOurs(el)) return null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      const n = walker.nextNode();
      if (!n) return null;
      const len = (n.nodeValue || '').length;
      return { node: n, offset: clamp(Math.floor(len * 0.5), 0, Math.max(0, len - 1)) };
    }

    /* 蜘蛛踩到一条尚未发现的关键句 */
    discover(sent) {
      if (!sent || !sent.key || sent.found) return;
      if (!sent.range.startContainer || !sent.range.startContainer.isConnected) return;

      sent.found = true;
      this.found++;
      this.addHighlight(sent);
      sent.summary = sent.summary || this.localSummary(sent.text);
      this.addEntry(sent);
      this.updatePanelCounts();
      this.queueApi(sent);
      this.maybeAutoVerdict();

      const body = this.spider;
      if (body) this.spawnRipple(body.x, body.y);
    }

    /* =====================================================================
     * §10 浮动面板
     * ================================================================== */

    buildPanel() {
      const panel = this.panelEl;
      if (!panel) return;

      panel.addEventListener('click', (e) => {
      /* 详情卡开着时：点卡片外面（又不是点另一颗胶囊、也不是点中心标题）就收起 */
      if (this.webCardSid != null && this.webCardSid !== -1) {
          const t = e.target;
          const inCard = t && t.closest ? t.closest('.webcard') : null;
          const onPill = t && t.closest
            ? t.closest('.pill[data-sid], .pill.hub')
            : null;
          if (!inCard && !onPill) this.closeWebCard();
        }
        const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        if (act === 'copy') this.copyAll();
        else if (act === 'restart') this.restart();
        else if (act === 'close') this.destroy();
        else if (act === 'ai') this.runVerdict();
        else if (act === 'mode') this.setSumMode(btn.getAttribute('data-mode'), true);
        else if (act === 'conn') this.onConnClick();
        else if (act === 'fold') this.toggleFold();
        else if (act === 'zoom') this.toggleZoom();
      });

      /* 拖标题移动面板 */
      const hd = panel.querySelector('.hd');
      /* 放大按钮在标题栏里：别让它顺手把面板拖走 */
      const zoomBtn = this.shadow.getElementById('zoom');
      if (zoomBtn) zoomBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      let dragging = false, ox = 0, oy = 0;
      hd.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const r = panel.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        dragging = true;
        panel.classList.add('dragging');
        try { hd.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        e.preventDefault();
      });
      hd.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const x = clamp(e.clientX - ox, 4, Math.max(4, window.innerWidth - w - 4));
        const y = clamp(e.clientY - oy, 4, Math.max(4, window.innerHeight - h - 4));
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
        panel.style.right = 'auto';
      });
      const stop = (e) => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('dragging');
        try { hd.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      };
      hd.addEventListener('pointerup', stop);
      hd.addEventListener('pointercancel', stop);

      /* 蛛网：悬停看全文并同步高亮网页原句，点击展开详情卡 */
      const web = this.shadow.getElementById('web');
      if (web) {
        this.webHost = web;
        web.addEventListener('mouseover', (e) => this.onWebHover(e, true));
        web.addEventListener('mouseout', (e) => this.onWebHover(e, false));
        web.addEventListener('click', (e) => this.onWebClick(e));
      }

      /* 详情卡：定位原文 / 复制这句 / 关闭 */
      const card = this.shadow.getElementById('webCard');
      if (card) {
        card.addEventListener('click', (e) => {
          const b = e.target && e.target.closest ? e.target.closest('[data-wc]') : null;
          if (!b) return;
          e.stopPropagation();
          const act = b.getAttribute('data-wc');
          if (act === 'close') this.closeWebCard();
          else if (act === 'plain-retry') this.loadPlain();
          else if (act === 'plain-copy') {
            const text = this.plainCache && this.plainCache.text;
            if (!text) return;
            const done = () => this.toast('已复制大白话总结');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(done, () => {
                if (this.legacyCopy(text)) done(); else this.toast('复制失败');
              });
            } else if (this.legacyCopy(text)) done();
          }
          else if (act === 'locate') this.locateSentence(this.webCardSent);
          else if (act === 'copy') {
            const s = this.webCardSent;
            if (!s) return;
            const done = () => this.toast('已复制这句');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(s.text).then(done, () => {
                if (this.legacyCopy(s.text)) done(); else this.toast('复制失败');
              });
            } else if (this.legacyCopy(s.text)) done();
          }
        });
      }
      this.setFold(this.folded);

      /* 版本号：一眼确认浏览器里跑的是不是最新代码（防止改了没刷新的乌龙） */
      try {
        const ver = this.shadow.getElementById('ver');
        if (ver) ver.textContent = 'v' + chrome.runtime.getManifest().version;
      } catch (e) { /* mock 环境忽略 */ }

      this.updatePanelCounts();
    }

    updatePanelCounts() {
      if (!this.shadow) return;
      const f = this.shadow.getElementById('found');
      const t = this.shadow.getElementById('total');
      const fill = this.shadow.getElementById('fill');
      if (f) f.textContent = String(this.found);
      if (t) t.textContent = String(this.total);
      if (fill) {
        const pct = this.total > 0 ? clamp((this.found / this.total) * 100, 0, 100) : 0;
        fill.style.width = pct.toFixed(1) + '%';
      }
    }

    addEntry(sent) {
      if (!this.shadow) return;
      const list = this.shadow.getElementById('list');
      if (!list) return;
      if (this.entries.has(sent.id)) return;

      const li = document.createElement('li');
      li.className = 'item';
      li.setAttribute('data-id', String(sent.id));

      const num = document.createElement('span');
      num.className = 'num';
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = sent.summary;
      li.appendChild(num);
      li.appendChild(txt);

      /* 按文章顺序插入 */
      let placed = false;
      const kids = list.children;
      for (let i = 0; i < kids.length; i++) {
        const other = this.entries.get(Number(kids[i].getAttribute('data-id')));
        if (other && other.sent.articleIndex > sent.articleIndex) {
          list.insertBefore(li, kids[i]);
          placed = true;
          break;
        }
      }
      if (!placed) list.appendChild(li);

      this.entries.set(sent.id, { li: li, txt: txt, sent: sent });
      this.renumber();

      li.classList.add('fresh');
      setTimeout(() => { if (li.isConnected) li.classList.remove('fresh'); }, 1000);

      /* 只滚动列表面板，绝不影响网页 */
      const top = li.offsetTop;
      const bottom = top + li.offsetHeight;
      if (bottom > list.scrollTop + list.clientHeight - 4) {
        list.scrollTop = bottom - list.clientHeight + 8;
      }
      this.updateFoldCount();
    }

    renumber() {
      if (!this.shadow) return;
      const list = this.shadow.getElementById('list');
      if (!list) return;
      for (let i = 0; i < list.children.length; i++) {
        const n = list.children[i].querySelector('.num');
        if (n) n.textContent = String(i + 1) + '.';
      }
    }

    updateEntrySummary(sent) {
      const rec = this.entries.get(sent.id);
      if (!rec) return;
      rec.txt.textContent = sent.summary;
      rec.li.classList.remove('fresh');
      // 强制重排后重新加上，让高亮闪一下
      void rec.li.offsetWidth;
      rec.li.classList.add('fresh');
      setTimeout(() => { if (rec.li.isConnected) rec.li.classList.remove('fresh'); }, 900);
    }

    /* ---------------------------------------------------------------------
     * 蛛网图谱：AI 每返回一批结构化数据，网上就长几个节点
     * ------------------------------------------------------------------ */

    /* 折叠 / 展开原文列表 */
    setFold(folded) {
      this.folded = !!folded;
      if (this.panelEl) this.panelEl.classList.toggle('folded', this.folded);
      const k = this.shadow ? this.shadow.getElementById('foldK') : null;
      if (k) k.textContent = this.folded ? '展开' : '收起';
      this.updateFoldCount();
    }

    toggleFold() { this.setFold(!this.folded); }

    updateFoldCount() {
      if (!this.shadow) return;
      const cnt = this.shadow.getElementById('foldCnt');
      if (cnt) cnt.textContent = '（' + this.entries.size + ' 条）';
    }

    /* 页面的主题：优先 h1，其次标题里第一段 */
    pageTopic() {
      let t = '';
      try {
        const h1 = document.querySelector('h1');
        if (h1 && h1.textContent) t = h1.textContent;
        if (!t && document.title) {
          const parts = String(document.title).split(/\s*[|｜\-–—·_]\s*/);
          t = (parts.length > 1 && parts[0].length >= 4) ? parts[0] : document.title;
        }
      } catch (e) { /* 忽略 */ }
      const topic = String(t || '这一页').replace(/\s+/g, ' ').trim();
      return clipPill(topic, 14).replace(/[：:，,、\-–—·|｜…\s]+$/, '');
    }

    /* 拿到结构化数据、且此刻该画网的句子 */
    webNodesAll() {
      const out = [];
      for (let i = 0; i < this.sentences.length; i++) {
        const s = this.sentences[i];
        if (s.web && s.web.branch) out.push(s);
      }
      return out;
    }

    /* 蛛网画布尺寸：普通 370×336；放大态跟着面板宽度走（宽屏最多 616）
       要点很多时画布再高一点：椭圆被拉高，顶端才不会把胶囊挤成一堆 */
    webSize(n) {
      if (!this.wide) return { S: 370, H: 336 };
      const S = Math.round(clamp(Math.min(616, window.innerWidth - 40), 380, 616));
      const cnt = n || 0;
      /* 40 个以上再高 8%：50 个胶囊在 1:1 的画布里已经挤到贴边 */
      const ratio = cnt <= DENSE_AT ? 0.92 : (cnt > 40 ? 1.08 : 1.0);
      return { S: S, H: Math.round(S * ratio) };
    }

    /* 放大 / 还原：面板变宽 + 蛛网按新尺寸重画。auto = 由要点数量自动触发 */
    applyWide(on, auto) {
      if (!this.panelEl) return;
      on = !!on;
      this.wide = on;
      this.autoWide = !!auto && on;
      /* 手动点过 ⤡：说明用户不想让面板自己变宽，之后不再自动放大 */
      if (!auto) this.wideOptOut = !on;
      this.panelEl.classList.toggle('wide', on);
      /* 面板被拖到过别处的话，变宽/变高后可能顶出屏幕，拉回来 */
      if (this.panelEl.style.left) {
        const l = parseFloat(this.panelEl.style.left) || 0;
        const t = parseFloat(this.panelEl.style.top) || 0;
        const w = this.panelEl.offsetWidth, h = this.panelEl.offsetHeight;
        this.panelEl.style.left = Math.max(4, Math.min(l, window.innerWidth - w - 4)) + 'px';
        this.panelEl.style.top = Math.max(4, Math.min(t, window.innerHeight - h - 4)) + 'px';
      }
      const btn = this.shadow ? this.shadow.getElementById('zoom') : null;
      if (btn) {
        btn.textContent = on ? '⤡' : '⤢';
        btn.title = on ? '还原大小' : '放大查看';
        btn.setAttribute('aria-label', on ? '还原大小' : '放大查看');
      }
      this.closeWebCard();
      this.lastWeaveAt = Date.now();   // 尺寸切换是瞬间重排，不吃织网动画
      this.paintWeb();          // 立即按新尺寸重画，别让人看到旧尺寸的网
    }

    /* 手动点放大按钮 */
    toggleZoom() {
      this.applyWide(!this.wide, false);
    }

    /* 要点一多，普通宽度塞不下：自动切放大态；掉回 24 以下再自动收回。
       返回 true 表示尺寸变了、已经重画过，调用方直接收工（防止递归）。 */
    autoWiden(n) {
      if (!this.panelEl) return false;
      const need = n > WIDE_AT;
      if (need && !this.wide && !this.wideOptOut) { this.applyWide(true, true); return true; }
      if (!need && this.wide && this.autoWide) { this.applyWide(false, true); return true; }
      return false;
    }

    rebuildWeb(delay) {
      if (this.destroyed) return;
      clearTimeout(this.webTimer);
      if (delay) {
        this.webTimer = setTimeout(() => { this.webTimer = 0; this.paintWeb(); }, delay);
      } else {
        this.paintWeb();
      }
    }

    /* 枝名归一：去标点、取前 6 字、互相包含算同一枝（产能 / 产能扩张） */
    canonBranch(raw, names) {
      const name = String(raw || '').replace(/[\s·、,，。.;；:：]+/g, '').slice(0, 6) || '其他';
      for (let i = 0; i < names.length; i++) {
        const a = names[i];
        if (a === name) return a;
        if (a.length >= 2 && name.length >= 2 && (a.indexOf(name) !== -1 || name.indexOf(a) !== -1)) return a;
      }
      names.push(name);
      return name;
    }

    /* 限枝：保留最大的、合并最小的两枝，直到 ≤ 上限 */
    limitGroups(groups, max) {
      while (groups.length > max) {
        let a = 0, b = 1;
        if (groups[b].sents.length < groups[a].sents.length) { const t = a; a = b; b = t; }
        for (let i = 2; i < groups.length; i++) {
          const cnt = groups[i].sents.length;
          if (cnt < groups[a].sents.length) { b = a; a = i; }
          else if (cnt < groups[b].sents.length) { b = i; }
        }
        groups[a].sents = groups[a].sents.concat(groups[b].sents);
        if (groups[a].topics) groups[a].topics = groups[a].topics.concat(groups[b].topics || []);
        groups.splice(b, 1);
      }
    }

    /* 跨枝虚线：两端都在网上才画。accept 决定某个 sid 是否算「在网上」 */
    collectChords(onWeb) {
      const chords = [];
      for (let i = 0; i < this.webChords.length; i++) {
        const c = this.webChords[i];
        if (onWeb[String(c[0])] && onWeb[String(c[1])]) chords.push(c);
      }
      return chords;
    }

    /* 降级：无原文子部分时，按话题枝聚成扁平网（原 2.3.x 逻辑，完全兼容） */
    buildFlatData(nodes) {
      const names = [];
      const groups = [];
      const idx = {};
      for (let i = 0; i < nodes.length; i++) {
        const name = this.canonBranch(nodes[i].web.branch, names);
        if (idx[name] == null) { idx[name] = groups.length; groups.push({ name: name, sents: [] }); }
        groups[idx[name]].sents.push(nodes[i]);
      }
      this.limitGroups(groups, clamp(Math.ceil(nodes.length / 5), 3, 12));
      const total = groups.length;
      const leafMax = clamp(Math.ceil(nodes.length / Math.max(1, total)) + 1, 3, this.wide ? 10 : 4);
      const quota = groups.map(() => 0);
      let left = nodes.length, guard = nodes.length + 2;
      while (left > 0 && guard-- > 0) {
        let progressed = false;
        for (let i = 0; i < groups.length && left > 0; i++) {
          if (quota[i] < leafMax && groups[i].sents.length > quota[i]) { quota[i]++; left--; progressed = true; }
        }
        if (!progressed) break;
      }
      const data = { hub: this.webTopic || this.pageTopic(), branches: [], chords: [], hier: false };
      const onWeb = {};
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const leaves = [];
        for (let j = 0; j < g.sents.length && leaves.length < quota[i]; j++) {
          const s = g.sents[j];
          leaves.push({ t: s.summary || s.text, ty: s.web.type || 'quote', sid: s.id, full: s.text });
          onWeb[String(s.id)] = 1;
        }
        data.branches.push({ t: g.name, a: -100 + i * (360 / total), leaves: leaves });
      }
      data.chords = this.collectChords(onWeb);
      return data;
    }

    /* 层级网：第一层 = 原文 h2 子部分，第二层 = 话题枝（可点开），句子在话题枝 kids 里。
       主网末端画到话题枝为止；点话题枝 → 下钻/原地展开看它辖下的句子。 */
    buildWebData(nodes) {
      /* 数据源优先级：① AI 整篇归纳的 struct（大块→话题枝）② 原文 h2 section ③ 扁平降级 */
      let withStruct = 0;
      for (let i = 0; i < nodes.length; i++) if (nodes[i].struct && nodes[i].struct.block) withStruct++;
      const useStruct = withStruct >= Math.max(3, Math.ceil(nodes.length * 0.5));
      const withSec = nodes.filter(s => s.section);
      if (!useStruct && !withSec.length) return this.buildFlatData(nodes);

      /* 第一层分组：AI 大块 or 原文子部分（保留首次出现顺序） */
      const secGroups = [];
      const secIdx = {};
      const secNames = [];
      for (let i = 0; i < nodes.length; i++) {
        const s = nodes[i];
        let raw;
        if (useStruct) raw = (s.struct && s.struct.block) ? s.struct.block : '其他';
        else raw = s.section || '其他';
        const nm = this.canonBranch(raw, secNames);
        if (secIdx[nm] == null) { secIdx[nm] = secGroups.length; secGroups.push({ name: nm, sents: [] }); }
        secGroups[secIdx[nm]].sents.push(s);
      }
      this.limitGroups(secGroups, clamp(Math.ceil(nodes.length / 6), 3, useStruct ? 10 : 8));

      /* 第二层：每个大块内按话题枝归一（AI 归纳的 topic 优先，否则用 branch） */
      const total = secGroups.length;
      const branchMax = clamp(Math.ceil(nodes.length / Math.max(1, total)) + 1, 3, this.wide ? 8 : 5);
      const data = { hub: this.webTopic || this.pageTopic(), branches: [], chords: [], hier: true, src: useStruct ? 'ai' : 'h2' };
      const onWeb = {};
      for (let i = 0; i < secGroups.length; i++) {
        const g = secGroups[i];
        const bNames = [];
        const topics = [];
        const tIdx = {};
        for (let k = 0; k < g.sents.length; k++) {
          const s = g.sents[k];
          const rawTopic = (useStruct && s.struct && s.struct.topic) ? s.struct.topic : (s.web.branch || '要点');
          const nm = this.canonBranch(rawTopic, bNames);
          if (tIdx[nm] == null) { tIdx[nm] = topics.length; topics.push({ name: nm, sents: [] }); }
          topics[tIdx[nm]].sents.push(s);
        }
        /* 话题枝数量也要限，超了合并最小的 */
        this.limitGroups(topics, branchMax);
        const leaves = [];
        for (let t = 0; t < topics.length; t++) {
          const tp = topics[t];
          const kids = [];
          for (let q = 0; q < tp.sents.length; q++) {
            const s = tp.sents[q];
            kids.push({ t: s.summary || s.text, ty: s.web.type || 'quote', sid: s.id, full: s.text });
            onWeb[String(s.id)] = 1;
          }
          /* 主导类型：话题枝的端点色取 kids 里出现最多的类型 */
          const cnt = {};
          for (let q = 0; q < kids.length; q++) cnt[kids[q].ty] = (cnt[kids[q].ty] || 0) + 1;
          let dom = 'quote', best = -1;
          for (const k in cnt) if (cnt[k] > best) { best = cnt[k]; dom = k; }
          leaves.push({ t: tp.name, ty: dom, grp: true, kids: kids });
        }
        data.branches.push({ t: g.name, a: -100 + i * (360 / total), leaves: leaves });
      }
      data.chords = this.collectChords(onWeb);
      return data;
    }

    paintWeb() {
      if (!this.webHost || this.destroyed) return;
      /* 网重画了，单句卡要跟着收（它的胶囊没了）；大白话卡挂的是全文，留着别打断开 */
      if (this.webCardSid === -2) {
        /* 但句数会变：刷新卡底的「已抓到 N 句 / 内容有更新」，别停在旧数字 */
        setTimeout(() => { if (this.webCardSid === -2) this.paintPlainCard(); }, 0);
      } else this.closeWebCard();
      const on = this.aiOn();
      const live = on ? this.webNodesAll() : [];

      /* 要点多 → 自动放大；尺寸一变就先返回，重进时按新画布排 */
      if (this.autoWiden(live.length)) return;

      const nodes = live.slice(0, this.wide ? MAX_POINTS : WIDE_AT);
      this.webHost.classList.toggle('dense', nodes.length > DENSE_AT);

      /* 首次织网：网里从 0 变出第一批节点算首次，走现有的整体织网动画；
         之后新增的节点改用「关键词飞入」。restart / clearWeb 会重置这个标志。 */
      const firstWeave = !this.firstWeaveDone && nodes.length > 0;

      /* 织网动画节流：爬取中每批新要点都会重画，但 650ms 内不重复从头播，
         否则动画永远卡在开头那几帧。空网不播（本来就在提示「让我织」）。 */
      const now = Date.now();
      const weave = nodes.length > 0 && (now - this.lastWeaveAt > 650);
      if (weave) this.lastWeaveAt = now;

      /* 空网：只有装饰丝 + 中心主题，本身就在提示「让我织」 */
      if (!nodes.length) {
        const sz = this.webSize();
        renderWebMap(this.webHost, {
          data: { hub: this.pageTopic(), branches: [], chords: [] },
          deco: 1,
          full: true,
          S: sz.S,
          H: sz.H
        });
        /* 有近期失败原因就别装成「正在织网」，把卡住的那一步直接显示出来 */
        const diagFresh = this.aiDiag && this.aiDiagAt && (Date.now() - this.aiDiagAt < 30000);
        this.paintWebHint(diagFresh ? 'err' : (on ? 'wait' : (this.aiAvailable ? 'auto' : 'nokey')));
        return;
      }
      this.paintWebHint('');

      const data = this.buildWebData(nodes);
      this.webData = data;
      const sz = this.webSize(nodes.length);
      /* 层级网点开了某个话题枝：按当前模式画展开视图（常态=聚焦下钻，放大=原地长分支） */
      if (this.webFocus && data.hier && this.focusNode(data)) {
        this.renderFocusView(data, sz);
        return;
      }
      renderWebMap(this.webHost, {
        data: data,
        deco: clamp(1 - nodes.length / 14, 0.12, 1),
        animate: weave,
        S: sz.S,
        H: sz.H
      });

      /* 胶囊建好、碰撞消解定稿之后才能读坐标：首次不飞，之后新增的飞 */
      if (firstWeave) this.firstWeaveDone = true;
      this.spawnKeywords(nodes, firstWeave);
      this.retargetFlyers();
    }

    paintWebHint(kind) {
      const el = this.shadow ? this.shadow.getElementById('webHint') : null;
      if (!el) return;
      if (!kind) { el.hidden = true; el.textContent = ''; return; }
      el.hidden = false;
      if (kind === 'err') {
        /* 用纯文本拼，不把模型/网络返回的内容当 HTML 解析 */
        el.textContent = '';
        const b = document.createElement('b');
        b.textContent = '要点没挂上网';
        el.appendChild(b);
        el.appendChild(document.createTextNode('：' + (this.aiDiag || '未知原因')));
        return;
      }
      let html = '';
      if (kind === 'nokey') html = '<b>还没连上 AI</b>先填 Key，蜘蛛才能织网';
      else if (kind === 'auto') html = '<b>切到「AI 总结」</b>蜘蛛就开始织网';
      else html = '<b>正在织网…</b>多爬几句，网会长密';
      el.innerHTML = html;
    }

    onWebHover(e, on) {
      const pill = e.target && e.target.closest ? e.target.closest('.pill[data-sid]') : null;
      if (!pill) return;
      const sent = this.byId.get(Number(pill.getAttribute('data-sid')));
      if (!sent) return;
      if (on) {
        if (this.webHovered === sent) return;
        this.webHovered = sent;
        this.highlightSentence(sent);
      } else {
        if (this.webHovered !== sent) return;
        this.webHovered = null;
        this.clearSentenceHighlight();
      }
    }

    /* webFocus 指向的叶子（话题枝）；失效返回 null */
    focusNode(data) {
      if (!this.webFocus || !data || !data.hier) return null;
      const b = data.branches[this.webFocus.bi];
      if (!b) return null;
      const lf = b.leaves[this.webFocus.li];
      return lf && lf.grp ? lf : null;
    }

    /* 展开视图：常态=聚焦下钻；放大=原地长分支 */
    renderFocusView(data, sz) {
      if (this.wide) this.renderExpandInPlace(data, sz);
      else this.renderDrill(data, sz);
    }

    /* 造一个「返回全图」的胶囊，定位在画布左上，挂在 host 上 */
    addBackPill(host, label) {
      const el = document.createElement('div');
      el.className = 'pill grp-back';
      el.style.cssText = 'position:absolute;left:10px;top:12px;transform:none;z-index:8;font-size:9.5px;padding:2px 7px;';
      el.textContent = label || '‹ 全图';
      el.title = '返回整张蛛网';
      host.appendChild(el);
      return el;
    }

    /* 句子胶囊（展开视图里复用的小胶囊），点击仍走详情卡 */
    makeKidPill(host, kid, x, y) {
      const ty = WEB_TYPES[kid.ty] || WEB_TYPES.quote;
      const el = document.createElement('div');
      el.className = 'pill';
      el.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;transform:translate(-50%,-50%);max-width:96px;';
      el.textContent = clipPill(kid.t, this.wide ? 16 : 13);
      el.title = kid.full || kid.t;
      el.style.borderColor = ty.c + 'cc';
      el.style.boxShadow = '0 0 0 1px ' + ty.c + '22, 0 3px 10px rgba(0,0,0,.55)';
      if (kid.sid != null) el.setAttribute('data-sid', String(kid.sid));
      host.appendChild(el);
      return { el: el, x: x, y: y, ty: ty };
    }

    /* 常态：聚焦下钻 —— 路径竖排（主题→子部分→话题枝），kids 横排在下方 */
    renderDrill(data, sz) {
      const host = this.webHost;
      const S = sz.S, H = sz.H;
      host.innerHTML = '';
      host.style.width = S + 'px'; host.style.height = H + 'px';
      const lf = this.focusNode(data);
      const sec = data.branches[this.webFocus.bi];
      const kids = lf.kids || [];
      /* 丝层 */
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'websilk');
      svg.setAttribute('width', S); svg.setAttribute('height', H);
      svg.setAttribute('viewBox', '0 0 ' + S + ' ' + H);
      svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible';
      host.insertBefore(svg, host.firstChild);
      const line = (a, b, c) => {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M' + a.x + ',' + a.y + ' Q' + ((a.x + b.x) / 2) + ',' + ((a.y + b.y) / 2 + 8) + ' ' + b.x + ',' + b.y);
        p.setAttribute('fill', 'none'); p.setAttribute('stroke', c || 'rgba(255,255,255,.6)');
        p.setAttribute('stroke-width', '1.4'); svg.appendChild(p);
      };
      const cy = [Math.round(H * 0.16), Math.round(H * 0.40), Math.round(H * 0.62)];
      const cx = Math.round(S / 2);
      const chain = [
        { t: data.hub, cls: 'hub', color: 'rgba(255,209,102,.7)' },
        { t: sec.t, cls: 'br', color: 'rgba(255,255,255,.65)' },
        { t: lf.t, cls: 'grp', color: (WEB_TYPES[lf.ty] || WEB_TYPES.quote).c }
      ];
      const pts = [];
      for (let i = 0; i < chain.length; i++) {
        const el = document.createElement('div');
        el.className = 'pill ' + chain[i].cls + (i === 2 ? ' grp' : '');
        el.style.cssText = 'position:absolute;left:' + cx + 'px;top:' + cy[i] + 'px;transform:translate(-50%,-50%);';
        el.textContent = chain[i].t;
        el.style.maxWidth = (S - 40) + 'px';
        host.appendChild(el);
        pts.push({ x: cx, y: cy[i] });
        if (i > 0) line(pts[i - 1], pts[i], chain[i].color);
      }
      /* kids 横排（多则两行） */
      const ky = Math.round(H * 0.84);
      const perRow = Math.max(2, Math.floor((S - 20) / 96));
      const rows = Math.ceil(kids.length / perRow) || 1;
      const kidPts = [];
      for (let i = 0; i < kids.length; i++) {
        const row = Math.floor(i / perRow);
        const col = i % perRow;
        const inRow = Math.min(perRow, kids.length - row * perRow);
        const x = Math.round((S - (inRow - 1) * 104) / 2) + col * 104;
        const y = ky - (rows - 1 - row) * 34;
        kidPts.push(this.makeKidPill(host, kids[i], x, y));
        line(pts[2], { x: x, y: y }, 'rgba(255,255,255,.42)');
      }
      const back = this.addBackPill(host, '‹ 全图');
      back.onclick = () => this.webBack();
    }

    /* 放大：原地长分支 —— 全图骨架照画，但被点的枝以外淡出，kids 从该枝向外扇出 */
    renderExpandInPlace(data, sz) {
      const host = this.webHost;
      const S = sz.S, H = sz.H;
      let cnt = 0;
      for (let bi = 0; bi < data.branches.length; bi++) cnt += data.branches[bi].leaves.length;
      renderWebMap(host, { data: data, deco: clamp(1 - cnt / 14, 0.12, 1), S: S, H: H });
      /* 淡出其它枝 */
      const bEls = host.querySelectorAll('.pill.br');
      const lEls = host.querySelectorAll('.pill[data-grp]');
      const keepPill = host.querySelector('.pill[data-grp="' + this.webFocus.bi + '-' + this.webFocus.li + '"]');
      for (let i = 0; i < bEls.length; i++) if (i !== this.webFocus.bi) bEls[i].style.opacity = '.2';
      for (let i = 0; i < lEls.length; i++) if (lEls[i] !== keepPill) lEls[i].style.opacity = '.2';
      const svgs = host.querySelectorAll('svg.websilk');
      for (let i = 0; i < svgs.length; i++) svgs[i].style.opacity = '.35';
      /* 从被点枝向外扇出 kids：以它的位置为基点，往画布外侧 */
      const lf = this.focusNode(data);
      const kids = lf.kids || [];
      const base = keepPill ? {
        x: parseFloat(keepPill.style.left), y: parseFloat(keepPill.style.top)
      } : { x: S / 2, y: H / 2 };
      const dir = base.x >= S / 2 ? 1 : -1;
      const svg2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg2.setAttribute('width', S); svg2.setAttribute('height', H);
      svg2.setAttribute('viewBox', '0 0 ' + S + ' ' + H);
      svg2.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible;z-index:3';
      host.appendChild(svg2);
      for (let i = 0; i < kids.length; i++) {
        const spread = (i - (kids.length - 1) / 2) * 40;
        const x = Math.min(Math.max(base.x + dir * 92, 46), S - 46);
        const y = Math.min(Math.max(base.y + spread, 14), H - 14);
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M' + base.x + ',' + base.y + ' Q' + ((base.x + x) / 2) + ',' + ((base.y + y) / 2 - 10) + ' ' + x + ',' + y);
        p.setAttribute('fill', 'none'); p.setAttribute('stroke', (WEB_TYPES[kids[i].ty] || WEB_TYPES.quote).c);
        p.setAttribute('stroke-width', '1.6'); p.setAttribute('opacity', '.8'); svg2.appendChild(p);
        const kp = this.makeKidPill(host, kids[i], x, y);
        kp.el.style.zIndex = '7';
      }
      if (keepPill) keepPill.style.zIndex = '8';
      const back = this.addBackPill(host, '‹ 全图');
      back.onclick = () => this.webBack();
    }

    webBack() {
      this.webFocus = null;
      if (this.webHost) { this.webHost.innerHTML = ''; }
      this.paintWeb();
    }

    onWebClick(e) {
      /* 中心标题：开/关「大白话全文总结」卡 */
      const hub = e.target && e.target.closest ? e.target.closest('.pill.hub') : null;
      if (hub) {
        if (this.webCardSid === -2) { this.closeWebCard(); return; }
        this.openPlainCard(hub);
        return;
      }
      /* 层级网的话题枝末端：点开进入展开视图（常态下钻 / 放大原地长分支） */
      const grp = e.target && e.target.closest ? e.target.closest('.pill[data-grp]') : null;
      if (grp && this.webData && this.webData.hier) {
        const parts = String(grp.getAttribute('data-grp')).split('-');
        this.webFocus = { bi: Number(parts[0]), li: Number(parts[1]) };
        if (this.focusNode(this.webData)) this.paintWeb();
        else this.webFocus = null;
        return;
      }
      const pill = e.target && e.target.closest ? e.target.closest('.pill[data-sid]') : null;
      if (!pill) return;
      const sid = Number(pill.getAttribute('data-sid'));
      const sent = this.byId.get(sid);
      if (!sent) return;
      /* 再点同一颗：收起（像个开关） */
      if (this.webCardSid === sid) { this.closeWebCard(); return; }
      this.openWebCard(pill, sent);
    }

    /* 当前可送去写大白话的关键句数（最多 60，和后台对齐） */
    plainSourceCount() {
      let n = 0;
      for (let i = 0; i < this.keySentences.length && n < 60; i++) {
        if (this.keySentences[i].found) n++;
      }
      return n;
    }

    /* 点中心标题：贴在网上展开「大白话全文总结」卡，复用详情卡容器 */
    openPlainCard(pill) {
      const card = this.shadow ? this.shadow.getElementById('webCard') : null;
      if (!card) return;
      const wrap = card.parentNode;
      if (!wrap) return;

      this.closeWebCard();
      this.webCardSid = -2;                 // -2 = 大白话卡（句子 id 从 1 开始）
      const doc = this.shadow.ownerDocument || document;
      card.innerHTML = '';
      card.classList.add('plain');

      const hd = doc.createElement('div');
      hd.className = 'wc-hd';
      const ty = doc.createElement('span');
      ty.className = 'wc-ty';
      ty.innerHTML = '<i style="background:#ffd166"></i>';
      ty.appendChild(doc.createTextNode('大白话总结'));
      hd.appendChild(ty);
      const x = doc.createElement('button');
      x.type = 'button';
      x.className = 'wc-x';
      x.setAttribute('data-wc', 'close');
      x.textContent = '×';
      hd.appendChild(x);
      card.appendChild(hd);

      const body = doc.createElement('div');
      body.className = 'wc-plain';
      card.appendChild(body);

      const meta = doc.createElement('div');
      meta.className = 'wc-meta';
      card.appendChild(meta);

      card.hidden = false;
      pill.classList.add('on');

      /* 先把内容填进去，再量高度定位。
         空卡片量出来的高度只有几十像素，会把 top 算到网区外，
         等文本填满后卡片撑高、按钮就跑到框外去了。 */
      this.paintPlainCard();

      /* 定位：贴在标题下方，放不下翻上方，左右夹在网内 */
      const cw = Math.min(this.wide ? 340 : 300, Math.max(200, wrap.clientWidth - 8));
      card.style.width = cw + 'px';
      const pr = pill.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      /* 卡片最高不可能超过网框，量出来超了就按网框算，保证一定放得下 */
      const ch = Math.min(card.offsetHeight || 240, Math.max(120, wr.height - 8));
      let left = (pr.left - wr.left) + pr.width / 2 - cw / 2;
      left = Math.min(Math.max(left, 4), Math.max(4, wr.width - cw - 4));
      let top = (pr.top - wr.top) + pr.height + 6;
      if (top + ch > wr.height - 2) top = (pr.top - wr.top) - ch - 6;
      top = Math.min(Math.max(top, 2), Math.max(2, wr.height - ch - 2));
      card.style.left = left + 'px';
      card.style.top = top + 'px';

      /* 点开就要看到内容：没缓存就当场生成，不用再点第二下按钮 */
      if (!this.plainCache) this.loadPlain();
    }

    /* 渲染大白话卡：命中缓存直接出字，否则调后台生成 */
    paintPlainCard() {
      const card = this.shadow ? this.shadow.getElementById('webCard') : null;
      if (!card || card.hidden) return;
      const body = card.querySelector('.wc-plain');
      const meta = card.querySelector('.wc-meta');
      if (!body || !meta) return;
      meta.innerHTML = '';
      const n = this.plainSourceCount();
      const cache = this.plainCache;

      const note = document.createElement('span');
      note.className = 'wc-n';
      note.textContent = '基于已抓到的 ' + n + ' 句';
      meta.appendChild(note);

      if (this.plainBusy) {
        body.className = 'wc-plain wait';
        body.textContent = (this.aiName || 'AI') + ' 正在用大白话讲这篇文章…';
        return;
      }
      if (cache && cache.text) {
        body.className = 'wc-plain';
        body.textContent = cache.text;
        /* 句数涨够了才提示重讲，别动不动就催用户花 API 调用 */
        if (n - cache.count >= 5) {
          const again = document.createElement('button');
          again.type = 'button';
          again.textContent = '内容有更新 · 重新讲';
          again.setAttribute('data-wc', 'plain-retry');
          meta.appendChild(again);
        }
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = '复制这段';
        copy.setAttribute('data-wc', 'plain-copy');
        meta.appendChild(copy);
        return;
      }
      if (cache && cache.error) {
        body.className = 'wc-plain wait';
        body.textContent = cache.error;
        const again = document.createElement('button');
        again.type = 'button';
        again.textContent = '重试';
        again.setAttribute('data-wc', 'plain-retry');
        meta.appendChild(again);
        return;
      }
      body.className = 'wc-plain wait';
      body.textContent = '还没有总结内容';
      const go = document.createElement('button');
      go.type = 'button';
      go.textContent = '用大白话讲一遍';
      go.setAttribute('data-wc', 'plain-retry');
      meta.appendChild(go);
    }

    /* 探活：MV3 的后台 service worker 空闲后会被回收。大白话是按需偶发调用，
       常常撞上冷启动——第一条消息发出去时端口还没建好，直接拿到 lastError。
       先发一个不读配置、不发 API 的 PING 把它唤醒，确认通道通了再发真请求。 */
    pingBackground(cb) {
      let done = false;
      const finish = (ok, msg) => { if (!done) { done = true; cb(ok, msg); } };
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
          finish(false, 'no-runtime');
          return;
        }
        chrome.runtime.sendMessage({ type: 'PING' }, (res) => {
          const le = chrome.runtime.lastError;   // 必须先读，否则 Chrome 报未检查错误
          finish(!!(res && res.pong), le ? le.message : (res ? null : 'no-response'));
        });
      } catch (e) {
        finish(false, (e && e.message) || 'throw');
      }
    }

    /* 真正发请求：结果按本次会话缓存。retried=true 表示通道抖动后的自动重试 */
    loadPlain(retried) {
      if (this.plainBusy) return;
      if (!this.aiAvailable) {
        this.plainCache = { error: '还没连上 AI，先在下面点「未连接 AI」连一下' };
        this.paintPlainCard();
        return;
      }
      const found = [];
      for (let i = 0; i < this.keySentences.length && found.length < 60; i++) {
        const s = this.keySentences[i];
        if (s.found) found.push({ text: s.text });
      }
      if (!found.length) {
        this.plainCache = { error: '蜘蛛还没读到关键句，动一下鼠标让它爬一爬' };
        this.paintPlainCard();
        return;
      }
      this.plainBusy = true;
      this.plainCache = null;
      this.paintPlainCard();
      const gen = this.webGen;

      const giveUp = (msg) => {
        if (this.destroyed || gen !== this.webGen) return;
        this.plainBusy = false;
        this.plainCache = { error: msg };
        this.paintPlainCard();
      };
      /* 通道层失败：未重试过就等一下重来（重来时会重新 PING）；否则给出人话提示。
         无论哪条路，都必须把 busy 标志放回去，否则下次点 hub 会被 if(plainBusy) return 挡住。 */
      const retryOrGiveUp = (msg) => {
        if (this.destroyed || this.webCardSid !== -2 || gen !== this.webGen) {
          this.plainBusy = false;
          return;
        }
        if (retried) { giveUp(msg); return; }
        this.plainBusy = true;
        this.paintPlainCard();
        setTimeout(() => {
          if (this.destroyed || this.webCardSid !== -2 || gen !== this.webGen) {
            this.plainBusy = false;
            return;
          }
          this.plainBusy = false;
          this.loadPlain(true);
        }, 450);
      };

      /* 第一步：PING 唤醒后台并确认通道 */
      this.pingBackground((ok, err) => {
        if (this.destroyed || gen !== this.webGen) return;
        if (!ok) {
          /* 「扩展上下文无效」= 刷新了扩展但没刷新网页，旧页面的 content script 还在。
             这种重试也没用，直接给可执行的提示；其余按冷启动处理、重试一次。 */
          const dead = /context invalidated|invalidated extension context|receiving end does not exist|no-runtime/i.test(err || '');
          retryOrGiveUp(dead
            ? '扩展刚更新过，请刷新网页后再点标题（' + (err || '通道断开') + '）'
            : '后台没响应：' + (err || '消息通道断开'));
          return;
        }

        /* 第二步：通道确认通畅，发真正的大白话请求 */
        try {
          chrome.runtime.sendMessage({ type: 'TLDR_PLAIN', sentences: found }, (res) => {
            if (this.destroyed) return;
            const le = chrome.runtime.lastError;
            if (gen !== this.webGen) return;
            if (le || !res) {
              retryOrGiveUp('后台没响应：' + ((le && le.message) || '消息通道断开'));
              return;
            }
            this.plainBusy = false;
            if (!res.ok || !res.text) {
              /* 后台所有失败都带 error 码；原始 detail 也带上，一眼看出真因 */
              const human = res.error ? this.aiErrorText(res) : '大白话总结生成失败，点重试再来一次';
              this.plainCache = { error: human + (res.detail ? '（' + String(res.detail).slice(0, 80) + '）' : '') };
            } else {
              this.plainCache = { text: res.text, count: found.length };
            }
            this.paintPlainCard();
          });
        } catch (e) {
          retryOrGiveUp('调用失败：' + ((e && e.message) || '未知错误'));
        }
      });
    }

    /* 点开胶囊：贴在网上展开一张详情卡（类型 + 枝 + 短摘要 + 原文全句） */
    openWebCard(pill, sent) {
      const card = this.shadow ? this.shadow.getElementById('webCard') : null;
      if (!card) return;
      const wrap = card.parentNode;
      if (!wrap) return;

      this.closeWebCard();
      this.webCardSid = sent.id;
      this.webCardSent = sent;

      const ty = WEB_TYPES[(sent.web && sent.web.type) || 'quote'] || WEB_TYPES.quote;
      const doc = this.shadow.ownerDocument || document;
      card.innerHTML = '';

      const hd = doc.createElement('div');
      hd.className = 'wc-hd';
      const tyEl = doc.createElement('span');
      tyEl.className = 'wc-ty';
      const dot = doc.createElement('i');
      dot.style.background = ty.c;
      tyEl.appendChild(dot);
      tyEl.appendChild(doc.createTextNode(ty.n));
      hd.appendChild(tyEl);

      if (sent.web && sent.web.branch) {
        const br = doc.createElement('span');
        br.className = 'wc-br';
        br.textContent = sent.web.branch;
        hd.appendChild(br);
      }
      const x = doc.createElement('button');
      x.type = 'button';
      x.className = 'wc-x';
      x.setAttribute('data-wc', 'close');
      x.textContent = '×';
      hd.appendChild(x);
      card.appendChild(hd);

      const sum = doc.createElement('div');
      sum.className = 'wc-sum';
      sum.textContent = sent.summary || sent.text;
      card.appendChild(sum);

      const lb = doc.createElement('div');
      lb.className = 'wc-lb';
      lb.textContent = '原文';
      card.appendChild(lb);

      const full = doc.createElement('div');
      full.className = 'wc-full';
      full.textContent = sent.text;
      card.appendChild(full);

      const ft = doc.createElement('div');
      ft.className = 'wc-ft';
      const bLoc = doc.createElement('button');
      bLoc.type = 'button';
      bLoc.setAttribute('data-wc', 'locate');
      bLoc.textContent = '定位原文';
      const bCopy = doc.createElement('button');
      bCopy.type = 'button';
      bCopy.setAttribute('data-wc', 'copy');
      bCopy.textContent = '复制这句';
      ft.appendChild(bLoc);
      ft.appendChild(bCopy);
      card.appendChild(ft);

      card.hidden = false;
      if (pill.classList) pill.classList.add('on');

      /* 定位：优先贴在胶囊下方，放不下就翻到上方，左右夹在网内 */
      const pr = pill.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const cw = Math.min(this.wide ? 288 : 238, Math.max(180, wr.width - 8));
      card.style.width = cw + 'px';
      const ch = card.offsetHeight || 180;
      let left = (pr.left - wr.left) + pr.width / 2 - cw / 2;
      left = Math.min(Math.max(left, 4), Math.max(4, wr.width - cw - 4));
      let top = (pr.top - wr.top) + pr.height + 6;
      if (top + ch > wr.height - 2) top = (pr.top - wr.top) - ch - 6;
      top = Math.min(Math.max(top, 2), Math.max(2, wr.height - ch - 2));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    }

    closeWebCard() {
      if (this.webCardSid == null) return;
      this.webCardSid = -1;
      this.webCardSent = null;
      const card = this.shadow ? this.shadow.getElementById('webCard') : null;
      if (card) { card.hidden = true; card.innerHTML = ''; card.classList.remove('plain'); }
      const on = this.shadow ? this.shadow.querySelectorAll('.pill.on') : [];
      for (let i = 0; i < on.length; i++) on[i].classList.remove('on');
    }

    /* 滚到网页原句并闪一下高亮 */
    locateSentence(sent) {
      if (!sent || !sent.range) return;
      let rect = null;
      try { rect = sent.range.getBoundingClientRect(); } catch (err) { rect = null; }
      if (!rect) return;
      const y = window.scrollY + rect.top - window.innerHeight * 0.32;
      try { window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' }); }
      catch (err) { window.scrollTo(0, Math.max(0, y)); }
      this.highlightSentence(sent);
      clearTimeout(this.webFlashTimer);
      this.webFlashTimer = setTimeout(() => this.clearSentenceHighlight(), 1600);
    }

    highlightSentence(sent) {
      if (this.highlightMode !== 'api' || !sent || !sent.range) return;
      try {
        CSS.highlights.set('tldr-hover', new Highlight(sent.range));
      } catch (e) { /* 忽略 */ }
    }

    clearSentenceHighlight() {
      try {
        if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('tldr-hover');
      } catch (e) { /* 忽略 */ }
    }

    copyAll() {
      const list = this.shadow ? this.shadow.getElementById('list') : null;
      if (!list || !list.children.length) {
        this.toast('还没有内容可复制');
        return;
      }
      const lines = [];
      for (let i = 0; i < list.children.length; i++) {
        const txt = list.children[i].querySelector('.txt');
        if (txt) lines.push((i + 1) + '. ' + txt.textContent.trim());
      }
      const text = 'TL;DR\n' + lines.join('\n');

      const done = () => this.toast('已复制');
      const fail = () => this.toast('复制失败');

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {
          if (this.legacyCopy(text)) done(); else fail();
        });
      } else {
        if (this.legacyCopy(text)) done(); else fail();
      }
    }

    legacyCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('data-tldr-temp', '1');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    }

    toast(msg) {
      if (!this.shadow) return;
      const el = this.shadow.getElementById('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
    }

    showAiBadge(msg) {
      if (!this.shadow) return;
      const el = this.shadow.getElementById('aiBadge');
      if (!el) return;
      el.textContent = msg || 'AI 不可用';
      el.hidden = false;
      // .toast 默认 opacity:0，光摘 hidden 是不会显示的（之前一直没真正弹出来过）
      el.classList.remove('show');
      void el.offsetWidth;          // 连续两次提示也要重新淡入
      el.classList.add('show');
      clearTimeout(this.aiBadgeTimer);
      this.aiBadgeTimer = setTimeout(() => {
        el.classList.remove('show');
        el.hidden = true;
      }, 6000);
    }

    /* =====================================================================
     * §11 AI 摘要（全部经 background.js 代理）
     * ================================================================== */

    refreshApiState() {
      try {
        chrome.storage.local.get(['provider', 'apiKey', 'deepseekKey', 'sumMode'], (r) => {
          if (this.destroyed) return;
          const provider = this.pickProvider(r);
          const key = provider === 'anthropic' ? (r && r.apiKey) : (r && r.deepseekKey);
          this.aiProvider = provider;
          this.aiName = provider === 'anthropic' ? 'Claude' : 'DeepSeek';
          this.aiAvailable = !!(key && String(key).trim());
          // 没存过就沿用当前值（默认 auto）
          if (r && r.sumMode === 'ai') this.sumMode = 'ai';
          else if (r && r.sumMode === 'auto') this.sumMode = 'auto';
          this.paintAiUi();
        });
      } catch (e) { /* 忽略 */ }
    }

    /* 真正在跑的摘要方式：没连上 AI 时，AI 模式自动退回本地 */
    aiOn() {
      return this.aiAvailable && this.sumMode === 'ai';
    }

    /* 面板上所有跟 AI 有关的状态一次性刷完 */
    paintAiUi() {
      if (!this.shadow) return;
      const on = this.aiOn();

      const conn = this.shadow.getElementById('conn');
      const connText = this.shadow.getElementById('connText');
      if (conn) {
        conn.classList.toggle('live', this.aiAvailable);
        conn.classList.toggle('off', !this.aiAvailable);
      }
      if (connText) {
        connText.textContent = this.aiAvailable ? (this.aiName + ' 已连接') : '未连接 AI';
      }

      const modes = this.shadow.getElementById('modes');
      if (modes) modes.classList.toggle('ai-mode', on);

      const chips = this.shadow.querySelectorAll('.mode');
      for (let i = 0; i < chips.length; i++) {
        const m = chips[i].getAttribute('data-mode');
        const active = m === 'ai' ? on : (this.sumMode === 'auto' || !this.aiAvailable);
        chips[i].classList.toggle('on', active);
      }

      const btn = this.shadow.getElementById('btnAi');
      if (btn) {
        btn.textContent = on ? '重新生成 TL;DR' : ('用 ' + this.aiName + ' 写 TL;DR');
        btn.hidden = !this.aiAvailable;
      }

      /* 模式 / Key 一变，网也要跟着换状态（空网 ↔ 真网） */
      this.rebuildWeb(60);
    }

    /* 自动 / AI 总结：面板上直接切，存起来下次沿用 */
    setSumMode(mode, notify) {
      const next = mode === 'ai' ? 'ai' : 'auto';

      // 没连上就别让它切过去，直接带去填 Key，避免「切了没反应」
      if (next === 'ai' && !this.aiAvailable) {
        this.toast('还没连上 ' + this.aiName + '，先去填 Key');
        this.onConnClick();
        return;
      }

      if (next === this.sumMode && notify) {
        // 重复点同一项：只给个回执，不重复干活
        this.toast(next === 'ai' ? '已经是 AI 总结了' : '已经是自动摘要了');
        return;
      }
      this.sumMode = next;
      this.paintAiUi();
      try { chrome.storage.local.set({ sumMode: next }); } catch (e) { /* 忽略 */ }
      this.rebuildWeb(120);

      if (!notify) return;

      if (next === 'ai') {
        this.toast('AI 总结已开启');
        this.requeueAll();
        this.lastVerdictCount = 0;
        this.aiAutoVerdictAt = 0;
        if (this.found > 0) this.runVerdict();   // 没抓到句子就别闪「思考中」
      } else {
        this.toast('自动摘要：只用本地规则，不烧 token');
      }
    }

    /* 点连接状态：没连上就跳设置页，已连上就报一下是谁 */
    onConnClick() {
      if (this.aiAvailable) {
        this.toast(this.aiName + ' 已连接，可以切 AI 总结了');
        return;
      }
      try {
        if (chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
          this.toast('在设置里填 API Key');
        } else {
          this.toast('打开扩展设置页填 API Key');
        }
      } catch (e) {
        this.toast('打不开设置页，去 chrome://extensions 点「扩展程序选项」');
      }
    }

    /* 刚从自动切到 AI：把已经抓到的句子补一遍 AI 摘要 */
    requeueAll() {
      if (!this.aiAvailable) return;
      const found = this.keySentences.filter((s) => s.found).slice(0, MAX_POINTS);
      let added = 0;
      for (let i = 0; i < found.length; i++) {
        const s = found[i];
        if (this.pendingApi.indexOf(s) !== -1) continue;
        this.pendingApi.push(s);
        added++;
      }
      if (!added) return;
      clearTimeout(this.apiTimer);
      this.apiTimer = setTimeout(() => this.flushApi(), 220);
    }

    /* AI 模式下边爬边刷 3 行 TL;DR：新增够多、间隔够久才刷，别刷屏也别刷爆额度 */
    maybeAutoVerdict() {
      if (!this.aiOn() || this.aiBusy) return;
      if (this.found - this.lastVerdictCount < 3) return;
      const now = Date.now();
      if (now - this.aiAutoVerdictAt < 9000) return;
      this.lastVerdictCount = this.found;
      this.aiAutoVerdictAt = now;
      this.runVerdict();
    }

    /* 哪家引擎：provider 决定挂哪把 Key */
    pickProvider(r) {
      r = r || {};
      if (r.provider === 'anthropic' || r.provider === 'deepseek') return r.provider;
      const hasAnthropic = !!(r.apiKey && String(r.apiKey).trim());
      const hasDeepSeek = !!(r.deepseekKey && String(r.deepseekKey).trim());
      return (hasAnthropic && !hasDeepSeek) ? 'anthropic' : 'deepseek';
    }

    /* 把后台的错误码翻成人话，别只丢一个「AI 不可用」 */
    aiErrorText(res) {
      const name = this.aiName || 'AI';
      const code = String((res && res.error) || '');
      if (code === 'no-key') return name + ' 还没配 Key';
      if (code === 'timeout') return name + ' 超时，稍后再试';
      if (code === 'network') return '连不上 ' + name;
      if (code === 'unparsable') return name + ' 返回格式不对';
      if (code === 'exception') return name + ' 后台出错';
      if (code === 'empty' || code === 'empty-input') return name + ' 没返回内容';
      if (code.indexOf('http-401') === 0) return name + ' Key 无效（401）';
      if (code.indexOf('http-402') === 0) return name + ' 余额不足（402）';
      if (code.indexOf('http-403') === 0) return name + ' 无权限（403）';
      if (code.indexOf('http-404') === 0) return name + ' 模型名或接口不对（404）';
      if (code.indexOf('http-429') === 0) return name + ' 限流了（429）';
      if (code.indexOf('http-') === 0) return name + ' 出错（' + code.slice(5) + '）';
      return name + ' 不可用';
    }

    queueApi(sent) {
      if (!this.aiOn()) return;   // 自动模式只走本地摘要，一次请求都不发
      if (this.pendingApi.indexOf(sent) !== -1) return;
      this.pendingApi.push(sent);
      clearTimeout(this.apiTimer);
      this.apiTimer = setTimeout(() => this.flushApi(), CFG.API_DEBOUNCE);
    }

    flushApi() {
      if (this.destroyed || !this.pendingApi.length) return;
      if (!this.aiOn()) { this.pendingApi.length = 0; return; }
      const batch = this.pendingApi.splice(0, CFG.API_BATCH);
      const payload = batch.map((s) => ({ id: s.id, text: s.text }));
      const gen = this.webGen;        // 这批请求属于哪一代的网

      try {
        chrome.runtime.sendMessage({ type: 'TLDR_SUMMARIZE', sentences: payload }, (res) => {
          if (this.destroyed) return;
          if (gen !== this.webGen) return;   // 中途点了「重新启动」：这批结果早已作废，不许挂网
          if (chrome.runtime.lastError || !res || !res.ok || !Array.isArray(res.summaries)) {
            // 失败就保留本地 fallback，只在面板上轻轻提示一下（带上原因）
            const le = chrome.runtime.lastError;
            const why = le ? ('后台脚本没响应' + (le.message ? '：' + le.message : '')) : this.aiErrorText(res);
            this.showAiBadge(le ? '后台脚本没响应' : this.aiErrorText(res));
            this.aiDiag = why;
            this.aiDiagAt = Date.now();
            this.rebuildWeb(0);
          } else {
            for (let i = 0; i < batch.length; i++) {
              const s = batch[i];
              const sum = res.summaries[i];
              if (s && sum && String(sum).trim()) {
                s.summary = String(sum).trim();
                this.updateEntrySummary(s);
              }
            }
            /* 结构化图谱数据：给这些句子挂上「枝 + 类型」，网跟着长 */
            if (res.web && Array.isArray(res.web.items)) {
              const byId = {};
              for (let i = 0; i < res.web.items.length; i++) {
                const it = res.web.items[i];
                if (it && it.id != null) byId[String(it.id)] = it;
              }
              let grown = 0;
              for (let i = 0; i < batch.length; i++) {
                const s = batch[i];
                const it = byId[String(s.id)];
                if (!it || !it.branch) continue;
                s.web = { branch: it.branch, type: it.type || 'quote', kw: it.kw || '' };
                grown++;
              }
              if (!this.webTopic && res.web.topic) this.webTopic = String(res.web.topic).trim();
              if (Array.isArray(res.web.links)) {
                for (let i = 0; i < res.web.links.length; i++) {
                  const c = res.web.links[i];
                  if (!c || c.length !== 2) continue;
                  const key = String(c[0]) + '>' + String(c[1]);
                  let dup = false;
                  for (let j = 0; j < this.webChords.length; j++) {
                    if (String(this.webChords[j][0]) + '>' + String(this.webChords[j][1]) === key ||
                        String(this.webChords[j][1]) + '>' + String(this.webChords[j][0]) === key) { dup = true; break; }
                  }
                  if (!dup) this.webChords.push([c[0], c[1]]);
                }
              }
              if (grown) {
                this.aiDiag = '';
                this.aiDiagAt = 0;
                this.rebuildWeb(200);
              } else {
                this.aiDiag = 'AI 返回的要点对不上原文句子';
                this.aiDiagAt = Date.now();
                this.rebuildWeb(0);
              }
            } else {
              /* 结构化失败时后端会退回纯摘要数组：列表有摘要，但网不长。
                 这不该伪装成「正在织网」，把真实原因摆出来。 */
              this.aiDiag = 'AI 只返回了摘要，没给图谱结构';
              this.aiDiagAt = Date.now();
              this.rebuildWeb(0);
            }
          }
          if (this.pendingApi.length) {
            clearTimeout(this.apiTimer);
            this.apiTimer = setTimeout(() => this.flushApi(), 260);
          } else {
            /* 本批是最后一批：预约一次整篇层级归纳（空闲 3 秒后才发，避免边爬边烧额度） */
            this.maybeStructure();
          }
        });
      } catch (e) {
        this.showAiBadge('调用失败：' + (e && e.message ? e.message : '未知错误'));
      }
    }

    /* 爬取告一段落后，发一次「整篇层级归纳」：让 AI 自己分大块→话题枝→句子归属。
       和边爬边出的单句摘要分开——那个是逐批的，这个要等看完全文才有意义。 */
    maybeStructure() {
      if (!this.aiOn() || this.structDone || this.structBusy) return;
      let n = 0;
      for (let i = 0; i < this.sentences.length; i++) if (this.sentences[i].web) n++;
      if (n < 6) return;   // 太少不值得单独跑一次
      clearTimeout(this.structTimer);
      this.structTimer = setTimeout(() => this.runStructure(), 3000);
    }

    async runStructure() {
      if (!this.aiOn() || this.structDone || this.structBusy || this.destroyed) return;
      /* 按需调用：SW 空闲会被回收，先 PING 探活再发真请求（和大白话一套） */
      const pingOk = await new Promise((resolve) => this.pingBackground((ok) => resolve(ok)));
      if (!pingOk || this.destroyed) return;
      this.structBusy = true;
      const gen = this.webGen;
      const payload = this.sentences
        .filter((s) => s && s.text)
        .map((s) => ({ id: s.id, text: s.text, hint: s.hint || '' }));
      try {
        const res = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'TLDR_STRUCTURE', sentences: payload }, (r) => {
            if (chrome.runtime.lastError) { resolve({ ok: false, error: 'channel', detail: chrome.runtime.lastError.message }); return; }
            resolve(r);
          });
        });
        if (this.destroyed || gen !== this.webGen) return;   // 重启了：旧结果作废
        if (!res || !res.ok || !res.structure || !Array.isArray(res.structure.blocks)) {
          this.structBusy = false;
          return;   // 归纳失败：静默降级到现有 h2/扁平网，不打扰用户
        }
        /* 挂回句子：一个句子只归一处 */
        const place = {};
        const blocks = res.structure.blocks;
        for (let bi = 0; bi < blocks.length; bi++) {
          const topics = blocks[bi].topics || [];
          for (let ti = 0; ti < topics.length; ti++) {
            const ids = topics[ti].ids || [];
            for (let k = 0; k < ids.length; k++) {
              place[String(ids[k])] = { block: blocks[bi].name, topic: topics[ti].name };
            }
          }
        }
        let matched = 0;
        for (let i = 0; i < this.sentences.length; i++) {
          const s = this.sentences[i];
          const p = place[String(s.id)];
          if (p) { s.struct = p; matched++; }
        }
        if (res.structure.topic && !this.webTopic) this.webTopic = String(res.structure.topic).trim();
        this.structDone = true;
        this.structBusy = false;
        if (matched) this.rebuildWeb(120);
      } catch (e) {
        this.structBusy = false;
      }
    }

    runVerdict() {
      if (!this.aiAvailable || this.aiBusy) return;
      const found = this.keySentences.filter((s) => s.found);
      if (!found.length) {
        this.toast('蜘蛛还没读到关键句');
        return;
      }
      const box = this.shadow.getElementById('ai');
      if (!box) return;
      this.aiBusy = true;
      box.hidden = false;
      box.className = 'ai busy';
      box.textContent = (this.aiName || 'AI') + ' 思考中…';

      const payload = found.map((s) => ({ text: s.text }));
      try {
        chrome.runtime.sendMessage({ type: 'TLDR_VERDICT', sentences: payload }, (res) => {
          if (this.destroyed) return;
          this.aiBusy = false;
          if (chrome.runtime.lastError || !res || !res.ok || !Array.isArray(res.lines)) {
            box.className = 'ai err';
            box.textContent = chrome.runtime.lastError ? '后台脚本没响应，重新加载扩展试试' : this.aiErrorText(res);
            return;
          }
          box.className = 'ai done';
          box.innerHTML = '';
          for (let i = 0; i < res.lines.length; i++) {
            const p = document.createElement('p');
            p.textContent = res.lines[i];
            box.appendChild(p);
          }
        });
      } catch (e) {
        this.aiBusy = false;
        box.className = 'ai err';
        box.textContent = '调用失败：' + (e && e.message ? e.message : '未知错误');
      }
    }

    /* =====================================================================
     * §12 生命周期
     * ================================================================== */

    startLoop() {
      const frame = (ts) => {
        if (this.destroyed) return;
        this.raf = requestAnimationFrame(frame);
        if (!this.lastFrame) this.lastFrame = ts;
        let dt = (ts - this.lastFrame) / 1000;
        this.lastFrame = ts;
        if (dt > 0.25) dt = 0.25;

        this.acc += dt;
        const fixed = 1 / 120;
        let guard = 0;
        while (this.acc >= fixed && guard < 10) {
          this.stepPhysics(fixed);
          this.updateFeet(fixed);
          this.acc -= fixed;
          guard++;
        }
        if (guard >= 10) this.acc = 0;

        this.updateRipples(dt);
        this.updateFlyers(dt);
        this.render();
      };
      this.raf = requestAnimationFrame(frame);
    }

    startObserver() {
      try {
        this.observer = new MutationObserver((records) => {
          if (this.destroyed) return;
          // 自己造成的改动（插入 host、拆 glitch span）不算页面更新，别触发重扫
          let relevant = false;
          for (let i = 0; i < records.length; i++) {
            if (!this.isOwnMutation(records[i])) { relevant = true; break; }
          }
          if (!relevant) return;
          clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => this.handleMutations(), CFG.DEBOUNCE_SCAN);
        });
        this.observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          characterData: false
        });
      } catch (e) {
        this.observer = null;
      }
    }

    isOwnMutation(rec) {
      const target = rec.target;
      if (target && target.nodeType === 1 && target.hasAttribute && target.hasAttribute(HOST_ATTR)) return true;
      const nodes = [];
      for (let i = 0; i < rec.addedNodes.length; i++) nodes.push(rec.addedNodes[i]);
      for (let i = 0; i < rec.removedNodes.length; i++) nodes.push(rec.removedNodes[i]);
      if (!nodes.length) return false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.nodeType === 1) {
          if (n.hasAttribute(HOST_ATTR)) continue;
          if (n.hasAttribute('data-tldr-glitch')) continue;
          return false;
        }
        // splitText 只会产生文本节点之间的拆分
        if (n.nodeType === 3 && target && target.nodeType === 3) continue;
        if (n.nodeType === 3 && n.parentElement && n.parentElement.hasAttribute &&
            n.parentElement.hasAttribute('data-tldr-glitch')) continue;
        return false;
      }
      return true;
    }

    handleMutations() {
      if (this.destroyed) return;
      if (location.href !== this.href) {
        this.href = location.href;
        this.pruneDetached();
      }
      this.scanPage();
      this.updatePanelCounts();
    }

    restart() {
      if (this.destroyed) return;
      this.revertAllGlitches();
      if (this.hl) { try { this.hl.clear(); } catch (e) { /* 忽略 */ } }

      // 清空列表
      for (const rec of this.entries.values()) {
        if (rec.li && rec.li.parentNode) rec.li.parentNode.removeChild(rec.li);
      }
      this.entries.clear();

      this.sentences = [];
      this.byId.clear();
      this.blocks = [];
      this.blockSeen = new WeakSet();
      this.nodeIndex = new Map();
      this.protectedNodes = new WeakSet();
      this.keySentences = [];
      this.highlightRects = [];
      this.highlightRectsDirty = true;
      this.found = 0;
      this.total = 0;
      this.pendingApi = [];
      this.lastVerdictCount = 0;
      this.aiAutoVerdictAt = 0;
      this.ripples = [];

      /* 网也必须清：不然屏幕上那批旧要点会一直挂着，直到下一批 AI 数据到达 */
      this.clearWeb();

      const ai = this.shadow && this.shadow.getElementById('ai');
      if (ai) { ai.hidden = true; ai.textContent = ''; ai.className = 'ai'; }

      this.updatePanelCounts();
      this.initSpider();
      this.pointer.lastMove = performance.now();
      this.scanPage();
      this.updatePanelCounts();
      this.rebuildWeb();          // 扫完再画一次：空网立刻归位
      this.toast('已重新开始');
    }

    /* 清空蛛网状态 → 立刻画成空网（重启 / 换页时用） */
    clearWeb() {
      this.webGen++;                      // 在途的旧 AI 响应从此作废，不许再往网上挂
      this.webTopic = '';
      this.webChords = [];
      this.webHovered = null;
      this.webFocus = null;               // 清网也退出展开/下钻视图，回到全图
      this.webData = null;
      clearTimeout(this.structTimer);
      this.structTimer = 0;
      this.structBusy = false;
      this.structDone = false;            // 换新文章：允许重新归纳一次层级
      this.structGen++;
      for (let i = 0; i < this.sentences.length; i++) this.sentences[i].struct = null;
      this.lastWeaveAt = 0;               // 新一轮织网可以重新播动画
      this.firstWeaveDone = false;        // 清网后重新织，第一批又按「首次」走整体动画
      this.onWebSids = new Set();
      this.flyers = [];
      this.autoWide = false;
      this.wideOptOut = false;
      this.plainCache = null;             // 重启即清缓存，别拿旧文章的总结给新文章看
      this.plainBusy = false;
      clearTimeout(this.webTimer);
      this.webTimer = 0;
      clearTimeout(this.webFlashTimer);
      this.clearSentenceHighlight();
      this.closeWebCard();
      if (this.wide) this.applyWide(false, true);   // 回到普通宽度；applyWide 内部会重画
      else this.paintWeb();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;

      cancelAnimationFrame(this.raf);
      clearInterval(this.scanTimer);
      clearTimeout(this.apiTimer);
      clearTimeout(this.debounceTimer);
      clearTimeout(this.toastTimer);
      clearTimeout(this.aiBadgeTimer);

      if (this.observer) {
        try { this.observer.disconnect(); } catch (e) { /* 忽略 */ }
        this.observer = null;
      }

      for (let i = 0; i < this.bound.length; i++) {
        const b = this.bound[i];
        try { b[0].removeEventListener(b[1], b[2], b[3]); } catch (e) { /* 忽略 */ }
      }
      this.bound.length = 0;

      try {
        if (this.storageListener) chrome.storage.onChanged.removeListener(this.storageListener);
      } catch (e) { /* 忽略 */ }
      this.storageListener = null;

      // 撤销所有 glitch
      this.revertAllGlitches();
      // 清掉临时 textarea（如果上次复制卡住了）
      try {
        const stray = document.querySelectorAll('textarea[data-tldr-temp]');
        for (let i = 0; i < stray.length; i++) stray[i].remove();
      } catch (e) { /* 忽略 */ }

      // 高亮
      if (this.hl) {
        try { this.hl.clear(); } catch (e) { /* 忽略 */ }
        this.hl = null;
      }
      try {
        if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('tldr-found');
      } catch (e) { /* 忽略 */ }
      if (this.styleEl && this.styleEl.parentNode) this.styleEl.parentNode.removeChild(this.styleEl);
      this.styleEl = null;
      if (this.sheet) {
        try {
          const keep = (this.prevSheets || []).filter((s) => s !== this.sheet);
          document.adoptedStyleSheets = keep;
        } catch (e) { /* 忽略 */ }
        this.sheet = null;
        this.prevSheets = null;
      }

      // Shadow DOM / canvas / 面板
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.host = null;
      this.shadow = null;
      this.canvas = null;
      this.ctx = null;
      this.panelEl = null;
      this.webHost = null;
      clearTimeout(this.webTimer);
      clearTimeout(this.webFlashTimer);
      this.webChords = [];
      this.webTopic = '';
      this.webHovered = null;
      this.webCardSid = -1;
      this.webCardSent = null;
      this.plainCache = null;
      this.plainBusy = false;

      // 数据结构
      this.sentences = [];
      this.byId.clear();
      this.entries.clear();
      this.keySentences = [];
      this.feet = [];
      this.ripples = [];
      this.spider = null;

      // 把全局开关一起放掉，否则从面板“关闭”后下一次点图标会空点一次
      if (window.__TLDR_CRAWLER__ === this) window.__TLDR_CRAWLER__ = null;
    }
  }

  /* 启动 */
  try {
    window.__TLDR_CRAWLER__ = new Crawler();
    window.__TLDR_CRAWLER__.start();
  } catch (e) {
    console.error('[TL;DR] 启动失败', e);
    window.__TLDR_CRAWLER__ = null;
  }
})();
