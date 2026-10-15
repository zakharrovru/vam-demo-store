// Система движения витрины: пружины, FLIP-морфинг, скользящие «бегунки», цифровой барабан,
// полёт в корзину, параллакс, наклон устройства, появления при прокрутке.
// Принципы: только transform/opacity (blur — точечно), will-change — на время анимации,
// prefers-reduced-motion → только плавные смены прозрачности.
window.Motion = (() => {
  "use strict";
  const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => mqReduce.matches;
  const raf = (f) => requestAnimationFrame(f);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const hasView = !!(window.CSS && CSS.supports && CSS.supports("animation-timeline: view()"));

  // ---------- пружина ----------
  // Критически задемпфированная (как SwiftUI .smooth: без перелёта). Аналитическое решение —
  // не зависит от частоты кадров. response — «время отклика», с; velocity — ед./с.
  function spring({ from, to, velocity = 0, response = 0.42, onUpdate, onComplete, rest = 0.4 }) {
    const w = (2 * Math.PI) / response;
    const A = from - to, B = velocity + w * A;
    const t0 = performance.now();
    const h = { value: from, velocity, done: false, stop() { h.done = true; cancelAnimationFrame(id); } };
    let id = raf(frame);
    function frame(now) {
      if (h.done) return;
      const t = Math.max(0, (now - t0) / 1000);
      const e = Math.exp(-w * t);
      const x = (A + B * t) * e;
      const v = (B - w * (A + B * t)) * e;
      h.velocity = v;
      if (Math.abs(x) < rest && Math.abs(v) < rest * 20) {
        h.value = to; h.done = true;
        onUpdate && onUpdate(to, 0);
        onComplete && onComplete();
        return;
      }
      h.value = to + x;
      onUpdate && onUpdate(h.value, v);
      id = raf(frame);
    }
    return h;
  }

  // резинка за краем, как в UIScrollView
  const rubber = (x, d, c = 0.55) => (1 - 1 / ((x * c) / d + 1)) * d;

  // ---------- общий элемент: плитка товара ↔ герой шторки ----------
  const radii = (el) => {
    const cs = getComputedStyle(el);
    return [parseFloat(cs.borderTopLeftRadius) || 0, parseFloat(cs.borderBottomLeftRadius) || 0];
  };
  const artBox = (tile) => {
    const a = tile.querySelector(".art-svg");
    if (!a) return null;
    const r = a.getBoundingClientRect(), t = tile.getBoundingClientRect();
    const s = Math.min(r.width, r.height);
    return { s, cx: r.left + r.width / 2 - t.left, cy: r.top + r.height / 2 - t.top, w: t.width, h: t.height };
  };
  // Создаёт «призрак» и рисует его между двумя прямоугольниками по прогрессу q (0..1).
  function morph(fromTile, toTile) {
    if (!fromTile || !toTile) return null;
    if (fromTile.querySelector("img") || toTile.querySelector("img")) return null;
    const fa = artBox(fromTile), ta = artBox(toTile);
    const fr = radii(fromTile), tr = radii(toTile);
    const T = toTile.getBoundingClientRect();
    if (!T.width || !fa || !ta) return null;
    const layer = document.createElement("div");
    layer.className = "morph";
    layer.setAttribute("aria-hidden", "true");
    const bg = document.createElement("div");
    bg.className = "tile morph-bg";
    bg.setAttribute("style", (toTile.getAttribute("style") || "") + `;width:${T.width}px;height:${T.height}px`);
    const art = fromTile.querySelector(".art-svg").cloneNode(true);
    art.removeAttribute("style");
    art.classList.add("morph-art");
    art.style.width = art.style.height = `${ta.s}px`;
    layer.append(bg, art);
    document.body.appendChild(layer);
    const W = T.width, H = T.height;
    return {
      // R0/R1 — текущие прямоугольники источника и цели (в координатах окна)
      draw(q, R0, R1) {
        const x = lerp(R0.left, R1.left, q), y = lerp(R0.top, R1.top, q);
        const w = lerp(R0.width, R1.width, q), h = lerp(R0.height, R1.height, q);
        const sx = w / W, sy = h / H;
        bg.style.transform = `translate(${x}px,${y}px) scale(${sx},${sy})`;
        const rt = lerp(fr[0], tr[0], q), rb = lerp(fr[1], tr[1], q);
        bg.style.borderRadius = `${rt / sx}px ${rt / sx}px ${rb / sx}px ${rb / sx}px / ${rt / sy}px ${rt / sy}px ${rb / sy}px ${rb / sy}px`;
        const ax = lerp(R0.left + fa.cx * (R0.width / fa.w), R1.left + ta.cx * (R1.width / ta.w), q);
        const ay = lerp(R0.top + fa.cy * (R0.height / fa.h), R1.top + ta.cy * (R1.height / ta.h), q);
        const s = lerp(fa.s * (R0.width / fa.w), ta.s * (R1.width / ta.w), q);
        art.style.transform = `translate(${ax - s / 2}px,${ay - s / 2}px) scale(${s / ta.s})`;
      },
      remove() { layer.remove(); },
    };
  }

  // ---------- скользящий «бегунок» (сегменты, чипсы, таббар, выбор варианта) ----------
  const ACTIVE = ":scope > .on, :scope > .active, :scope > label > input:checked + span";
  const relRect = (r, c, cr) => ({ x: r.left - cr.left - c.clientLeft + c.scrollLeft, y: r.top - cr.top - c.clientTop + c.scrollTop, w: r.width, h: r.height });
  function captureThumbs(root) {
    const m = new Map();
    if (!root) return m;
    const list = [...root.querySelectorAll("[data-thumb]")];
    if (root.matches && root.matches("[data-thumb]")) list.push(root);
    list.forEach((c) => {
      const th = c.querySelector(":scope > .thumb");
      if (!th || !th.dataset.on) return;
      const cr = c.getBoundingClientRect();
      if (cr.width) m.set(c.dataset.thumb, relRect(th.getBoundingClientRect(), c, cr));
    });
    return m;
  }
  function glide(c, from) {
    const act = c.querySelector(ACTIVE);
    let th = c.querySelector(":scope > .thumb");
    if (!act) { if (th) { th.style.opacity = "0"; delete th.dataset.on; } return; }
    const cr = c.getBoundingClientRect();
    if (!cr.width) return;
    if (!th) {
      th = document.createElement("span");
      th.className = "thumb";
      th.setAttribute("aria-hidden", "true");
      c.prepend(th);
      c.classList.add("has-thumb");
    }
    const [iv, ih] = (c.dataset.thumbInset || "0 0").split(" ").map(Number);
    const a = relRect(act.getBoundingClientRect(), c, cr);
    const to = { x: a.x + ih, y: a.y + iv, w: a.w - 2 * ih, h: a.h - 2 * iv };
    let f = from;
    if (!f && th.dataset.on) f = relRect(th.getBoundingClientRect(), c, cr);
    th.style.transition = "none";
    th.style.width = `${to.w}px`;
    th.style.height = `${to.h}px`;
    th.style.opacity = "";
    if (f && !reduced() && (Math.abs(f.x - to.x) > 0.5 || Math.abs(f.y - to.y) > 0.5 || Math.abs(f.w - to.w) > 0.5)) {
      th.style.transform = `translate(${f.x}px,${f.y}px) scale(${f.w / to.w},${f.h / to.h})`;
      void th.offsetWidth;
      th.style.transition = "";
    }
    th.style.transform = `translate(${to.x}px,${to.y}px)`;
    th.dataset.on = "1";
  }
  function thumbs(root, prev) {
    if (!root) return;
    const list = [...root.querySelectorAll("[data-thumb]")];
    if (root.matches && root.matches("[data-thumb]")) list.push(root);
    list.forEach((c) => glide(c, prev && prev.get(c.dataset.thumb)));
  }

  // ---------- цифровой барабан как пикер «Будильника» iOS ----------
  // Каждая цифра — цилиндр: прокручивается через промежуточные значения с перспективой,
  // соседние цифры видны и гаснут сверху/снизу, на каждом «зубце» — щелчок (onTick → haptic).
  const isDigit = (ch) => ch >= "0" && ch <= "9";
  const numOf = (s) => +String(s).replace(/\D/g, "") || 0;
  // текст элемента без барабанов незавершённой прокрутки (иначе быстрый повторный клик крутит от мусора)
  const rollText = (el) => { const v = el.querySelector(":scope > .vh"); return v && el.querySelector(":scope > .odo") ? v.textContent : el.textContent; };
  const WHEEL_CELLS = 5;                 // видимые ячейки цилиндра: центр ± 2
  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
  // «зубчатость»: позиция слегка задерживается у каждой цифры — ощущение щелчков, как у колёсика
  const detent = (p) => p - Math.sin(2 * Math.PI * p) / (2 * Math.PI) * 0.35;
  let lastTick = 0;
  function tick() {
    const now = performance.now();
    if (now - lastTick < 28) return;     // не чаще ~35 щелчков/с на все барабаны сразу
    lastTick = now;
    try { api.onTick && api.onTick(); } catch {}
  }

  function roll(el, to, from) {
    if (!el) return;
    if (el._rollRaf) cancelAnimationFrame(el._rollRaf);
    clearTimeout(el._rollT);
    from = from ?? rollText(el);
    if (from === to || reduced() || !from || !/\d/.test(to)) { el.textContent = to; return; }
    const cs = getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (!lh) lh = parseFloat(cs.fontSize) * 1.2;
    const dir = numOf(to) >= numOf(from) ? 1 : -1;  // дороже — цифры уходят вверх, дешевле — вниз
    const a = [...from], b = [...to];
    const n = b.length;
    let html = "";
    const cols = [];
    let firstChanged = -1;
    for (let i = 0; i < n; i++) {
      const old = a[a.length - (n - i)];
      if (isDigit(b[i]) && old !== b[i]) { firstChanged = i; break; }
    }
    for (let i = 0; i < n; i++) {
      const ch = b[i], old = a[a.length - (n - i)];
      if (!isDigit(ch)) { html += `<span class="odo-c">${ch === " " ? "&nbsp;" : ch}</span>`; continue; }
      const t = +ch, o = old && isDigit(old) ? +old : null;
      const k = [...b.slice(i)].filter(isDigit).length;     // позиция справа: 1 — единицы
      // младшие разряды крутятся сильнее (как при быстром пролистывании), старшие — ровно до цели
      const spinning = firstChanged >= 0 && i >= firstChanged;
      const turns = !spinning ? 0 : k === 1 ? 2 : k === 2 ? 1 : 0;
      const base = o ?? t;
      let dist = dir > 0 ? (t - base + 10) % 10 : (base - t + 10) % 10;
      if (spinning) dist += 10 * turns;
      if (o === null) dist = 0;
      const cells = Array.from({ length: WHEEL_CELLS }, () => "<span></span>").join("");
      html += `<span class="odo-d${o === null ? " odo-new" : ""}" style="height:${lh}px"><span class="odo-w" style="height:${lh * 1.7}px;top:${-lh * .35}px">${cells}</span><span class="odo-g">${ch}</span></span>`;
      cols.push({ start: base, dist, dir, k, last: null });
    }
    // letter-spacing переносим в отступы: внутри flex-барабана он теряется и строка «прыгала» на ~1 px на символ
    const ls = parseFloat(cs.letterSpacing) || 0;
    el.innerHTML = `<span class="vh">${to}</span><span class="odo" aria-hidden="true" style="line-height:${lh}px;--ls:${ls}px">${html}</span>`;
    const nodes = [...el.querySelectorAll(".odo-d")];
    cols.forEach((c, i) => {
      c.node = nodes[i];
      c.cells = [...nodes[i].querySelectorAll(".odo-w > span")];
      // длительность растёт с числом цифр, которые надо пролистать; лёгкий разнос по разрядам
      c.dur = c.dist ? 520 + Math.min(c.dist, 32) * 26 : 0;
      c.delay = (c.k - 1) * 18;
    });
    // окно цилиндра выступает за строку лишь на треть высоты — соседние цифры только «выглядывают»,
    // не наезжая на заголовок и строку «≈ ₽»
    const R = lh * .9;                        // радиус цилиндра
    const wheelTop = lh * .35;          // центр окна цилиндра
    const draw = (c, pos) => {
      const center = Math.round(pos);
      c.cells.forEach((cell, j) => {
        const idx = center + j - 2;           // ячейки: центр-2 … центр+2
        const d = idx - pos;                  // смещение от центра в ячейках
        const ang = d * 0.42;                 // ~24° на ячейку
        if (Math.abs(ang) > 1.45) { cell.style.opacity = "0"; return; }
        cell.textContent = String(((idx % 10) + 10) % 10);
        cell.style.transform = `translateY(${wheelTop + Math.sin(ang) * R}px) rotateX(${-ang}rad) scaleY(${Math.max(.35, Math.cos(ang))})`;
        cell.style.opacity = String(Math.max(0, Math.cos(ang) ** 4));
      });
      if (c.last !== null && center !== c.last) tick();
      c.last = center;
    };
    const t0 = performance.now();
    const maxEnd = Math.max(0, ...cols.map((c) => c.delay + c.dur));
    cols.forEach((c) => { if (c.dist) { c.node.classList.add("spin"); draw(c, c.start); } });
    const frame = (now) => {
      let busy = false;
      cols.forEach((c) => {
        if (!c.dist || c.done) return;
        const t = Math.min(1, Math.max(0, (now - t0 - c.delay) / c.dur));
        const p = detent(easeOutQuint(t) * c.dist);
        draw(c, c.start + c.dir * p);
        if (t >= 1) { c.done = true; c.node.classList.remove("spin"); }
        else busy = true;
      });
      if (busy && now - t0 < maxEnd + 200) el._rollRaf = requestAnimationFrame(frame);
      else finish();
    };
    const finish = () => { cancelAnimationFrame(el._rollRaf); clearTimeout(el._rollT); el._rollRaf = 0; el.textContent = to; };
    el._rollRaf = requestAnimationFrame(frame);
    // страховка: если кадры не идут (вкладка/Telegram свёрнуты), цена всё равно встанет в итоговое значение
    el._rollT = setTimeout(finish, maxEnd + 400);
  }
  const captureRolls = (root) => {
    const m = new Map();
    if (root) root.querySelectorAll("[data-roll]").forEach((el) => m.set(el.dataset.roll, rollText(el)));
    return m;
  };
  const applyRolls = (root, prev) => {
    if (!root || !prev || !prev.size) return;
    root.querySelectorAll("[data-roll]").forEach((el) => {
      const p = prev.get(el.dataset.roll);
      if (p != null && p !== el.textContent) roll(el, el.textContent, p);
    });
  };

  // ---------- полёт в корзину по дуге ----------
  function fly(src, target, onLand) {
    const done = () => { try { onLand && onLand(); } catch {} };
    if (!src || !target || reduced()) return done();
    const r = src.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight) return done();
    const ghost = src.cloneNode(true);
    ghost.removeAttribute("style");
    ghost.classList.add("fly");
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    const p0 = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const p2 = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
    const p1 = { x: lerp(p0.x, p2.x, 0.35), y: Math.min(p0.y, p2.y) - Math.min(220, innerHeight * 0.22) };
    const end = Math.max(0.06, Math.min(target.width * 1.1, 40) / Math.max(r.width, r.height));
    const io = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    const frames = [];
    for (let i = 0; i <= 30; i++) {
      const u = i / 30, s = io(u), m = 1 - s;
      const x = m * m * p0.x + 2 * m * s * p1.x + s * s * p2.x;
      const y = m * m * p0.y + 2 * m * s * p1.y + s * s * p2.y;
      const sc = lerp(1, end, Math.pow(u, 1.4));
      frames.push({ offset: u, transform: `translate(${x - r.width / 2}px,${y - r.height / 2}px) scale(${sc}) rotate(${-10 * s}deg)`, opacity: u < 0.82 ? 1 : lerp(1, 0, (u - 0.82) / 0.18) });
    }
    const a = ghost.animate(frames, { duration: 720, easing: "linear", fill: "forwards" });
    // страховка, как у барабана цен: если кадры не идут (Telegram свёрнут), finish может не прийти —
    // призрак остался бы в DOM, а счётчик корзины не обновился бы
    let landed = false;
    const land = () => { if (landed) return; landed = true; clearTimeout(t); ghost.remove(); done(); };
    const t = setTimeout(land, 720 + 400);
    a.onfinish = a.oncancel = land;
  }
  function pulse(el) {
    if (!el || reduced() || !el.animate) return;
    el.animate([{ transform: "scale(1)" }, { transform: "scale(1.16)", offset: 0.32 }, { transform: "scale(1)" }],
      { duration: 520, easing: "cubic-bezier(.3,.7,.2,1)" });
  }

  // ---------- параллакс устройства в плитке ----------
  const par = { tiles: new Set(), io: null, id: 0 };
  function parTick() {
    if (par.id) return;
    par.id = raf(() => {
      par.id = 0;
      const vh = innerHeight, list = [...par.tiles];
      const rs = list.map((t) => t.getBoundingClientRect());
      list.forEach((t, i) => {
        const r = rs[i], art = t._art;
        if (!art || !r.height) return;
        const d = clamp((r.top + r.height / 2 - vh / 2) / vh, -1, 1);
        const amp = t._amp;
        art.style.translate = `0 ${(-d * amp).toFixed(2)}px`;
      });
    });
  }
  function parallax(root) {
    if (reduced() || !("IntersectionObserver" in window)) return;
    if (!par.io) {
      par.io = new IntersectionObserver((es) => { es.forEach((e) => (e.isIntersecting ? par.tiles.add(e.target) : par.tiles.delete(e.target))); parTick(); }, { rootMargin: "80px 0px" });
      addEventListener("scroll", parTick, { passive: true });
      addEventListener("resize", parTick);
    }
    par.io.disconnect();
    par.tiles.clear();
    root.querySelectorAll(".card .tile, .gtile .tile").forEach((t) => {
      const art = t.querySelector(".art-svg");
      if (!art) return;
      t._art = art;
      const big = t.closest(".feature, .big, .wide, .gtile");
      t._amp = t.closest(".feature") ? 16 : big ? 10 : 6;
      par.io.observe(t);
    });
  }

  // блик на главной плитке и прочие бесконечные анимации — только пока видны
  let ambIO = null;
  function ambient(root) {
    if (!("IntersectionObserver" in window)) return;
    ambIO = ambIO || new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("run", e.isIntersecting)));
    root.querySelectorAll(".sheen").forEach((el) => ambIO.observe(el));
  }

  // ---------- появления при прокрутке ----------
  let rvIO = null;
  function reveal(root, animate) {
    if (hasView || reduced() || !animate || !("IntersectionObserver" in window)) return;
    rvIO = rvIO || new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); rvIO.unobserve(e.target); }
    }), { rootMargin: "0px 0px -6% 0px" });
    root.querySelectorAll(".shelf, .help, .gsec").forEach((el) => { el.classList.add("rv"); rvIO.observe(el); });
  }

  // ---------- наклон устройства в шторке (указатель / гироскоп) ----------
  function tilt(hero, tgApp) {
    const noop = () => {};
    if (!hero || reduced()) return noop;
    const art = hero.querySelector(".art-svg");
    if (!art) return noop;
    let tx = 0, ty = 0, cx = 0, cy = 0, id = 0, alive = true;
    const offs = [];
    const apply = () => {
      const m = Math.hypot(cx, cy);
      art.style.rotate = m < 0.02 ? "" : `${(cx / m).toFixed(4)} ${(cy / m).toFixed(4)} 0 ${m.toFixed(3)}deg`;
      hero.style.setProperty("--hx", (cy * 1.6).toFixed(2));
      hero.style.setProperty("--hy", (-cx * 1.6).toFixed(2));
    };
    const loop = () => {
      cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
      apply();
      id = alive && (Math.abs(tx - cx) > 0.01 || Math.abs(ty - cy) > 0.01) ? raf(loop) : 0;
    };
    const kick = () => { if (!id && alive) id = raf(loop); };
    const set = (rx, ry) => { tx = clamp(rx, -6, 6); ty = clamp(ry, -6, 6); kick(); };
    const onMove = (e) => {
      if (e.pointerType === "touch") return;
      const r = hero.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      set(-ny * 6, nx * 6);
    };
    const onLeave = () => set(0, 0);
    hero.addEventListener("pointermove", onMove);
    hero.addEventListener("pointerleave", onLeave);
    offs.push(() => { hero.removeEventListener("pointermove", onMove); hero.removeEventListener("pointerleave", onLeave); });
    let b0 = null, g0 = null;
    const orient = (beta, gamma) => {
      if (beta == null || gamma == null) return;
      if (b0 === null) { b0 = beta; g0 = gamma; }
      b0 += (beta - b0) * 0.02; g0 += (gamma - g0) * 0.02; // медленная перекалибровка «нуля»
      set(-(beta - b0) * 0.45, (gamma - g0) * 0.45);
    };
    const coarse = matchMedia("(pointer: coarse)").matches;
    try {
      const DO = tgApp && tgApp.DeviceOrientation;
      if (coarse && DO && tgApp.isVersionAtLeast && tgApp.isVersionAtLeast("8.0")) {
        const h = () => orient(DO.beta * 57.2958, DO.gamma * 57.2958);
        DO.start({ refresh_rate: 60 });
        tgApp.onEvent("deviceOrientationChanged", h);
        offs.push(() => { try { tgApp.offEvent("deviceOrientationChanged", h); DO.stop(); } catch {} });
      } else if (coarse && "DeviceOrientationEvent" in window && typeof DeviceOrientationEvent.requestPermission !== "function") {
        const h = (e) => orient(e.beta, e.gamma);
        addEventListener("deviceorientation", h);
        offs.push(() => removeEventListener("deviceorientation", h));
      }
    } catch {}
    return () => { alive = false; cancelAnimationFrame(id); offs.forEach((f) => f()); };
  }

  // смена варианта: цвет плитки перетекает (зарегистрированные --tile-a/--tile-b), устройство — кроссфейд
  function heroSwap(hero, prev) {
    if (!hero || !prev || reduced()) return;
    const a = hero.style.getPropertyValue("--tile-a"), b = hero.style.getPropertyValue("--tile-b");
    if (prev.a && (prev.a !== a || prev.b !== b)) {
      hero.style.transition = "none";
      hero.style.setProperty("--tile-a", prev.a);
      hero.style.setProperty("--tile-b", prev.b);
      void getComputedStyle(hero).getPropertyValue("--tile-a");
      hero.style.transition = "";
      hero.style.setProperty("--tile-a", a);
      hero.style.setProperty("--tile-b", b);
    }
    const art = hero.querySelector(".art-svg");
    if (prev.art && art && !hero.querySelector("img")) {
      const old = prev.art;
      old.style.rotate = "";
      old.classList.add("art-out");
      hero.appendChild(old);
      art.classList.add("art-in");
      setTimeout(() => old.remove(), 700);
    }
  }

  // переиграть смену CSS-состояния у перерисованного элемента (класс был → стал)
  function replay(el, cls, was) {
    if (!el || reduced() || el.classList.contains(cls) === was) return;
    const now = !was;
    el.classList.add("instant");
    el.classList.toggle(cls, was);
    void el.offsetWidth;
    el.classList.remove("instant");
    el.classList.toggle(cls, now);
  }

  // onTick — приложение подставляет щелчок виброотклика (Telegram HapticFeedback.selectionChanged)
  const api = { reduced, spring, rubber, morph, glide, thumbs, captureThumbs, roll, captureRolls, applyRolls, fly, pulse, parallax, ambient, reveal, tilt, heroSwap, replay, clamp, lerp, hasView, onTick: null };
  return api;
})();
