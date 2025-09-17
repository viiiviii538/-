(function () {
  // ===== Version / Log =====
  const VER = '2.0-merge-like-fix-shops';
  try { console.debug('[MerSearch Helper] content.js loaded:', VER); } catch { }

  // ===== Settings =====
  const LIKE_FETCH_CONC = 4;        // いいね並列取得数
  const LIKE_FETCH_MAX = 40;        // 取得上限
  const likeCache = new Map();      // href -> number|null
  let _hydrating = false;

  // 検索カード内のリンク（通常/ショップ 両対応）
  const ITEM_SELECTORS = [
    'a[href^="/item/"]',
    'a[href^="/shops/product/"]',
    'li a[href^="/item/"]',
    'li a[href^="/shops/product/"]'
  ];

  // ===== Utilities =====
  function findPrice(el) {
    // a要素そのものに入ってることが多いので、anchor自体のテキストを基本に。
    const t = (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ');
    const m = t.match(/¥\s*([0-9][0-9,]{2,})/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  function findTitleKey(el) {
    const raw = el?.getAttribute('title') || el?.innerText || el?.textContent || '';
    return (raw || '')
      .replace(/[【】\[\]()（）]/g, ' ')
      .replace(/[~〜\-_:：|｜]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .trim()
      .toLowerCase();
  }

  function isSold(el) {
    const txt = ((el?.innerText || el?.textContent || '') + (el?.getAttribute('aria-label') || '')).toLowerCase();
    if (/sold|売り切れ/.test(txt)) return true;
    return !!el?.querySelector?.('[aria-label*="SOLD"],[alt*="SOLD"],[aria-label*="売り切れ"],[alt*="売り切れ"]');
  }

  function getItemsInView() {
    const set = new Set();
    ITEM_SELECTORS.forEach(sel => document.querySelectorAll(sel).forEach(a => set.add(a)));
    // /item/ と /shops/product/ の両方のみ通す
    return [...set].filter(a =>
      /^\/(item|shops\/product)\/[A-Za-z0-9]/.test(a.getAttribute('href') || '')
    );
  }

  // ===== Like extractors =====
  // Documentから「いいね数」を抽出（ショップ/通常 両対応）
  function extractLikeFromDoc(doc) {
    // 最優先：公式 data-testid
    const root = doc.querySelector('[data-testid="icon-heart-button"]');
    if (root) {
      const btn = root.querySelector('button[aria-label]');
      if (btn) {
        const n = parseInt(btn.getAttribute('aria-label') || '', 10);
        if (!Number.isNaN(n)) return n;
      }
      const span = root.querySelector('span');
      if (span) {
        const n = parseInt((span.textContent || '').trim(), 10);
        if (!Number.isNaN(n)) return n;
      }
    }
    // 代替（保険）
    const candBtn = doc.querySelector('button[aria-label*="いいね"], button[aria-label*="like"]');
    if (candBtn) {
      const n = parseInt(candBtn.getAttribute('aria-label') || '', 10);
      if (!Number.isNaN(n)) return n;
    }
    const m = (doc.body?.textContent || '').match(/(?:いいね!?|Likes?)\D*([\d,]+)/i);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (!Number.isNaN(n)) return n;
    }
    return null;
  }

  // JSONを深く探索して like 数値を抜く
  function deepFindLike(obj) {
    const KEY_CANDIDATES = [
      'likeCount', 'likes_count', 'likesCount', 'num_likes',
      'favoriteCount', 'numFavorites', 'favorites', 'watchCount'
    ];
    try {
      const stack = [obj];
      while (stack.length) {
        const cur = stack.pop();
        if (cur && typeof cur === 'object') {
          for (const k of Object.keys(cur)) {
            const v = cur[k];
            // 直接マッチ
            if (KEY_CANDIDATES.includes(k) && typeof v === 'number') return v;
            // like: { count: N } / favorite: { count: N }
            if ((/^like$/i.test(k) || /^favorite$/i.test(k)) &&
              v && typeof v === 'object' && typeof v.count === 'number') {
              return v.count;
            }
            if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
    } catch { }
    return null;
  }

  // ===== Like fetchers =====
  async function fetchLikeCount(href) {
    console.debug("fetchLikeCount start", href);

    if (likeCache.has(href)) return likeCache.get(href);
    const url = new URL(href, location.origin).toString();

    let html = '';
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { likeCache.set(href, null); return null; }
      html = await res.text();
    } catch { likeCache.set(href, null); return null; }

    const flat = html.replace(/\s+/g, ' ');

    // 1) __NEXT_DATA__ から取得
    try {
      const m = flat.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (m && m[1]) {
        const nextData = JSON.parse(m[1]);
        const hit = deepFindLike(nextData);
        if (typeof hit === 'number' && !Number.isNaN(hit)) {
          likeCache.set(href, hit);
          return hit;
        }
      }
    } catch { }

    // 2) DOM 抽出（静的に数字が埋まっている場合）
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const n = extractLikeFromDoc(doc);
      if (typeof n === 'number') {
        likeCache.set(href, n);
        return n;
      }
    } catch { }

    // 3) テキスト正規表現（最後のワンチャン）
    {
      const mm = flat.match(/"likeCount"\s*:\s*(\d+)/i)
        || flat.match(/"likes?_count"\s*:\s*(\d+)/i)
        || flat.match(/"favoriteCount"\s*:\s*(\d+)/i)
        || flat.match(/"watchCount"\s*:\s*(\d+)/i)
        || flat.match(/いいね！？?\s*([\d,]+)/i)
        || flat.match(/Likes?\D*([\d,]+)/i);
      if (mm) {
        const val = Number(mm[1].replace(/,/g, ''));
        console.debug("fetchLikeCount result", href, val);
        likeCache.set(href, val);
        return val;
      }
    }

    // 4) iframe フォールバック（同一オリジンで実描画→抽出）
    const val = await iframeLikeCount(url);
    console.debug("fetchLikeCount result", href, val);
    likeCache.set(href, val);
    return val;
  }

  async function iframeLikeCount(url) {
    return new Promise(resolve => {
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;visibility:hidden;';
      let done = false;
      const cleanup = () => { if (!done) { done = true; ifr.remove(); } };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, 9000);

      ifr.onload = () => {
        try {
          const doc = ifr.contentDocument;
          const n = extractLikeFromDoc(doc);
          clearTimeout(timer);
          cleanup();
          resolve(typeof n === 'number' ? n : null);
        } catch {
          clearTimeout(timer);
          cleanup();
          resolve(null);
        }
      };

      ifr.src = url;
      document.body.appendChild(ifr);
    });
  }

  // ===== Hydrate likes (batch) =====
  async function hydrateLikes(rows) {
    console.debug("hydrateLikes called, rows=", rows.length, rows.map(r => r.el.href));

    if (_hydrating) return;
    _hydrating = true;
    try {
      const targets = rows
        .filter(r => r.likes == null && r.el?.getAttribute('href'))
        .slice(0, LIKE_FETCH_MAX);

      let i = 0;
      async function worker() {
        while (i < targets.length) {
          const r = targets[i++];
          try {
            const href = r.el.getAttribute('href');
            const val = await fetchLikeCount(href);
            if (val != null) {
              r.likes = val;
              const badge = r.el.querySelector('.mer-badge');
              if (badge) {
                const text = badge.textContent || '';
                badge.textContent = text.replace(/^♥\s*[-\d,]+/, `♥ ${val}`);
              }
            }
          } catch { }
        }
      }
      await Promise.all(Array.from({ length: Math.min(LIKE_FETCH_CONC, targets.length) }, worker));
    } finally {
      _hydrating = false;
    }
  }

  // ===== Auto-scroll for 'all' mode =====
  async function autoScrollAll(maxSteps = 40) {
    let last = 0;
    for (let i = 0; i < maxSteps; i++) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 600));
      const h = document.body.scrollHeight;
      if (h === last) break;
      last = h;
    }
    window.scrollTo({ top: document.body.scrollHeight });
    await new Promise(r => setTimeout(r, 300));
  }

  // ===== Overlay UI =====
  function overlayBox() {
    let box = document.getElementById('mer-helper-overlay');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'mer-helper-overlay';
    box.innerHTML = `
      <div class="mh-title">MerSearch Helper</div>
      <div class="mh-body"><span>準備中…</span></div>
    `;
    document.body.appendChild(box);
    return box;
  }

  function updateOverlay(data) {
    const box = overlayBox();
    const yen = n => n == null ? '-' : ('¥' + n.toLocaleString());
    box.querySelector('.mh-body').innerHTML = `
      <div>出品中：<b>${data.activeCount}</b></div>
      <div>売り切れ：<b>${data.soldCount}</b></div>
      <div>レンジ${data.soldOnly ? '(SOLD)' : '(全件)'}：<b>${yen(data.minPrice)}〜${data.maxPrice == null ? '-' : yen(data.maxPrice)}</b></div>
      <div style="font-size:12px;opacity:.7">取得：${data.totalParsed}件</div>
    `;
  }

  function toggleOverlay() {
    const el = overlayBox();
    el.style.display = (el.style.display === 'none') ? 'block' : 'none';
  }

  // ===== Aggregate & Badges =====
  function aggregate({ soldOnly = false, showBadges = true } = {}) {
    const rows = getItemsInView().map((el) => ({
      el,
      price: findPrice(el),
      titleKey: findTitleKey(el),
      likes: null,
      soldFlag: isSold(el)
    }));

    let active = 0, sold = 0, minPrice = null, maxPrice = null, totalParsed = 0;
    for (const r of rows) {
      if (r.soldFlag) sold++; else active++;
      const include = soldOnly ? r.soldFlag : true;
      if (include && r.price != null) {
        minPrice = (minPrice == null) ? r.price : Math.min(minPrice, r.price);
        maxPrice = (maxPrice == null) ? r.price : Math.max(maxPrice, r.price);
      }
      totalParsed++;
    }

    // バッジ描画
    if (showBadges) {
      for (const r of rows) {
        try {
          const host = r.el;
          host.classList.add('mer-rel');
          const likeText = '♥ -';
          const label = likeText;

          let badge = host.querySelector('.mer-badge');
          if (!badge) {
            badge = document.createElement('div');
            badge.className = 'mer-badge';
            (host.querySelector('picture, img')?.parentElement || host).appendChild(badge);
          }
          badge.textContent = label;
        } catch { }
      }
    }

    // いいね補完（非同期）
    if (showBadges) {
      setTimeout(() => {
        try { if (typeof hydrateLikes === 'function') hydrateLikes(rows); } catch { }
      }, 0);
    }

    return { activeCount: active, soldCount: sold, minPrice, maxPrice, totalParsed, soldOnly };
  }

  // ===== Entry points =====
  async function scan({ mode = 'view', soldOnly = false, showBadges = true } = {}) {
    if (mode === 'all') await autoScrollAll();
    const res = aggregate({ soldOnly, showBadges });
    updateOverlay(res);
    return res;
  }

  // 初回プチ集計
  setTimeout(() => {
    try {
      const res = aggregate({ soldOnly: false, showBadges: true });
      updateOverlay(res);
    } catch { }
  }, 1200);

  // runtime messages
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.scope !== 'mer-helper') return;
    (async () => {
      try {
        if (msg.type === 'ping') { sendResponse({ ok: true, result: 'pong' }); return; }
        if (msg.type === 'toggleOverlay') { toggleOverlay(); sendResponse({ ok: true, result: true }); return; }
        if (msg.type === 'scan') { const r = await scan(msg.payload || {}); sendResponse({ ok: true, result: r }); return; }
        sendResponse({ ok: false, error: 'unknown type' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });

})();
