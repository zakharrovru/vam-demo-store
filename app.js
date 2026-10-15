/*
 * Витрина — Telegram Mini App и обычный сайт.
 *
 * Каталог: GET {API_URL}?action=catalog → {updated_at, shop:{name, manager, phone, currency, usd_rate, rate_date, rate_source},
 *   items:[{id, category, name, price, prev_price, status, qty, photo, description, pop?, featured?}], groups?, trending?, searches?}
 *   (без API_URL — локальный catalog.json; группы, «популярное» и «часто ищут» тогда выводятся на клиенте).
 *   Последний ответ кэшируется в localStorage и показывается мгновенно при следующем запуске.
 *
 * Заказ (корзина) — docs/ARCHITECTURE.md:
 *   POST {action:"order", item_id, item, price, items:[{item_id, qty}], customer, phone, delivery, address, comment, initData}
 * Заявка «Привезём под заказ»: POST {action:"order", request, customer, phone, comment, initData}
 * Подписка на снижение цены (только в Telegram): POST {action:"watch", item_id, on, initData}
 * События: POST {action:"track", sid, events:[{t, type, item_id?, q?, n?}]} — пачкой раз в 15 с и при сворачивании.
 * Без API_URL — демо-режим: заказы сохраняются только на устройстве, события не отправляются (лог — с ?debug=1).
 */
(() => {
  "use strict";
  const cfg = { ...(window.APP_CONFIG || {}) };
  // Только для разработки: ?api=<url> подменяет API_URL на время вкладки (sessionStorage "dev_api"),
  // ?api=off — вернуть адрес из config.js. Принимаются лишь локальные адреса (localhost / 127.0.0.1 / [::1]),
  // поэтому чужая ссылка не может увести заказы покупателей на сторонний сервер. Пример (tests/e2e/server.js):
  //   http://localhost:8765/?api=http://127.0.0.1:8787/exec
  try {
    const devApi = new URLSearchParams(location.search).get("api");
    const isLocal = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname); } catch { return false; } };
    if (devApi !== null) { if (isLocal(devApi)) sessionStorage.setItem("dev_api", devApi); else sessionStorage.removeItem("dev_api"); }
    const saved = sessionStorage.getItem("dev_api");
    if (saved && isLocal(saved)) cfg.API_URL = saved;
  } catch {}
  const M = window.Motion;
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const tgAt = (v) => { try { return inTelegram && (!tg.isVersionAtLeast || tg.isVersionAtLeast(v)); } catch { return false; } };
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const desktop = matchMedia("(min-width: 900px)");
  const debug = new URLSearchParams(location.search).has("debug");

  // ---------- без масштабирования ----------
  // meta viewport (maximum-scale=1, user-scalable=no) и touch-action в CSS закрывают Android и большинство WebView;
  // iOS игнорирует user-scalable — там гасим жесты щипка (gesture*) и двойной тап. Прокрутку и шторку не трогаем:
  // touchmove не перехватывается, а двойной тап гасится только вне полей и кнопок (иначе «+ +» в корзине терял бы второе нажатие).
  (() => {
    const editable = (t) => !!(t && t.closest && t.closest("input, textarea, select, [contenteditable]"));
    const control = (t) => !!(t && t.closest && t.closest("button, a, label, input, textarea, select, [role=button], [data-act]"));
    ["gesturestart", "gesturechange", "gestureend"].forEach((type) => document.addEventListener(type, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false }));
    let lastEnd = 0;
    document.addEventListener("touchend", (e) => {
      const now = Date.now(), quick = now - lastEnd < 300;
      lastEnd = now;
      if (quick && e.cancelable && !e.touches.length && !control(e.target)) e.preventDefault();
    }, { passive: false });
    document.addEventListener("dblclick", (e) => { if (!editable(e.target) && e.cancelable) e.preventDefault(); }, { passive: false });
  })();

  // Демо-режим: витрина публичная, но заказы магазином не обрабатываются
  if (cfg.DEMO) {
    const b = document.createElement("p");
    b.className = "demo-badge";
    b.textContent = "Демонстрация · заказы не обрабатываются магазином";
    document.querySelector("#head .wrap").prepend(b);
  }
  // плашка видна только в шапке каталога — в оформлении и на экране «Заказ отправлен» тоже говорим, что это демо,
  // иначе «Менеджер свяжется в течение 15 минут» обещает то, чего не будет
  const DEMO_NOTE = cfg.DEMO ? "<b>Демонстрация: заказы не обрабатываются магазином.</b> " : "";
  const DEMO_DONE = "Это демонстрация — магазин не обрабатывает заказы, менеджер не свяжется.";

  const shop = { name: cfg.SHOP_NAME || "Магазин", manager: String(cfg.MANAGER_USERNAME || "").replace(/^@/, ""), phone: cfg.PHONE || "",
    currency: "RUB", rate: 0, cbr: 0, rateDate: "", rateSource: "" };
  const state = {
    items: [], groups: [], trending: [], searches: [], updatedAt: null, loaded: false, offline: false,
    route: { name: "home" }, q: "", searchMode: false, sort: "pop", stockOnly: false, tab: "catalog",
    f: { mem: new Set(), color: new Set(), cond: new Set(), sim: new Set(), min: null, max: null },
  };

  // ---------- хранилище на устройстве ----------
  const store = {
    get(key, def) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? def; } catch { return def; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  };
  const favs = new Set(store.get("favs", []));
  const saveFavs = () => store.set("favs", [...favs]);
  const watches = new Set(store.get("watches", []));
  let cart = (store.get("cart", []) || []).filter((l) => l && l.id && l.qty > 0);
  const saveCart = () => { store.set("cart", cart); renderBadges("roll"); };

  // ---------- утилиты ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const digits = (n, sep) => String(Math.round(Math.abs(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const isUSD = () => shop.currency === "USD";
  // $1 168 (узкий неразрывный пробел) или 121 500 ₽
  const money = (n) => (Number(n) < 0 ? "−" : "") + (isUSD() ? `$${digits(n, " ")}` : `${digits(n, " ")} ₽`);
  // рублёвый эквивалент для долларовых цен: «≈ 97 900 ₽» (до 100 ₽)
  const rubEq = (n) => (isUSD() && shop.rate > 0 ? `≈ ${digits(Math.round((Number(n) || 0) * shop.rate / 100) * 100, " ")} ₽` : "");
  const rateCaption = () => {
    if (!isUSD() || !(shop.rate > 0)) return "";
    const manual = /вручную/i.test(shop.rateSource);
    // rate_date — «ГГГГ-ММ-ДД» (дата ЦБ): берём числа как есть, new Date() сочла бы её полночью UTC и к западу от Гринвича показала бы вчера
    const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(shop.rateDate);
    const d = ymd ? null : shop.rateDate ? new Date(shop.rateDate) : null;
    const dd = ymd ? ` на ${ymd[3]}.${ymd[2]}` : d && !isNaN(d) ? ` на ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}` : "";
    // подпись — «голый» курс ЦБ (cbr_rate); пересчёт ≈ ₽ — по рабочему курсу магазина (usd_rate, может включать наценку)
    if (manual) return `по курсу магазина ${shop.rate.toFixed(2).replace(".", ",")} ₽${dd}`;
    return `по курсу ЦБ ${(shop.cbr || shop.rate).toFixed(2).replace(".", ",")} ₽${dd}`;
  };
  const inStock = (it) => it.status === "в наличии";
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
  };
  const goods = (n) => `${n.toLocaleString("ru-RU")} ${plural(n, "товар", "товара", "товаров")}`;
  const byId = new Map();
  const find = (id) => byId.get(String(id));
  const hap = {
    sel() { if (tgAt("6.1")) try { tg.HapticFeedback.selectionChanged(); } catch {} },
    tap(k = "light") { if (tgAt("6.1")) try { tg.HapticFeedback.impactOccurred(k); } catch {} },
    note(t) { if (tgAt("6.1")) try { tg.HapticFeedback.notificationOccurred(t); } catch {} },
  };
  // барабан цены: одна смена цифры — один толчок
  M.onTick = () => {
    if (inTelegram) hap.sel();
    else if (navigator.vibrate && matchMedia("(pointer: coarse)").matches && navigator.userActivation?.hasBeenActive) try { navigator.vibrate(4); } catch {}
  };
  const ICON = {
    x: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1 1 11"/></svg>`,
    chat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4c4.7 0 8.5 3.1 8.5 7s-3.8 7-8.5 7c-.9 0-1.8-.1-2.6-.3L5 19.5l1.2-3.4C4.6 14.8 3.5 13 3.5 11c0-3.9 3.8-7 8.5-7Z"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z"/></svg>`,
    share: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11M8 7.5l4-4 4 4M7 11H5.5v9.5h13V11H17"/></svg>`,
    bell: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>`,
    bag: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 22h36l-3 32H17z"/><path d="M24 22v-4a8 8 0 0 1 16 0v4"/></svg>`,
    search: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="28" cy="28" r="16"/><path d="m40 40 12 12"/></svg>`,
    receipt: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 9h32v46l-8-5-8 5-8-5-8 5z"/><path d="M24 22h16M24 31h16"/></svg>`,
    offline: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 26a32 32 0 0 1 44 0M17 34a22 22 0 0 1 30 0M24 42a12 12 0 0 1 16 0"/><circle cx="32" cy="50" r="2"/><path d="M12 12l40 40"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
    down: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>`,
    truck: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M6 18h32v26H6zM38 28h12l8 9v7H38z"/><circle cx="17" cy="46" r="5"/><circle cx="48" cy="46" r="5"/></svg>`,
  };

  // ---------- разбор названия: флаги, память, цвет, SIM, состояние, модель ----------
  const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
  const REGIONS = { "🇺🇸": "США", "🇪🇺": "Европа", "🇮🇳": "Индия", "🇸🇬": "Сингапур", "🇯🇵": "Япония", "🇦🇪": "ОАЭ", "🇷🇺": "Россия", "🇰🇷": "Корея", "🇨🇳": "Китай", "🇭🇰": "Гонконг", "🇰🇿": "Казахстан", "🇬🇧": "Великобритания", "🇨🇦": "Канада", "🇦🇺": "Австралия" };
  const COLORS = ["cosmic orange", "deep blue", "sky blue", "mist blue", "light gold", "cloud white", "space black", "space gray", "space grey", "jet black", "rose gold", "pink rose gold",
    "sterling silver", "gray camouflage", "grey camouflage", "midnight black", "natural titanium", "desert titanium", "black titanium", "white titanium", "blue titanium",
    "pacific blue", "sierra blue", "alpine green", "ice blue", "icy blue", "icyblue", "onyx black", "golden white", "emerald green", "stellar grey", "starlight blue", "midnight blue",
    "cloud blue", "prussian blue", "phantom black", "titanium black", "titanium gray", "titanium silver", "titanium blue",
    "midnight", "starlight", "starlite", "silver", "black", "white", "blue", "lavender", "sage", "pink", "green", "yellow", "purple", "red", "gold", "orange", "gray", "grey",
    "teal", "ultramarine", "cream", "olive", "natural", "desert", "navy", "graphite", "violet", "lilac", "blush", "citrus", "indigo", "mint", "brown", "obsidian", "berry",
    "розовая", "розовый", "черная", "черный", "чёрный", "чёрная", "белая", "белый", "синяя", "синий", "серая", "серый", "бежевая", "бежевый", "зеленая", "зеленый", "оранжевая", "оранжевый", "голубой", "фиолетовый"];
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const COLOR_RES = COLORS.map((c) => [c, new RegExp(`(^|[\\s,/(])${reEsc(c)}(?=[\\s,/).]|$)`)]);
  const SIM_RE = /(^|[\s(,])(2\s?sim\s?\+\s?e-?sim|e-?sim\s?\+\s?e-?sim|sim\s?\+\s?e-?sim|sim\s?\+\s?sim|2\s?sim|dual\s?sim|r-sim|e-?sim|sim)(?=[\s),.]|$)/i;
  const CODE_RE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,7}\b|\b\d{3}-\d{5}-\d{2}\b/g;
  const PHONE_CATS = new Set(["iPhone", "iPhone б/у", "Samsung", "Xiaomi", "Honor и Huawei", "Смартфоны", "iPad и планшеты"]);
  const cap = (s) => s.replace(/(^|[\s/-])([a-zа-яё])/g, (m, a, b) => a + b.toUpperCase());

  const parsedCache = new WeakMap();
  const P = (it) => { let p = parsedCache.get(it); if (!p) { p = parse(it); parsedCache.set(it, p); } return p; };

  function condition(low, cat) {
    if (/\basis\b/.test(low)) return ["ASIS", "ASIS"];
    let m = low.match(/витрин[а-я]*\s*(\d{2,3}\s?%)?/);
    if (m) return ["Витрина", m[1] ? `Витрина, АКБ ${m[1].replace(/\s/g, "")}` : "Витрина"];
    const used = [["идеал", "Б/у, идеальное"], ["отлич", "Б/у, отличное"], ["хорош", "Б/у, хорошее"], ["удовл", "Б/у, удовлетворительное"], ["запчаст", "На запчасти"],
      ["ошибка", "Б/у, есть дефект"], ["уценк", "Уценка"], ["(бу", "Б/у"], ["б/у", "Б/у"]];
    for (const [k, v] of used) if (low.includes(k)) return ["Б/у", v];
    if (cat === "iPhone б/у") return ["Б/у", "Б/у"];
    if (/актив/.test(low)) return ["Новый", "Новый, активирован"];
    if (/вскрыт|открыт|повреждена упаковка/.test(low)) return ["Новый", "Новый, вскрыта упаковка"];
    return ["Новый", "Новый"];
  }

  // кириллица-двойник внутри латинского слова («Orangе» с русской «е» в прайсе) → латиница,
  // иначе такой товар теряет цвет, выпадает из вариантов и фильтра «Цвет»
  const HOMO = { а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", к: "k", А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y" };
  const fixMixed = (s) => s.replace(/[A-Za-zА-Яа-яЁё]+/g, (w) => (/[A-Za-z]/.test(w) && /[А-Яа-яЁё]/.test(w) && [...w].every((ch) => /[A-Za-z]/.test(ch) || HOMO[ch])
    ? [...w].map((ch) => HOMO[ch] || ch).join("") : w));

  function parse(it) {
    const raw = fixMixed(String(it.name || ""));
    const cat = String(it.category || "");
    const flags = raw.match(FLAG_RE) || [];
    let s = raw.replace(FLAG_RE, " ").replace(/[“”″]/g, '"').replace(/\s{2,}/g, " ").trim();
    const low = s.toLowerCase();
    const [cond, condNote] = condition(low, cat);
    // SIM
    let sim = "";
    const sm = s.match(SIM_RE);
    if (sm) {
      sim = sm[2].toLowerCase().replace(/\s/g, "").replace(/e-sim/g, "esim").replace("dualsim", "2sim");
      s = s.replace(sm[2], " ");
    }
    // скобки-состояния, ASIS
    s = s.replace(/\((?:[^)]*?)(?:идеал|отлич|хорош|удовл|витрин|актив|уценк|запчаст|ошибка|бу\b|бу -|открыт|e-?sim|sim)[^)]*\)/gi, " ").replace(/\bASIS\b/gi, " ");
    s = s.replace(/\(\s*\)/g, " ").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").replace(/,(\s*,)+/g, ",").replace(/[\s.,]+$/, "").trim();
    // память: ОЗУ/накопитель или объём
    let memory = "", memVal = 0, memRaw = "";
    const rm = s.match(/(^|[\s,])(\d{1,2})\s?\/\s?(\d{2,4}|1|2)\s?(tb|тб|gb|гб)?(?=[\s,)]|$)/i);
    if (rm) {
      const tb = /tb|тб/i.test(rm[4] || "") || /^[12]$/.test(rm[3]);
      memory = `${rm[2]}/${rm[3]} ${tb ? "ТБ" : "ГБ"}`;
      memVal = +rm[3] * (tb ? 1024 : 1) * 100 + +rm[2];
      memRaw = rm[0].trim();
    } else {
      const phoneish = PHONE_CATS.has(cat);
      for (const mm of s.matchAll(/(^|\s)(16|32|64|128|256|512|1|2)\s?(tb|тб|gb|гб)?(?=[\s,).]|$)/gi)) {
        const v = +mm[2], unit = mm[3] || "";
        const ok = unit ? true : v >= 64 ? true : (v === 16 || v === 32) && phoneish && mm.index > 0;
        if (!ok || ((v === 1 || v === 2) && !unit)) continue;
        const tb = /tb|тб/i.test(unit) || v <= 2;
        memory = `${v} ${tb ? "ТБ" : "ГБ"}`;
        memVal = v * (tb ? 1024 : 1) * 100;
        memRaw = mm[0].trim();
        break;
      }
    }
    // цвет
    let color = "";
    const lc = s.toLowerCase();
    for (const [c, re] of COLOR_RES) {
      const m = re.exec(lc);
      if (m) { const i = m.index + m[1].length; color = s.substr(i, c.length); break; }
    }
    const colorKey = color ? cap(color.toLowerCase()).replace("Grey", "Gray") : "";
    // заголовок
    let title = s;
    if (memRaw) title = title.replace(memRaw, memory);
    if (/^(iPhone|iPhone б\/у)$/.test(cat) && /^(\d|se\b|xs|xr|x\b)/i.test(title)) title = "iPhone " + title;
    else if (cat === "Samsung" && /^([asmz]\d|s\d|z\s?(fold|flip))/i.test(title)) title = "Galaxy " + title;
    else if (cat === "Apple Watch" && !/watch/i.test(title)) title = "Apple Watch " + title;
    else if (cat === "MacBook" && !/macbook/i.test(title)) title = "MacBook " + title;
    else if (cat === "Galaxy Watch" && !/galaxy/i.test(title)) title = "Galaxy " + title;
    const letters = title.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
    if (letters.length > 10 && letters.replace(/[^A-ZА-ЯЁ]/g, "").length / letters.length > 0.7) {
      title = title.split(" ").map((w) => (/\d/.test(w) || w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(" ");
    }
    if (color && color === color.toLowerCase() && /[a-z]/.test(color)) title = title.replace(color, cap(color));
    // модель (для группировки вариантов)
    let model = s;
    if (memRaw) model = model.replace(memRaw, " ");
    if (color) model = model.replace(color, " ");
    model = model.replace(CODE_RE, " ").replace(/\s{2,}/g, " ").trim();
    const isPhone = /^(iPhone|iPhone б\/у|Samsung|Xiaomi|Honor и Huawei|Смартфоны)$/.test(cat) && !/\b(tab|pad|watch|buds)\b/i.test(s);
    return {
      title, flags: flags.join(""), region: flags.map((f) => REGIONS[f] || f).join(", "), sim, isPhone,
      memory, memVal, color: color ? cap(color) : "", colorKey, model, cond, condNote,
      version: [flags.join(" "), sim].filter(Boolean).join(" · "),
      group: `${cat}|${model.toLowerCase()}|${condNote}`,
      // «плойка»/«пс5» ищут как «ps» — у консоли в названии «Playstation», добавляем ей тот же ключ
      hay: norm(`${title} ${raw} ${cat} ${groupOf(cat) || ""}${/playstation/i.test(raw) ? " ps" : ""}`),
    };
  }

  // ---------- поиск: нормализация, синонимы, опечатки ----------
  const WORDS = [ // [ключ, каноническая форма, только точное совпадение]
    ["айфон", "iphone"], ["ифон", "iphone"], ["iphone", "iphone"],
    ["про", "pro", 1], ["макс", "max", 1], ["плюс", "plus", 1], ["мини", "mini", 1], ["эир", "air", 1], ["эйр", "air", 1], ["аир", "air", 1], ["эа", "air", 1], ["ультра", "ultra", 1],
    ["аирподс", "airpods"], ["эйрподс", "airpods"], ["эирподс", "airpods"], ["эарподс", "airpods"], ["airpod", "airpods"],
    ["аиртег", "airtag"], ["эйртег", "airtag"], ["аиртэг", "airtag"], ["эиртег", "airtag"],
    ["эпл", "apple"], ["эппл", "apple"], ["айпад", "ipad"], ["макбук", "macbook"], ["аймак", "imac"], ["вотч", "watch"], ["часы", "watch", 1], ["часов", "watch", 1],
    ["самсунг", "samsung"], ["галакси", "galaxy"], ["гармин", "garmin"], ["сяоми", "xiaomi"], ["ксиоми", "xiaomi"], ["редми", "redmi"], ["хонор", "honor"], ["хуавей", "huawei"],
    ["дайсон", "dyson"], ["фен", "supersonic", 1], ["стайлер", "airwrap"], ["самокат", "электротранспорт"], ["куго", "kugoo"], ["холодильн", "автохолодильники"],
    ["феникс", "fenix"], ["фэникс", "fenix"], ["инстинкт", "instinct"], ["форраннер", "forerunner"], ["форранер", "forerunner"], ["форер", "forerunner"], ["форан", "forerunner"],
    ["венью", "venu"], ["вену", "venu", 1], ["вивоактив", "vivoactive"], ["тактикс", "tactix"], ["эпикс", "epix"],
    ["плойк", "ps"], ["пс", "ps", 1], ["сони", "sony"], ["дуалсенс", "dualsense"], ["джойстик", "геймпад"], ["gamepad", "геймпад"], ["плейстейшн", "playstation"],
    ["маршал", "marshall"], ["яндекс", "yandex"], ["станци", "станция"], ["колонк", "станция"], ["алис", "станция"], ["очки", "очки", 1], ["рейбан", "ray"],
    ["зарядк", "charger"], ["зарядн", "charger"], ["блок", "charger"], ["адаптер", "charger"], ["adapter", "charger"], ["рация", "рации"], ["кофемаш", "кофе"],
    ["наушн", "наушники"], ["аксессуар", "аксессуары"], ["игр", "игры"], ["бу", "б", 1], ["тб", "tb", 1], ["tb", "tb", 1],
    ["черн", "black"], ["серебр", "silver"], ["бел", "white"], ["син", "blue"], ["голуб", "blue"], ["сер", "gray"], ["grey", "gray"],
    ["оранж", "orange"], ["лаванд", "lavender"], ["фиолет", "lavender"], ["розов", "pink"], ["зелен", "green"], ["золот", "gold"], ["титан", "titanium"],
  ];
  function mapWord(w, partial) {
    for (const [k, c, exact] of WORDS) if (exact ? w === k : w.startsWith(k)) return c;
    if (partial && w.length >= 3 && /[а-я]/.test(w)) for (const [k, c, exact] of WORDS) if (!exact && k.startsWith(w)) return c;
    if (partial && w.length >= 4 && /[а-я]/.test(w)) for (const [k, c, exact] of WORDS) if (!exact && k.length >= 5 && lev(w, k.slice(0, w.length)) <= 1) return c;
    return w;
  }
  function norm(s, partial = false) {
    let t = String(s || "").toLowerCase().replace(/ё/g, "е").replace(FLAG_RE, " ").replace(/\+/g, " plus ");
    t = t.replace(/(\d+)\s*(?:gb|гб|гиг[а-я]*)(?![a-zа-я])/g, "$1 ").replace(/(\d+)\s*(?:tb|тб|тер[а-я]*)(?![a-zа-я])/g, "$1 tb ");
    t = t.replace(/(\d)([a-zа-я])/g, "$1 $2").replace(/([a-zа-я])(\d)/g, "$1 $2");
    return t.split(/[^a-zа-я0-9]+/).filter(Boolean).map((w) => mapWord(w, partial));
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  function tokMatch(q, h) {
    if (h.startsWith(q)) return h.length === q.length ? 3 : 2;
    if (q.length >= 4 && /[a-zа-я]/.test(q) && h.length >= 3 && (lev(q, h) <= 1 || (h.length > q.length && lev(q, h.slice(0, q.length)) <= 1))) return 1;
    return 0;
  }
  function score(it, qt) {
    const hay = P(it).hay;
    let s = 0;
    for (const q of qt) {
      let best = 0;
      for (const h of hay) { const m = tokMatch(q, h); if (m > best) best = m; if (best === 3) break; }
      if (!best) return 0;
      s += best;
    }
    return s;
  }
  function hl(text, qt) {
    if (!qt || !qt.length) return esc(text);
    return String(text).split(/(\s+)/).map((part) => {
      if (!part.trim()) return part;
      const toks = norm(part);
      return toks.length && toks.some((t) => qt.some((q) => tokMatch(q, t))) ? `<mark>${esc(part)}</mark>` : esc(part);
    }).join("");
  }
  const queryTokens = () => norm(state.q, true);

  // ---------- группы, популярность ----------
  const GROUP_TABLE = [
    ["Смартфоны", "phone", ["iPhone", "iPhone б/у", "Samsung", "Xiaomi", "Honor и Huawei", "Смартфоны"]],
    ["Компьютеры и планшеты", "laptop", ["MacBook", "iMac", "iPad и планшеты", "Ноутбуки"]],
    ["Часы", "watch", ["Apple Watch", "Galaxy Watch", "Garmin", "Смарт-часы"]],
    ["Звук и аксессуары", "headphones", ["Наушники", "Колонки", "Аксессуары", "Умные очки"]],
    ["Дом, красота, игры", "home", ["Dyson", "Пылесосы", "Кофе", "Телевизоры", "Игры", "Камеры", "Рации"]],
    ["Транспорт и отдых", "scooter", ["Электротранспорт", "Автотехника", "Отопители и генераторы", "Автохолодильники", "SUP-доски", "Лодочные моторы"]],
  ];
  const GROUP_ART = { // иконка группы — нарисованное устройство
    phone: { name: "Pro Cosmic Orange", category: "iPhone" }, laptop: { name: "MacBook Air Sky Blue", category: "MacBook" },
    watch: { name: "Apple Watch Ultra Natural", category: "Apple Watch" }, headphones: { name: "AirPods Max Midnight", category: "Наушники" },
    home: { name: "Dyson Supersonic Pink", category: "Dyson" }, scooter: { name: "Kugoo Sage", category: "Электротранспорт" }, box: { name: "Lavender", category: "" },
  };
  const catGroup = new Map();
  const groupOf = (cat) => catGroup.get(cat) || (state.groups.length ? "Другое" : "");
  const SEARCHES = ["17 Pro Max", "AirPods", "Galaxy S26", "MacBook Air", "Apple Watch", "Dyson", "Самокат", "PS5"];

  function buildGroups(data) {
    const counts = new Map();
    state.items.forEach((it) => counts.set(it.category, (counts.get(it.category) || 0) + 1));
    let groups;
    if (Array.isArray(data.groups) && data.groups.length) {
      groups = data.groups.map((g) => ({ name: String(g.name), icon: g.icon || "box",
        categories: (g.categories || []).map((c) => ({ name: String(c.name), count: counts.get(String(c.name)) || 0 })).filter((c) => c.count) }));
    } else {
      groups = GROUP_TABLE.map(([name, icon, cats]) => ({ name, icon, categories: cats.filter((c) => counts.has(c)).map((c) => ({ name: c, count: counts.get(c) })) }));
    }
    const known = new Set(groups.flatMap((g) => g.categories.map((c) => c.name)));
    const rest = [...counts.keys()].filter((c) => !known.has(c));
    if (rest.length) groups.push({ name: "Другое", icon: "box", categories: rest.map((c) => ({ name: c, count: counts.get(c) })) });
    groups = groups.filter((g) => g.categories.length);
    groups.forEach((g) => { g.count = g.categories.reduce((s, c) => s + c.count, 0); });
    catGroup.clear();
    groups.forEach((g) => g.categories.forEach((c) => catGroup.set(c.name, g.name)));
    state.groups = groups;
  }

  // популярность: pop с бэкенда, иначе — оценка (в наличии + новизна модели в категории)
  const popCache = new Map();
  function computePop() {
    popCache.clear();
    const idx = new Map(), total = new Map();
    state.items.forEach((it) => total.set(it.category, (total.get(it.category) || 0) + 1));
    state.items.forEach((it) => {
      const k = (idx.get(it.category) || 0) + 1;
      idx.set(it.category, k);
      const est = (inStock(it) ? 40 : 0) + 60 * (k / total.get(it.category));
      // pop 1..100 — реальная популярность с бэкенда (выше любой оценки); 0/нет — холодный старт, берём оценку,
      // иначе при pop:0 у всех «Популярные» = порядок строк в таблице (iPhone SE 2020 первым)
      const pop = Number(it.pop) || 0;
      popCache.set(it.id, pop > 0 ? 100 + pop : est);
    });
  }
  const popOf = (it) => popCache.get(it.id) || 0;
  function buildTrending(data) {
    const ids = Array.isArray(data.trending) ? data.trending.map(String).filter((id) => byId.has(id)) : [];
    if (ids.length) { state.trending = ids.slice(0, 12).map(find); }
    else {
      // холодный старт: featured + товары в наличии из самых больших категорий (дешёвая мелочь — кабели, блоки — не в счёт)
      const featured = state.items.filter((it) => it.featured && inStock(it));
      const prices = state.items.map((it) => it.price).sort((a, b) => a - b);
      const median = prices[Math.floor(prices.length / 2)] || 0;
      const pool = state.items.filter((it) => inStock(it) && it.price >= median);
      const cats = [...new Set(pool.map((it) => it.category))]
        .map((c) => [c, pool.filter((it) => it.category === c).length]).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const picks = [...featured];
      cats.forEach(([c]) => {
        const seenModels = new Set();
        pool.filter((it) => it.category === c).sort((a, b) => popOf(b) - popOf(a))
          .forEach((it) => { const m = P(it).model; if (seenModels.size < 2 && !seenModels.has(m)) { seenModels.add(m); picks.push(it); } });
      });
      state.trending = [...new Set(picks)].slice(0, 12);
    }
    state.searches = Array.isArray(data.searches) && data.searches.length ? data.searches.map(String).slice(0, 8) : SEARCHES;
  }

  // ---------- аналитика (анонимно) ----------
  const track = (() => {
    let sid = store.get("sid", null);
    if (!sid) { sid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); store.set("sid", sid); }
    let q = [];
    function push(type, extra = {}) {
      try {
        const e = { t: Date.now(), type, ...extra };
        q.push(e);
        if (q.length > 200) q = q.slice(-200);
        if (debug) console.debug("[track]", e);
      } catch {}
    }
    function flush() {
      try {
        if (!q.length) return;
        if (!cfg.API_URL) { if (debug) console.debug("[track] демо-режим, пачка не отправлена:", q.length); q = []; return; }
        const events = q.splice(0, 50);
        fetch(cfg.API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "track", sid, events }), keepalive: true }).catch(() => {});
      } catch {}
    }
    setInterval(flush, 15000);
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
    addEventListener("pagehide", flush);
    return { push, flush };
  })();

  // ---------- карточки ----------
  const delta = (it) => (it.prev_price ? it.price - Number(it.prev_price) : 0);
  function deltaTag(it) {
    const d = delta(it);
    if (!d) return "";
    return `<span class="delta ${d < 0 ? "down" : "up"}"><span class="vh">${d < 0 ? "Подешевело на" : "Подорожало на"}</span><span aria-hidden="true">${d < 0 ? "↓" : "↑"}</span> ${money(Math.abs(d))}</span>`;
  }
  const photos = (it) => String(it.photo || "").split("|").map((s) => s.trim()).filter(Boolean);
  const statusText = (it) => inStock(it) ? `В наличии${+it.qty > 0 ? ` · ${it.qty} шт` : ""}` : String(it.status || "").replace(/^./, (c) => c.toUpperCase());
  const metaText = (it) => { const p = P(it); return [p.cond !== "Новый" || p.condNote !== "Новый" ? p.condNote : "", p.sim].filter(Boolean).join(" · "); };

  function tileHTML(it, cls = "tile", inner = "") {
    const art = window.ProductArt.tile(it);
    const ph = photos(it)[0];
    return `<div class="${cls}" style="${art.style}">${inner}${ph ? `<img src="${esc(ph)}" alt="" loading="lazy">` : art.svg}</div>`;
  }

  function cardHTML(it, i, extra = "", qt) {
    const p = P(it);
    const st = statusText(it), meta = metaText(it), eq = rubEq(it.price);
    return `
      <button class="card press ${extra}" data-id="${esc(it.id)}" style="--i:${i}" aria-label="${esc(`${p.title}, ${money(it.price)}${eq ? ` (${eq})` : ""}, ${st}${meta ? `, ${meta}` : ""}`)}">
        ${tileHTML(it)}
        ${favs.has(it.id) ? `<svg class="fav-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z"/></svg>` : ""}
        <div class="info" aria-hidden="true">
          <span class="status ${inStock(it) ? "" : "wait"}">${esc(st)}</span>
          <span class="name">${hl(p.title, qt)} <span class="flags">${p.flags}</span></span>
          ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
          <div class="price-row"><span class="price">${money(it.price)}</span>${deltaTag(it)}</div>
          ${eq ? `<span class="eq">${eq}</span>` : ""}
        </div>
      </button>`;
  }
  const railMore = (label, attrs) => `<button class="rail-more press" ${attrs}><span>${esc(label)}</span>${ICON.chevron}</button>`;

  function openLink(url) {
    if (inTelegram && url.startsWith("https://t.me/")) tg.openTelegramLink(url);
    else if (inTelegram) tg.openLink(url);
    else window.open(url, "_blank", "noopener");
  }
  function contactManager(it) {
    if (!shop.manager) return shop.phone ? (location.href = `tel:${shop.phone.replace(/[^\d+]/g, "")}`) : toast("Контакт менеджера не настроен");
    const text = it ? `Здравствуйте! Интересует: ${P(it).title}${P(it).flags ? " " + P(it).flags : ""} — ${money(it.price)}` : "Здравствуйте! Хочу проконсультироваться.";
    openLink(`https://t.me/${shop.manager}?text=${encodeURIComponent(text)}`);
  }

  let toastTimer;
  function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }
  function confirmAsk(text, cb) {
    if (tgAt("6.2")) tg.showConfirm(text, (ok) => ok && cb());
    else if (window.confirm(text)) cb();
  }

  // ---------- данные ----------
  const CACHE_KEY = "catalog_cache_v2";
  let lastFetch = 0, deepLinkDone = false;

  function ingest(data) {
    if (!data || !Array.isArray(data.items)) throw new Error("Неверный ответ сервера");
    if (data.shop) {
      if (data.shop.name) shop.name = String(data.shop.name);
      if (data.shop.manager) shop.manager = String(data.shop.manager).replace(/^@/, "");
      if (data.shop.phone) shop.phone = String(data.shop.phone);
      shop.currency = String(data.shop.currency || "RUB").toUpperCase() === "USD" ? "USD" : "RUB";
      shop.rate = Number(data.shop.usd_rate) || 0;
      shop.cbr = Number(data.shop.cbr_rate) || 0;
      shop.rateDate = String(data.shop.rate_date || "");
      shop.rateSource = String(data.shop.rate_source || "");
    }
    state.items = data.items.filter((it) => it && it.status !== "скрыт")
      .map((it) => ({ ...it, id: String(it.id), price: Number(it.price) || 0, featured: it.featured === true || /^да$/i.test(String(it.featured || "")) }));
    byId.clear();
    state.items.forEach((it) => byId.set(it.id, it));
    buildGroups(data);
    computePop();
    buildTrending(data);
    state.updatedAt = data.updated_at ? new Date(data.updated_at) : null;
    if (state.route.name === "cat" && !catGroup.has(state.route.cat)) state.route = { name: "home" };
    if (state.route.name === "group" && !state.groups.some((g) => g.name === state.route.group)) state.route = { name: "home" };
    state.loaded = true;
  }

  async function fetchCatalog() {
    const url = cfg.API_URL ? `${cfg.API_URL}?action=catalog` : "catalog.json";
    const ctrl = window.AbortController ? new AbortController() : null;
    const t = setTimeout(() => ctrl && ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl && ctrl.signal });
      if (!res.ok) throw new Error(`Ошибка сервера (${res.status})`);
      const data = await res.json();
      // бэкенд при сбое отвечает 200 {ok:false, error:"Каталог временно недоступен"} — показываем его текст
      if (data && data.ok === false) throw new Error(data.error || "Каталог временно недоступен");
      return data;
    } finally { clearTimeout(t); }
  }

  async function refresh() {
    const hadData = state.loaded;
    try {
      const data = await fetchCatalog();
      lastFetch = Date.now();
      const prev = store.get(CACHE_KEY, null);
      store.set(CACHE_KEY, { data, savedAt: Date.now() });
      const wasOffline = state.offline;
      state.offline = false;
      if (hadData && prev && JSON.stringify(prev.data) === JSON.stringify(data)) { if (wasOffline) render(); return; }
      ingest(data);
      afterLoad(!hadData);
    } catch (e) {
      if (hadData) { state.offline = true; render(); toast("Нет связи — показаны сохранённые цены"); }
      else renderError(e);
    }
  }

  function afterLoad(first) {
    renderCats();
    render({ anim: first, keepScroll: !first });
    renderBadges();
    if (sheetCtx && sheetCtx.type === "product" && find(sheetCtx.id)) showProduct(sheetCtx.id, { keepScroll: true });
    if (!deepLinkDone) {
      deepLinkDone = true;
      const start = inTelegram ? tg.initDataUnsafe && tg.initDataUnsafe.start_param : new URLSearchParams(location.search).get("p");
      const id = start && String(start).replace(/^p_/, "");
      if (id && find(id)) showProduct(id);
    }
  }

  // ---------- выборки ----------
  const routeCat = () => (state.route.name === "cat" ? state.route.cat : null);
  const catItems = (c = routeCat()) => state.items.filter((it) => it.category === c);
  const FILTERS = [["mem", "Память"], ["color", "Цвет"], ["cond", "Состояние"], ["sim", "SIM"]];
  const fval = { mem: (it) => P(it).memory, color: (it) => P(it).colorKey, cond: (it) => P(it).cond, sim: (it) => P(it).sim };
  const COND_ORDER = ["Новый", "Б/у", "Витрина", "ASIS"];
  function facets(list) {
    const out = {};
    FILTERS.forEach(([k]) => {
      const m = new Map();
      list.forEach((it) => { const v = fval[k](it); if (v) m.set(v, (m.get(v) || 0) + 1); });
      let vals = [...m.entries()];
      if (k === "mem") vals.sort((a, b) => P(list.find((it) => fval.mem(it) === a[0])).memVal - P(list.find((it) => fval.mem(it) === b[0])).memVal);
      else if (k === "cond") vals.sort((a, b) => COND_ORDER.indexOf(a[0]) - COND_ORDER.indexOf(b[0]));
      else vals.sort((a, b) => b[1] - a[1]);
      if (k === "color") vals = vals.slice(0, 24);
      out[k] = vals;
    });
    const prices = list.map((it) => it.price).filter((n) => n > 0);
    out.price = prices.length ? [Math.min(...prices), Math.max(...prices)] : [0, 0];
    return out;
  }
  const filtersActive = () => FILTERS.some(([k]) => state.f[k].size) || state.f.min != null || state.f.max != null;
  function resetFilters() { FILTERS.forEach(([k]) => state.f[k].clear()); state.f.min = state.f.max = null; }
  function applyFilters(list, skip) {
    const f = state.f;
    return list.filter((it) => {
      if (state.stockOnly && !inStock(it)) return false;
      for (const [k] of FILTERS) if (k !== skip && f[k].size && !f[k].has(fval[k](it))) return false;
      if (skip !== "price" && f.min != null && it.price < f.min) return false;
      if (skip !== "price" && f.max != null && it.price > f.max) return false;
      return true;
    });
  }
  function sortList(list, mode) {
    const l = list.slice();
    if (mode === "pop") l.sort((a, b) => popOf(b) - popOf(a));
    if (mode === "asc") l.sort((a, b) => a.price - b.price);
    if (mode === "desc") l.sort((a, b) => b.price - a.price);
    if (mode === "new") l.sort((a, b) => Number(b.id) - Number(a.id));
    return l;
  }
  function searchResults() {
    const qt = queryTokens();
    if (!qt.length) return [];
    let list = state.items.filter((it) => !state.stockOnly || inStock(it));
    const scored = list.map((it, i) => [it, score(it, qt), i]).filter(([, s]) => s > 0);
    scored.sort((a, b) => b[1] - a[1] || (inStock(b[0]) - inStock(a[0])) || popOf(b[0]) - popOf(a[0]) || a[2] - b[2]);
    list = scored.map(([it]) => it);
    return state.sort === "default" || state.sort === "pop" ? list : sortList(list, state.sort);
  }

  // ---------- шапка: большой заголовок → компактный ----------
  const isSearching = () => state.tab === "catalog" && (state.searchMode || !!state.q);

  function setHead(title, sub, { right = "" } = {}) {
    $("#largeTitle").textContent = title;
    $("#navTitle").textContent = title;
    const s = $("#largeSub");
    s.innerHTML = sub || "";
    s.hidden = !sub;
    $("#navRight").innerHTML = right;
    document.title = title === shop.name ? shop.name : `${title} — ${shop.name}`;
    updateBack();
    onScroll();
  }

  function liveSub() {
    if (!state.updatedAt || isNaN(state.updatedAt)) return `<span class="live${state.offline ? " off" : ""}"><i></i>${state.offline ? "Офлайн · сохранённые цены" : "Цены дня"}</span>`;
    const d = state.updatedAt;
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const today = d.toDateString() === new Date().toDateString();
    const text = today ? `Цены обновлены сегодня в ${time}` : `Цены от ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}, ${time}`;
    return state.offline ? `<span class="live off"><i></i>Офлайн · ${text.replace(/^Цены/, "цены")}</span>` : `<span class="live"><i></i>${text}</span>`;
  }

  // заголовок уезжает под навбар, привязан к прокрутке (rAF, только transform/opacity)
  let scrollTick = false;
  const ltEl = $("#largeTitle"), navTitleEl = $("#navTitle"), headEl = $("#head");
  function onScroll() {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (sheetCtx) return;
      // только layout-величины: transform (презентация шторки, сам заголовок) не искажает расчёт
      const y = window.scrollY;
      const navB = $("#nav").offsetHeight;
      const sb = $("#searchbar").getBoundingClientRect();
      const lh = headEl.offsetHeight && ltEl.offsetParent ? ltEl.offsetHeight : 0;
      const ltTop = ltEl.offsetTop - y;
      const p = lh ? M.clamp((navB - ltTop) / lh, 0, 1) : 1;
      const collapsed = lh === 0 || ltTop + lh <= navB + 2;
      document.body.classList.toggle("collapsed", collapsed);
      document.body.classList.toggle("stuck", state.tab === "catalog" && sb.height > 0 && sb.top <= navB + 0.5 && y > 0);
      if (M.reduced()) { ltEl.style.opacity = ""; navTitleEl.style.opacity = collapsed ? "1" : "0"; return; }
      const over = y < 0 ? Math.min(0.06, -y / 900) : 0; // iOS: при оттягивании вниз заголовок чуть растёт
      ltEl.style.transform = over ? `scale(${1 + over})` : p ? `scale(${1 - 0.04 * p})` : "";
      ltEl.style.opacity = p > 0.45 ? String(1 - (p - 0.45) / 0.55) : "";
      const q = lh ? M.clamp((p - 0.6) / 0.4, 0, 1) : 1;
      navTitleEl.style.opacity = String(q);
      navTitleEl.style.transform = q < 1 ? `translateY(${(1 - q) * 6}px)` : "";
    });
  }

  function updateBack() {
    const sub = state.tab === "catalog" && (isSearching() || state.route.name !== "home");
    const need = !!sheetCtx || sub;
    if (inTelegram) { try { need ? tg.BackButton.show() : tg.BackButton.hide(); } catch {} }
    const b = $("#navBack");
    b.hidden = inTelegram || !!sheetCtx || !(state.tab === "catalog" && state.route.name !== "home" && !isSearching());
    $("#navBackText").textContent = state.route.name === "cat" && state.route.from ? state.route.from : shop.name;
    armHistory(need);
  }
  // кнопка «Назад» браузера / жест Android на обычном сайте: пока открыт подэкран или шторка, в истории лежит
  // одна запись-страж — «Назад» снимает её и делает шаг назад внутри витрины, а не уводит с сайта со всем состоянием.
  // В Telegram это делает BackButton, историю не трогаем.
  let histArmed = false;
  function armHistory(need) {
    if (inTelegram || !need || histArmed) return;
    try { history.pushState({ storeGuard: 1 }, ""); histArmed = true; } catch {}
  }
  addEventListener("popstate", () => {
    if (inTelegram || !histArmed) return;
    histArmed = false;
    backAction();
    updateBack();
  });
  function backAction() {
    if (sheetCtx) return closeSheet();
    if (state.tab === "catalog" && isSearching()) return cancelSearch();
    if (state.tab === "catalog" && state.route.name === "cat" && state.route.from) return go({ name: "group", group: state.route.from });
    if (state.tab === "catalog" && state.route.name !== "home") return go({ name: "home" });
  }

  // ---------- экраны ----------
  let introDone = false;
  let lazyIO = null, moreIO = null;
  const lazyFns = new Map();

  function render({ anim = false, keepScroll = true } = {}) {
    const view = $("#view");
    const y = window.scrollY;
    const prevT = anim ? null : M.captureThumbs(view);
    const prevR = anim ? null : M.captureRolls(view);
    const tgl = $(".toggle[data-stock]", view);
    const wasStock = tgl ? tgl.classList.contains("on") : null;
    document.body.dataset.tab = state.tab;
    document.body.classList.toggle("searching", isSearching());
    view.classList.toggle("anim", anim);
    const intro = anim && !introDone && !M.reduced() && state.tab === "catalog" && !isSearching() && state.route.name === "home";
    if (!intro) document.body.classList.remove("intro");
    if (!state.loaded) return;
    if (lazyIO) lazyIO.disconnect();
    if (moreIO) moreIO.disconnect();
    lazyFns.clear();
    if (state.tab === "orders") renderOrders();
    else if (state.tab === "cart") renderCart();
    else if (state.tab === "fav") renderFav();
    else if (isSearching()) renderSearch();
    else if (state.route.name === "group") renderGroup();
    else if (state.route.name === "cat") renderCategory();
    else renderHome();
    if (intro) {
      introDone = true;
      document.body.classList.add("intro");
      const words = ltEl.textContent.trim().split(/\s+/);
      ltEl.innerHTML = words.map((w, i) => `<span class="w" style="--k:${i}">${esc(w)}</span>`).join(" ");
      setTimeout(() => document.body.classList.remove("intro"), 2600);
    }
    if (keepScroll) window.scrollTo(0, y);
    M.thumbs(view, prevT);
    M.applyRolls(view, prevR);
    const tgl2 = $(".toggle[data-stock]", view);
    if (tgl2 && wasStock !== null) M.replay(tgl2, "on", wasStock);
    bindLazy(view);
    M.parallax(view);
    M.ambient(view);
    M.reveal(view, anim);
    syncMain();
    onScroll();
  }

  // ленивые полки: содержимое рисуется, когда секция подъезжает к экрану
  function lazySection(key, fn, minH = 330, cls = "shelf") {
    lazyFns.set(key, fn);
    return `<section class="${cls} lazy" data-lazy="${key}" style="min-height:${minH}px" aria-busy="true"></section>`;
  }
  function bindLazy(view) {
    const els = $$("[data-lazy]", view);
    if (!els.length) return;
    const fill = (el) => {
      const fn = lazyFns.get(el.dataset.lazy);
      if (!fn) return;
      const html = fn();
      if (!html) { el.remove(); return; }
      el.innerHTML = html;
      el.classList.remove("lazy");
      el.style.minHeight = "";
      el.removeAttribute("aria-busy");
      const lab = $("h2[id]", el);
      if (lab) el.setAttribute("aria-labelledby", lab.id);
      M.parallax(view);
      M.ambient(view);
    };
    if (!("IntersectionObserver" in window)) return els.forEach(fill);
    lazyIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { lazyIO.unobserve(e.target); fill(e.target); } }), { rootMargin: "700px 0px" });
    els.forEach((el) => lazyIO.observe(el));
  }

  // постраничная сетка: 40 карточек, следующие — при подъезде к концу
  const PAGE_SIZE = 40;
  let page = { list: [], shown: 0, qt: null };
  function gridCards(list, qt, wideFirst) {
    page = { list, shown: Math.min(PAGE_SIZE, list.length), qt };
    return list.slice(0, page.shown).map((it, k) => cardHTML(it, k, wideFirst && k === 0 && list.length > 2 ? "wide" : "", qt)).join("") + moreBtn();
  }
  const moreBtn = () => (page.list.length > page.shown
    ? `<button class="more-btn" data-act="more-grid">Показать ещё ${Math.min(PAGE_SIZE, page.list.length - page.shown)} из ${page.list.length - page.shown}</button>` : "");
  function morePage() {
    const btn = $("#view .more-btn");
    if (!btn) return;
    const next = page.list.slice(page.shown, page.shown + PAGE_SIZE);
    const start = page.shown;
    page.shown += next.length;
    btn.insertAdjacentHTML("beforebegin", next.map((it, k) => cardHTML(it, k, "late", page.qt)).join(""));
    btn.remove();
    const grid = $("#view .grid");
    if (grid) grid.insertAdjacentHTML("beforeend", moreBtn());
    observeMore();
    M.parallax($("#view"));
    if (start && document.activeElement === document.body) { const c = $$("#view .grid .card")[start]; if (c) c.focus({ preventScroll: true }); }
  }
  function observeMore() {
    const b = $("#view .more-btn");
    if (!b || !("IntersectionObserver" in window)) return;
    moreIO = moreIO || new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { moreIO.unobserve(e.target); morePage(); } }), { rootMargin: "900px 0px" });
    moreIO.observe(b);
  }

  function renderCats() {
    const bar = $("#cats");
    const prev = M.captureThumbs(bar);
    const act = activeGroup();
    const names = ["Все", ...state.groups.map((g) => g.name)];
    bar.innerHTML = names.map((g) => `<button class="cat ${g === act ? "active" : ""}" data-group="${esc(g)}" ${g === act ? 'aria-current="true"' : ""}>${esc(g)}</button>`).join("")
      + `<button class="cat cat-all" data-act="all-cats" aria-haspopup="dialog">Все категории</button>`;
    M.thumbs(bar, prev);
  }
  function activeGroup() {
    if (state.route.name === "group") return state.route.group;
    if (state.route.name === "cat") return groupOf(state.route.cat);
    return "Все";
  }

  function renderSkeleton() {
    setHead(shop.name, `<span class="live"><i></i>Загружаем цены…</span>`);
    const card = `<div class="sk sk-card"></div>`;
    $("#view").innerHTML = `
      <div class="sk-wrap" aria-busy="true" aria-label="Загрузка каталога">
        <div class="sk-stats"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
        <div class="sk sk-feature"></div>
        <div class="sk sk-title"></div><div class="sk-rail">${card.repeat(4)}</div>
        <div class="sk sk-title"></div><div class="sk-rail">${card.repeat(4)}</div>
      </div>`;
  }

  function renderError(e) {
    // «Failed to fetch» / «signal is aborted» — технические английские тексты браузера; показываем только наши («Ошибка сервера (502)»)
    const detail = e && e.message && !(e instanceof TypeError || e.name === "AbortError" || e instanceof SyntaxError) ? e.message
      : e && e.name === "AbortError" ? "Сервер не ответил за 15 секунд" : "";
    setHead(shop.name, `<span class="live off"><i></i>Нет соединения</span>`);
    $("#view").innerHTML = `
      <div class="grid"><div class="empty" role="alert">${ICON.offline}<b>Не удалось загрузить каталог</b>
        <p>Проверьте подключение к интернету и попробуйте ещё раз.${detail ? `<br><small>${esc(detail)}</small>` : ""}</p>
        <button class="pill-btn" data-act="retry">Повторить</button></div></div>`;
  }

  function groupArt(g) { return window.ProductArt.tile(GROUP_ART[g.icon] || GROUP_ART.box); }
  function groupTile(g, i) {
    const art = groupArt(g);
    return `<button class="gtile press" data-group="${esc(g.name)}" style="--i:${i}" aria-label="${esc(`${g.name}: ${goods(g.count)}`)}">
        <div class="tile" style="${art.style}">${art.svg}</div>
        <div class="gt-info" aria-hidden="true"><b>${esc(g.name)}</b><span>${goods(g.count)}</span></div>
      </button>`;
  }
  const shelfHead = (id, title, more = "") => `<div class="shelf-head"><h2 id="${id}">${title}</h2>${more}</div>`;
  const rail = (list, bigFirst, moreHTML = "") => `<div class="rail">${list.map((it, k) => cardHTML(it, k, bigFirst && k === 0 && list.length > 2 ? "big" : "")).join("")}${moreHTML}</div>`;

  function renderHome() {
    setHead(shop.name, liveSub());
    const cheaper = state.items.filter((it) => delta(it) < 0).sort((a, b) => delta(a) - delta(b));
    const featured = state.items.filter((it) => it.featured);
    const stock = state.items.filter(inStock).length;
    const cats = catGroup.size;
    const feat = featured.find(inStock) || cheaper.find(inStock) || state.trending[0] || state.items.find(inStock) || state.items[0];
    const eyebrow = featured.includes(feat) ? "Выбор магазина" : delta(feat) < 0 ? "Выгоднее всего сегодня" : "Популярное сейчас";
    const trending = state.trending.filter((it) => it !== feat);
    const fp = feat && P(feat);
    const seen = store.get("seen", []).map(find).filter(Boolean);
    const eq = feat && rubEq(feat.price);
    $("#view").innerHTML = `
      <div class="stats">
        <span class="stat"><b>${stock.toLocaleString("ru-RU")}</b>в наличии</span>
        <span class="stat"><b>${cats}</b>${plural(cats, "категория", "категории", "категорий")}</span>
        ${isUSD() && shop.rate > 0 ? `<span class="stat"><b>$1 = ${(/вручную/i.test(shop.rateSource) ? shop.rate : shop.cbr || shop.rate).toFixed(2).replace(".", ",")} ₽</b>${/вручную/i.test(shop.rateSource) ? "курс магазина" : "курс ЦБ"}</span>` : ""}
        ${cheaper.length ? `<span class="stat down"><b>↓ ${cheaper.length}</b>подешевело</span>` : ""}
      </div>
      ${feat ? `
      <button class="card feature press" data-id="${esc(feat.id)}" style="--i:0" aria-label="${esc(`${eyebrow}: ${fp.title}, ${money(feat.price)}${eq ? ` (${eq})` : ""}`)}">
        ${tileHTML(feat, "tile", `<i class="ground" aria-hidden="true"></i><i class="sheen" aria-hidden="true"></i>`)}
        <div class="info" aria-hidden="true">
          <span class="eyebrow">${eyebrow}</span>
          <span class="name">${esc(fp.title)} <span class="flags">${fp.flags}</span></span>
          ${metaText(feat) ? `<span class="meta">${esc(metaText(feat))}</span>` : ""}
          <div class="price-row"><span class="price">${money(feat.price)}</span>${delta(feat) < 0 ? `<s>${money(feat.prev_price)}</s>` : ""}${deltaTag(feat)}</div>
          ${eq ? `<span class="eq">${eq}</span>` : ""}
          <span class="status ${inStock(feat) ? "" : "wait"}">${esc(statusText(feat))}</span>
        </div>
      </button>` : ""}
      ${trending.length ? `
      <section class="shelf" aria-labelledby="sh-trend">
        ${shelfHead("sh-trend", "Популярное <span>сейчас</span>")}
        ${rail(trending, true)}
      </section>` : ""}
      ${state.searches.length ? `
      <section class="shelf s-often" aria-labelledby="sh-often">
        ${shelfHead("sh-often", "Часто ищут")}
        <div class="chips-rail">${state.searches.map((s) => `<button class="chip press" data-q="${esc(s)}">${ICON.clock.replace("clock", "")}${esc(s)}</button>`).join("")}</div>
      </section>` : ""}
      <section class="gsec" aria-labelledby="sh-groups">
        ${shelfHead("sh-groups", "Категории", `<button class="more" data-act="all-cats">Все ${cats} ›</button>`)}
        <div class="gtiles">${state.groups.map(groupTile).join("")}</div>
      </section>
      ${featured.length ? lazySection("featured", () => shelfHead("sh-feat", "Выбор магазина") + rail(featured.slice(0, 12), true)) : ""}
      ${cheaper.length ? lazySection("cheaper", () => shelfHead("sh-cheap", "Подешевело <span>сегодня</span>") + rail(cheaper.filter((x) => x !== feat).slice(0, 12), false)) : ""}
      ${seen.length ? lazySection("seen", () => shelfHead("sh-seen", "Вы смотрели", `<button class="more" data-act="clear-seen">Очистить</button>`) + rail(seen.slice(0, 12), false), 300) : ""}
      ${lazySection("help", () => `
        <h2>Нужна помощь с выбором?</h2>
        <p>Менеджер подскажет по наличию, цвету и доставке.</p>
        <div class="help-actions">
          ${shop.manager ? `<button class="pill-btn" data-act="chat">Написать в Telegram</button>` : ""}
          ${shop.phone ? `<a class="pill-btn ghost" href="tel:${esc(shop.phone.replace(/[^\d+]/g, ""))}">Позвонить ${esc(shop.phone)}</a>` : ""}
        </div>`, 160, "help")}`;
  }

  function renderGroup() {
    const g = state.groups.find((x) => x.name === state.route.group);
    if (!g) { state.route = { name: "home" }; return renderHome(); }
    setHead(g.name, goods(g.count));
    const items = state.items.filter((it) => groupOf(it.category) === g.name);
    const top = sortList(items.filter(inStock), "pop").slice(0, 12);
    $("#view").innerHTML = `
      <div class="pills" role="list">${g.categories.map((c) => `<button class="pill press" role="listitem" data-cat="${esc(c.name)}">${esc(c.name)}<small>${c.count}</small></button>`).join("")}</div>
      <div class="ctiles">${g.categories.map((c, i) => {
        const list = state.items.filter((it) => it.category === c.name);
        const rep = sortList(list.filter(inStock).length ? list.filter(inStock) : list, "pop")[0];
        const min = Math.min(...list.map((it) => it.price).filter((n) => n > 0));
        return `<button class="gtile ctile press ${i === 0 ? "wide" : ""}" data-cat="${esc(c.name)}" style="--i:${i}" aria-label="${esc(`${c.name}: ${goods(c.count)}, от ${money(min)}`)}">
            ${tileHTML(rep)}
            <div class="gt-info" aria-hidden="true"><b>${esc(c.name)}</b><span>${goods(c.count)} · от ${money(min)}</span></div>
          </button>`;
      }).join("")}</div>
      ${top.length ? `<section class="shelf" aria-labelledby="sh-gtop">${shelfHead("sh-gtop", "Популярное <span>в разделе</span>")}${rail(top, true)}</section>` : ""}`;
  }

  function toolbarHTML(searchMode) {
    const sorts = searchMode
      ? [["default", "Лучшие"], ["asc", "Дешевле"], ["desc", "Дороже"], ["new", "Новые"]]
      : [["pop", "Популярные"], ["asc", "Дешевле"], ["desc", "Дороже"], ["new", "Новые"]];
    return `
      <div class="toolbar">
        <div class="seg" data-thumb="sort" role="group" aria-label="Сортировка">${sorts.map(([v, l]) => `<button data-sort="${v}" class="${state.sort === v ? "on" : ""}" aria-pressed="${state.sort === v}">${l}</button>`).join("")}</div>
      </div>`;
  }
  function filterBarHTML(base) {
    const fc = facets(base);
    const chips = FILTERS.filter(([k]) => fc[k].length > 1).map(([k, label]) => {
      const sel = state.f[k];
      const text = sel.size === 1 ? `${label}: ${[...sel][0]}` : sel.size ? `${label} · ${sel.size}` : label;
      return `<button class="fchip ${sel.size ? "on" : ""}" data-filter="${k}" aria-haspopup="dialog">${esc(text)}${ICON.down}</button>`;
    });
    const [lo, hi] = fc.price;
    if (hi > lo) {
      const on = state.f.min != null || state.f.max != null;
      chips.push(`<button class="fchip ${on ? "on" : ""}" data-filter="price" aria-haspopup="dialog">${on ? `${money(state.f.min ?? lo)} – ${money(state.f.max ?? hi)}` : "Цена"}${ICON.down}</button>`);
    }
    return `<div class="fbar" role="group" aria-label="Фильтры">
        <button class="toggle ${state.stockOnly ? "on" : ""}" data-stock aria-pressed="${state.stockOnly}"><span>В наличии</span></button>
        ${chips.join("")}
        ${filtersActive() ? `<button class="fchip reset" data-act="f-reset">Сбросить</button>` : ""}
      </div>`;
  }

  function renderCategory() {
    const c = routeCat();
    const base = catItems(c);
    const list = sortList(applyFilters(base), state.sort);
    setHead(c, filtersActive() || state.stockOnly ? `${goods(list.length)} из ${base.length}` : goods(base.length));
    $("#view").innerHTML = `${toolbarHTML(false)}${filterBarHTML(base)}
      <div class="grid">${list.length
        ? gridCards(list, null, true)
        : `<div class="empty">${ICON.search}<b>Ничего нет</b><p>Под выбранные фильтры товаров не нашлось.</p><button class="pill-btn ghost" data-act="f-reset">Сбросить фильтры</button></div>`}
      </div>`;
    observeMore();
  }

  function renderSearch() {
    if (!state.q.trim()) {
      setHead("Поиск", "");
      const recent = store.get("recent", []);
      $("#view").innerHTML = `
        <div class="s-panel">
          ${recent.length ? `
          <div class="s-head"><h2>Недавние</h2><button data-act="clear-recent">Очистить</button></div>
          <div class="rows">${recent.map((r) => `<button class="row" data-q="${esc(r)}">${ICON.clock}<span>${esc(r)}</span></button>`).join("")}</div>` : ""}
          <div class="s-head"><h2>Часто ищут</h2></div>
          <div class="chips">${state.searches.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div>
          <div class="s-head"><h2>Разделы</h2><button data-act="all-cats">Все категории</button></div>
          <div class="rows">${state.groups.map((g) => `<button class="row" data-group="${esc(g.name)}"><span>${esc(g.name)}</span><small>${g.count}</small>${ICON.chevron}</button>`).join("")}</div>
        </div>`;
      return;
    }
    const list = searchResults();
    const qt = queryTokens();
    setHead("Поиск", list.length ? `Найдено: ${goods(list.length)}` : "");
    // «В наличии», включённый в категории, действует и на поиск — показываем переключатель, чтобы его было видно и можно было снять
    const stockBar = state.stockOnly ? `<div class="fbar" role="group" aria-label="Фильтры"><button class="toggle on" data-stock aria-pressed="true"><span>В наличии</span></button></div>` : "";
    $("#view").innerHTML = `${list.length ? toolbarHTML(true) : ""}${stockBar}
      <div class="grid">${list.length
        ? gridCards(list, qt, false)
        : `<div class="empty">${ICON.search}<b>Ничего не нашли</b>
            <p>По запросу «${esc(state.q.trim())}» товаров нет${state.stockOnly ? " в наличии" : ""}. Попробуйте иначе:</p>
            <div class="chips">${state.searches.slice(0, 5).map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div>
            <div class="req-card">${ICON.truck}<b>Не нашли? Привезём под заказ</b>
              <p>Оставьте заявку — менеджер найдёт «${esc(state.q.trim())}», сообщит цену и срок.</p>
              <button class="pill-btn" data-act="request">Оставить заявку</button></div>
          </div>`}
      </div>`;
    observeMore();
  }

  function renderFav() {
    const list = state.items.filter((it) => favs.has(it.id));
    setHead("Избранное", list.length ? goods(list.length) : "");
    $("#view").innerHTML = `<div class="grid">${list.length
      ? gridCards(list, null, true)
      : `<div class="empty">${ICON.heart.replace('aria-hidden="true"', 'aria-hidden="true" style="width:54px;height:54px"')}<b>Пока пусто</b><p>Нажмите «В избранное» в карточке товара, чтобы сохранить его здесь.</p><button class="pill-btn" data-act="go-catalog">Перейти в каталог</button></div>`}</div>`;
    observeMore();
  }

  // ---------- корзина ----------
  const cartLine = (id) => cart.find((l) => l.id === String(id));
  const cartCount = () => cart.reduce((s, l) => s + l.qty, 0);
  const cartRows = () => cart.map((l) => ({ ...l, it: find(l.id) }));
  const cartTotal = () => cartRows().reduce((s, r) => s + (r.it ? r.it.price * r.qty : 0), 0);
  const maxQty = (it) => Math.min(10, inStock(it) && +it.qty > 0 ? +it.qty : 10); // бэкенд принимает qty 1..10
  let pendingBadge = false;

  function coveredBySheet(el) {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !top || sheet.contains(top);
  }
  function addToCart(id) {
    const it = find(id);
    if (!it) return;
    const l = cartLine(id);
    if (l) {
      if (l.qty >= maxQty(it)) return toast(`Доступно не больше ${maxQty(it)} шт`);
      l.qty++;
    } else cart.push({ id: it.id, qty: 1, title: P(it).title, price: it.price });
    store.set("cart", cart);
    hap.tap("medium");
    track.push("cart", { item_id: it.id });
    const src = sheetCtx && sheetCtx.type === "product" ? $(".p-hero .art-svg, .p-hero img", sheet) : null;
    if (sheetCtx && sheetCtx.type === "product") refreshBuybar();
    const icon = $('#tabbar [data-tab="cart"] svg');
    let target = icon.getBoundingClientRect();
    const covered = !!sheetCtx && coveredBySheet(icon);
    if (covered) {
      pendingBadge = true;
      const bb = $(".buybar .buy", sheet);
      const r = bb && bb.getBoundingClientRect();
      target = r && r.width ? r : { left: innerWidth / 2 - 20, top: innerHeight - 24, width: 40, height: 40 };
    }
    toast("Добавлено в корзину");
    M.fly(src, target, () => { if (covered) hap.tap("soft"); else { pendingBadge = false; renderBadges("add"); hap.tap("light"); } });
  }
  function setQty(id, q) {
    const l = cartLine(id);
    if (!l) return;
    const it = find(id);
    if (it && q > maxQty(it)) return toast(`Доступно не больше ${maxQty(it)} шт`);
    if (q <= 0) cart = cart.filter((x) => x !== l); else l.qty = q;
    hap.sel();
    saveCart();
    render();
  }

  function renderCart() {
    const rows = cartRows();
    const count = rows.filter((r) => r.it).reduce((s, r) => s + r.qty, 0);
    const total = cartTotal(), eq = rubEq(total);
    setHead("Корзина", rows.length ? `${goods(count)} на ${money(total)}` : "", { right: rows.length ? `<button class="nav-btn" data-act="clear-cart">Очистить</button>` : "" });
    if (!rows.length) {
      $("#view").innerHTML = `<div class="grid"><div class="empty">${ICON.bag}<b>В корзине пусто</b><p>Добавляйте товары кнопкой «В корзину» — оформим всё одним заказом.</p><button class="pill-btn" data-act="go-catalog">Перейти в каталог</button></div></div>`;
      return;
    }
    $("#view").innerHTML = `
      <div class="lines">${rows.map((r) => {
        if (!r.it) return `
          <div class="line gone"><div class="line-info"><b>${esc(r.title || "Товар")}</b><span class="meta wait">Больше нет в продаже</span>
            <div class="line-row"><button class="text-btn" data-act="remove" data-id="${esc(r.id)}">Удалить</button></div></div></div>`;
        const p = P(r.it), mx = maxQty(r.it);
        return `
          <div class="line">
            <button class="line-tile press" data-act="open" data-id="${esc(r.id)}" aria-label="Открыть ${esc(p.title)}">${tileHTML(r.it)}</button>
            <div class="line-info">
              <b>${esc(p.title)} <span class="flags">${p.flags}</span></b>
              <span class="meta ${inStock(r.it) ? "" : "wait"}">${esc(statusText(r.it))}${metaText(r.it) ? ` · ${esc(metaText(r.it))}` : ""}</span>
              <div class="line-row">
                <div class="stepper" role="group" aria-label="Количество: ${esc(p.title)}">
                  <button data-act="dec" data-id="${esc(r.id)}" aria-label="${r.qty === 1 ? "Удалить из корзины" : "Уменьшить"}">${r.qty === 1 ? ICON.trash : "−"}</button>
                  <output aria-live="polite" data-roll="q-${esc(r.id)}">${r.qty}</output>
                  <button data-act="inc" data-id="${esc(r.id)}" aria-label="Увеличить" ${r.qty >= mx ? "disabled" : ""}>+</button>
                </div>
                <div class="line-sum"><span data-roll="ls-${esc(r.id)}">${money(r.it.price * r.qty)}</span><small>${r.qty > 1 ? `${money(r.it.price)} × ${r.qty}` : rubEq(r.it.price)}</small></div>
              </div>
            </div>
          </div>`;
      }).join("")}</div>
      <div class="summary">
        <div class="sum-row"><span>Товары (${count})</span><span data-roll="sub">${money(total)}</span></div>
        <div class="sum-row"><span>Получение</span><span>самовывоз или доставка</span></div>
        <div class="sum-total"><span>Итого</span><b data-roll="total" data-haptic>${money(total)}</b></div>
        ${eq ? `<div class="sum-eq"><span>${rateCaption()}</span><span data-roll="total-eq">${eq}</span></div>` : ""}
      </div>
      <p class="cart-note">Оплата при получении. Менеджер подтвердит наличие и детали.</p>
      <div class="checkout-bar">
        <div class="tot"><span>Итого</span><b data-roll="bar">${money(total)}</b>${eq ? `<small data-roll="bar-eq">${eq}</small>` : ""}</div>
        <button class="buy" data-act="checkout" ${count ? "" : "disabled"}>Оформить заказ</button>
      </div>`;
  }

  // ---------- заказы ----------
  function renderOrders() {
    const orders = store.get("orders", []);
    setHead("Заказы", orders.length ? "Менеджер свяжется по каждому заказу" : "");
    if (!orders.length) {
      $("#view").innerHTML = `<div class="grid"><div class="empty">${ICON.receipt}<b>Заказов пока нет</b><p>Оформленные заказы появятся здесь.</p><button class="pill-btn" data-act="go-catalog">Перейти в каталог</button></div></div>`;
      return;
    }
    const fmt = (o, n) => (o.currency === "USD" ? `$${digits(n, " ")}` : o.currency === "RUB" ? `${digits(n, " ")} ₽` : money(n));
    $("#view").innerHTML = `<div class="orders">${orders.map((o, oi) => {
      if (o.request) return `
        <article class="order">
          <div class="order-head"><b>Заявка #${esc(o.id)}</b><span>${esc(o.date)}</span></div>
          <div class="order-lines">Привезти под заказ: ${esc(o.request)}${o.comment ? `<br>${esc(o.comment)}` : ""}</div>
          <div class="order-foot"><span class="order-status">Передана менеджеру</span></div>
        </article>`;
      const items = o.items || [{ id: o.item_id, title: o.item, qty: 1, price: o.price }];
      const total = o.total ?? o.price;
      const tiles = items.slice(0, 4).map((x) => tileHTML(find(x.id) || { name: x.title || "", category: "" })).join("");
      return `
        <article class="order">
          <div class="order-head"><b>Заказ #${esc(o.id)}</b><span>${esc(o.date)}</span></div>
          <div class="order-tiles" aria-hidden="true">${tiles}${items.length > 4 ? `<span class="more-n">+${items.length - 4}</span>` : ""}</div>
          <div class="order-lines">${items.map((x) => `${esc(x.title)}${x.qty > 1 ? ` × ${x.qty}` : ""}`).join("<br>")}${o.delivery ? `<br>${esc(o.delivery)}${o.address ? `: ${esc(o.address)}` : ""}` : ""}</div>
          <div class="order-foot">
            <div><div class="sum">${fmt(o, total)}</div><span class="order-status">Передан менеджеру</span></div>
            <button class="text-btn" data-act="repeat" data-i="${oi}">Повторить</button>
          </div>
        </article>`;
    }).join("")}</div>`;
  }

  function renderBadges(mode) {
    const el = $("#cartCount");
    const n = cartCount();
    const txt = n > 99 ? "99+" : String(n);
    const was = el.classList.contains("show");
    $('#tabbar [data-tab="cart"]').setAttribute("aria-label", n ? `Корзина, ${goods(n)}` : "Корзина");
    if (pendingBadge && mode !== "add") return; // покажем, когда шторка уедет
    if (mode && was && n) M.roll(el, txt); else el.textContent = txt;
    el.classList.toggle("show", n > 0);
    if (mode && n && !was) { el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }
    if (mode === "add") M.pulse($('#tabbar [data-tab="cart"] svg'));
  }

  // ---------- шторка: презентация как в iOS ----------
  let sheetCtx = null, lastFocus = null, tiltOff = null;
  const sheet = $("#sheet"), scrim = $("#scrim");
  const OUTSIDE = ["#nav", "#head", "#searchbar", "#view", "#tabbar"];
  const PAGE = OUTSIDE.map((s) => $(s));
  const frame = document.createElement("div");
  frame.className = "present-frame";
  frame.setAttribute("aria-hidden", "true");
  scrim.before(frame);
  const sh = { y: 0, h: 1, anim: null, gen: 0, origin: null, morph: null, presented: false };
  const pageScaleOn = () => !desktop.matches && !M.reduced();

  function prepPresent() {
    if (sh.presented || !pageScaleOn()) return;
    sh.presented = true;
    const vw = innerWidth, vh = innerHeight;
    PAGE.forEach((el) => { const r = el.getBoundingClientRect(); el.style.transformOrigin = `${vw / 2 - r.left}px ${vh / 2 - r.top}px`; el.style.willChange = "transform"; });
  }
  const pageScale = () => (sh.presented ? 1 - 0.06 * M.clamp(1 - sh.y / sh.h, 0, 1) : 1);
  function setY(y) {
    sh.y = y;
    sheet.style.transform = `translate3d(0,${y.toFixed(2)}px,0)`;
    const p = M.clamp(1 - y / sh.h, 0, 1);
    scrim.style.opacity = p.toFixed(3);
    if (!sh.presented) return;
    const t = p < 0.002 ? "" : `scale(${(1 - 0.06 * p).toFixed(5)})`;
    PAGE.forEach((el) => { el.style.transform = t; });
    frame.style.opacity = p < 0.002 ? "" : Math.min(1, p * 1.6).toFixed(3);
    frame.style.transform = t;
  }
  function clearPresent() {
    sh.presented = false;
    PAGE.forEach((el) => { el.style.transform = ""; el.style.transformOrigin = ""; el.style.willChange = ""; });
    frame.style.opacity = ""; frame.style.transform = "";
  }
  function cancelMorph() {
    if (!sh.morph) return;
    sh.morph.cleanup();
    sh.morph = null;
  }
  const at = (r, dy) => ({ left: r.left, top: r.top + dy, width: r.width, height: r.height });

  function sheetIn(fromTile) {
    const gen = ++sh.gen;
    const v0 = sh.anim && !sh.anim.done ? -sh.anim.velocity : 0;
    if (sh.anim) sh.anim.stop();
    cancelMorph();
    const hero = $(".p-hero", sheet);
    const canMorph = !!(fromTile && hero && fromTile.isConnected && !M.reduced());
    if (M.reduced()) {
      sheet.classList.add("open"); scrim.classList.add("open");
      sheet.style.transform = ""; scrim.style.opacity = "";
      sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      return;
    }
    if (desktop.matches) {
      let dst = null;
      if (canMorph) { sheet.classList.add("measure"); dst = hero.getBoundingClientRect(); sheet.classList.remove("measure"); void sheet.offsetWidth; }
      sheet.classList.add("open"); scrim.classList.add("open");
      if (!dst) return;
      const src = fromTile.getBoundingClientRect();
      const m = M.morph(fromTile, hero);
      if (!m) return;
      hero.classList.add("landed");
      hero.style.opacity = "0"; fromTile.style.opacity = "0";
      const cleanup = () => { hero.style.opacity = ""; fromTile.style.opacity = ""; m.remove(); };
      m.draw(0, src, dst);
      const a = M.spring({ from: 0, to: 1, response: 0.46, rest: 0.001, onUpdate: (q) => m.draw(q, src, dst), onComplete: () => { if (sh.morph && sh.morph.a === a) { cleanup(); sh.morph = null; } } });
      sh.morph = { a, cleanup: () => { a.stop(); cleanup(); } };
      return;
    }
    // телефон: шторка на пружине, страница позади уменьшается и скругляется
    sheet.classList.add("open"); scrim.classList.add("open");
    scrim.style.transition = "none";
    sh.h = sheet.offsetHeight || 1;
    const resumed = sheet.style.transform && sh.y > 0 && sh.y < sh.h;
    prepPresent();
    const start = resumed ? sh.y : sh.h;
    setY(start);
    sheet.style.willChange = "transform";
    let m = null, src = null, dst = null;
    if (canMorph && start > 1) {
      const hr = hero.getBoundingClientRect();
      dst = { left: hr.left, top: hr.top - start, width: hr.width, height: hr.height };
      src = fromTile.getBoundingClientRect();
      m = M.morph(fromTile, hero);
      if (m) {
        hero.classList.add("landed");
        hero.style.opacity = "0"; fromTile.style.opacity = "0";
        m.draw(0, src, at(dst, start));
        sh.morph = { cleanup: () => { hero.style.opacity = ""; fromTile.style.opacity = ""; m.remove(); } };
      }
    }
    sh.anim = M.spring({
      from: start, to: 0, velocity: v0, response: 0.44,
      onUpdate: (y) => { setY(y); if (m) m.draw(M.clamp(1 - y / start, 0, 1), src, at(dst, y)); },
      onComplete: () => {
        if (gen !== sh.gen) return;
        sheet.style.transform = ""; sheet.style.willChange = ""; scrim.style.transition = "";
        cancelMorph();
      },
    });
  }

  function originTarget(ctx) {
    if (!ctx || ctx.type !== "product") return null;
    const o = sh.origin;
    let t = o && o.id === ctx.id && o.tile.isConnected ? o.tile : null;
    if (!t) t = $$(`#view [data-id="${CSS.escape(ctx.id)}"] .tile`).find((el) => { const r = el.getBoundingClientRect(); return r.width && r.bottom > 0 && r.top < innerHeight; }) || null;
    if (!t) return null;
    const r = t.getBoundingClientRect();
    if (!r.width || t.querySelector("img")) return null;
    return t;
  }

  function sheetOut(v, ctx) {
    const gen = ++sh.gen;
    if (sh.anim) sh.anim.stop();
    cancelMorph();
    scrim.classList.remove("open");
    const finish = () => {
      if (gen !== sh.gen) return;
      sheet.classList.remove("open");
      sheet.style.transform = ""; sheet.style.willChange = ""; scrim.style.opacity = ""; scrim.style.transition = "";
      cancelMorph();
      clearPresent();
      onScroll();
      sh.origin = null;
      if (pendingBadge) { pendingBadge = false; setTimeout(() => renderBadges("add"), 60); }
    };
    if (M.reduced()) {
      const a = sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in" });
      a.onfinish = finish;
      return;
    }
    const hero = $(".p-hero", sheet);
    const target = hero ? originTarget(ctx) : null;
    if (desktop.matches) {
      sheet.classList.remove("open");
      if (target) {
        const src = hero.getBoundingClientRect(), dst = target.getBoundingClientRect();
        const m = M.morph(hero, target);
        if (m) {
          hero.style.opacity = "0"; target.style.opacity = "0";
          const cleanup = () => { target.style.opacity = ""; m.remove(); };
          m.draw(0, src, dst);
          const a = M.spring({ from: 0, to: 1, response: 0.42, rest: 0.001, onUpdate: (q) => m.draw(q, src, dst), onComplete: () => { if (gen === sh.gen) { cleanup(); sh.morph = null; } } });
          sh.morph = { cleanup: () => { a.stop(); cleanup(); } };
        }
      }
      setTimeout(finish, 460);
      return;
    }
    sh.h = sheet.offsetHeight || 1;
    scrim.style.transition = "none";
    const y0 = sh.y || (sheet.style.transform ? sh.y : 0);
    const end = sh.h + 12;
    let m = null, src0 = null, U = null;
    if (target && hero) {
      src0 = hero.getBoundingClientRect();
      const r = target.getBoundingClientRect(), s0 = pageScale(), cx = innerWidth / 2, cy = innerHeight / 2;
      U = { left: cx + (r.left - cx) / s0, top: cy + (r.top - cy) / s0, width: r.width / s0, height: r.height / s0 };
      const navB = $("#nav").getBoundingClientRect().bottom;
      if (U.top + U.height > navB && U.top < innerHeight - 40) {
        m = M.morph(hero, target);
        if (m) {
          hero.style.opacity = "0"; target.style.opacity = "0";
          sh.morph = { cleanup: () => { target.style.opacity = ""; m.remove(); } };
        }
      }
    }
    const scaled = (s) => { const cx = innerWidth / 2, cy = innerHeight / 2; return { left: cx + (U.left - cx) * s, top: cy + (U.top - cy) * s, width: U.width * s, height: U.height * s }; };
    if (m) m.draw(0, src0, scaled(pageScale()));
    sheet.style.willChange = "transform";
    sh.anim = M.spring({
      from: y0, to: end, velocity: v, response: 0.4,
      onUpdate: (y) => { setY(y); if (m) m.draw(M.clamp((y - y0) / (end - y0), 0, 1), at(src0, y - y0), scaled(pageScale())); },
      onComplete: finish,
    });
  }

  function openSheet(html, ctx, { keepScroll = false, from = null } = {}) {
    const wasOpen = !!sheetCtx;
    const prevT = wasOpen && keepScroll ? M.captureThumbs(sheet) : null;
    const prevR = wasOpen && keepScroll ? M.captureRolls(sheet) : null;
    const st = sheet.scrollTop;
    if (tiltOff) { tiltOff(); tiltOff = null; }
    sheet.innerHTML = `<div class="grabber" aria-hidden="true"></div>${html}`;
    sheet.scrollTop = keepScroll ? st : 0;
    sheet.setAttribute("aria-labelledby", "sheetTitle");
    sheet.dataset.type = ctx.type;
    sheet.classList.toggle("swap", wasOpen && !keepScroll);
    sheetCtx = ctx;
    if (!wasOpen) {
      lastFocus = document.activeElement;
      document.body.classList.add("sheet-open");
      document.documentElement.style.overflow = "hidden";
      OUTSIDE.forEach((s) => { const el = $(s); if (el) el.inert = true; });
      lockSwipes();
      sh.origin = from && ctx.type === "product" ? { id: ctx.id, tile: from } : null;
      sheetIn(from);
      setTimeout(() => sheet.focus({ preventScroll: true }), 60);
    } else if (!keepScroll) sheet.focus({ preventScroll: true });
    M.thumbs(sheet, prevT);
    M.applyRolls(sheet, prevR);
    updateBack();
    syncMain();
  }
  function closeSheet(opts) {
    if (!sheetCtx) return;
    const v = opts && typeof opts.velocity === "number" ? opts.velocity : 0;
    const ctx = sheetCtx;
    if (tiltOff) { tiltOff(); tiltOff = null; }
    sheetCtx = null;
    sheetOut(v, ctx);
    document.body.classList.remove("sheet-open");
    document.documentElement.style.overflow = "";
    OUTSIDE.forEach((s) => { const el = $(s); if (el) el.inert = false; });
    lockSwipes(); // свайпы остаются выключенными: шторку и страницу тянут пальцем, Telegram не должен сворачиваться
    if (lastFocus && lastFocus !== document.body && document.contains(lastFocus) && !sheet.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch {}
    else $("#view").focus({ preventScroll: true });
    updateBack();
    syncMain();
    onScroll();
  }

  // перетаскивание вниз: шторка идёт за пальцем 1:1, за верхним краем — резинка, отпускание — пружина со скоростью
  const drag = { on: false, active: false, x0: 0, y0: 0, base: 0, lastY: 0, lastT: 0, v: 0 };
  function dStart(x, y) {
    if (desktop.matches || !sheetCtx) return;
    Object.assign(drag, { on: true, active: false, x0: x, y0: y, lastY: y, lastT: performance.now(), v: 0 });
  }
  function dMove(x, y, e) {
    if (!drag.on) return;
    const dx = x - drag.x0, dy = y - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (dy > 0 && Math.abs(dy) > Math.abs(dx) && sheet.scrollTop <= 0) {
        drag.active = true;
        if (sh.anim) sh.anim.stop();
        sh.h = sheet.offsetHeight || 1;
        drag.base = sheet.style.transform ? sh.y : 0;
        drag.y0 = y; drag.lastY = y;
        scrim.style.transition = "none";
        sheet.style.willChange = "transform";
        sheet.classList.add("dragging");
        document.body.classList.add("sheet-dragging");
        prepPresent();
      } else { drag.on = false; return; }
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    const vi = ((y - drag.lastY) / Math.max(1, now - drag.lastT)) * 1000;
    drag.v = drag.v * 0.25 + vi * 0.75;
    drag.lastY = y; drag.lastT = now;
    const raw = drag.base + (y - drag.y0);
    setY(raw >= 0 ? raw : -M.rubber(-raw, sh.h));
  }
  function dEnd() {
    if (!drag.on) return;
    drag.on = false;
    if (!drag.active) return;
    drag.active = false;
    sheet.classList.remove("dragging");
    document.body.classList.remove("sheet-dragging");
    const v = performance.now() - drag.lastT > 90 ? 0 : drag.v;
    const projected = sh.y + v * 0.18;
    if (projected > Math.min(240, sh.h * 0.4) || (v > 800 && sh.y > 12)) { hap.tap("light"); closeSheet({ velocity: v }); return; }
    const gen = sh.gen;
    sh.anim = M.spring({ from: sh.y, to: 0, velocity: v, response: 0.36, onUpdate: setY,
      onComplete: () => { if (gen === sh.gen) { sheet.style.transform = ""; sheet.style.willChange = ""; scrim.style.transition = ""; } } });
  }
  sheet.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest("input, textarea, .g-track, .rail, .fopts")) return;
    dStart(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => { if (drag.on) dMove(e.touches[0].clientX, e.touches[0].clientY, e); }, { passive: false });
  sheet.addEventListener("touchend", dEnd);
  sheet.addEventListener("touchcancel", dEnd);
  sheet.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0 || !e.target.closest(".grabber, .p-hero, .sheet-head")) return;
    if (!desktop.matches && sheetCtx) e.preventDefault(); // мышью тянем шторку, а не выделяем заголовок
    dStart(e.clientX, e.clientY);
  });
  window.addEventListener("pointermove", (e) => { if (drag.on && e.pointerType !== "touch") dMove(e.clientX, e.clientY, e); });
  window.addEventListener("pointerup", (e) => { if (e.pointerType !== "touch") dEnd(); });

  // ---------- карточка товара ----------
  const DIMS = [["color", "Цвет", (x) => P(x).color], ["memory", "Память", (x) => P(x).memory], ["version", "Версия", (x) => P(x).version]];

  function variantsHTML(it) {
    const p = P(it);
    const group = state.items.filter((x) => P(x).group === p.group);
    if (group.length < 2) return "";
    const dims = DIMS.filter(([, , f]) => new Set(group.map(f)).size > 1);
    if (!dims.length) return "";
    const same = (x, key) => dims.every(([k, , f]) => k === key || f(x) === f(it));
    const pick = (cands, key) => cands.map((x) => [x, dims.reduce((s, [k, , f]) => s + (k !== key && f(x) === f(it) ? 10 : 0), 0) + (inStock(x) ? 2 : 0)])
      .sort((a, b) => b[1] - a[1] || a[0].price - b[0].price)[0][0];
    return `<div class="variants">${dims.map(([key, label, f]) => {
      let values = [...new Set(group.map(f))];
      if (key === "memory") values.sort((a, b) => (P(group.find((x) => f(x) === a)).memVal - P(group.find((x) => f(x) === b)).memVal));
      const cur = f(it);
      const opts = values.map((v) => {
        const cands = group.filter((x) => f(x) === v);
        const exact = cands.find((x) => same(x, key));
        const target = v === cur ? it : (exact || pick(cands, key));
        return { v, on: v === cur, dim: !exact, target };
      });
      const attrs = (o) => `role="radio" aria-checked="${o.on}" data-act="variant" data-id="${esc(o.target.id)}"`;
      if (key === "color") {
        return `<div><div class="v-label" id="vl-${key}">${label} — <b>${esc(cur || "—")}</b></div>
          <div class="swatches" data-thumb="v-color" data-thumb-inset="3 3" role="radiogroup" aria-labelledby="vl-${key}">${opts.map((o) => {
            const sw = window.ProductArt.swatch(o.v) || ["#f2f2f4", "#c9cad0"];
            return `<button class="sw ${o.on ? "on" : ""} ${o.dim ? "dim" : ""}" ${attrs(o)} aria-label="${esc(o.v || "Без цвета")}${o.dim ? ", другая конфигурация" : ""}" title="${esc(o.v)}"><i style="background:linear-gradient(135deg, ${sw[0]}, ${sw[1]})"></i></button>`;
          }).join("")}</div></div>`;
      }
      return `<div><div class="v-label" id="vl-${key}">${label}</div>
        <div class="opts" data-thumb="v-${key}" role="radiogroup" aria-labelledby="vl-${key}">${opts.map((o) => `<button class="opt ${o.on ? "on" : ""} ${o.dim ? "dim" : ""}" ${attrs(o)}><b>${esc(o.v || "—")}</b><span>${money(o.target.price)}</span></button>`).join("")}</div></div>`;
    }).join("")}</div>`;
  }

  function galleryHTML(it, landed) {
    const ph = photos(it), p = P(it);
    const art = window.ProductArt.tile(it);
    if (ph.length <= 1) return `<div class="tile p-hero${landed ? " landed" : ""}" style="${art.style}">${ph[0] ? `<img src="${esc(ph[0])}" alt="${esc(p.title)}">` : art.svg}</div>`;
    return `
      <div class="p-gallery">
        <div class="g-track" id="gTrack" aria-label="Фотографии товара" tabindex="0">${ph.map((u, i) => `<div class="tile p-hero g-slide" style="${art.style}"><img src="${esc(u)}" alt="${esc(p.title)} — фото ${i + 1} из ${ph.length}" ${i ? 'loading="lazy"' : ""}></div>`).join("")}</div>
        <div class="dots">${ph.map((_, i) => `<button class="dot-btn ${i ? "" : "on"}" data-act="slide" data-i="${i}" aria-label="Фото ${i + 1} из ${ph.length}" aria-current="${!i}"></button>`).join("")}</div>
      </div>`;
  }
  function bindGallery() {
    const tr = $("#gTrack");
    if (!tr) return;
    let last = 0;
    tr.addEventListener("scroll", () => {
      const i = Math.round(tr.scrollLeft / tr.clientWidth);
      if (i === last) return;
      last = i;
      hap.sel();
      $$(".dot-btn", sheet).forEach((d, k) => { d.classList.toggle("on", k === i); d.setAttribute("aria-current", k === i); });
    }, { passive: true });
  }

  function similarHTML(it) {
    const g = P(it).group;
    const list = state.items.filter((x) => x.category === it.category && x.id !== it.id && P(x).group !== g)
      .sort((a, b) => Math.abs(a.price - it.price) - Math.abs(b.price - it.price)).slice(0, 8);
    if (!list.length) return "";
    return `<section class="similar" aria-labelledby="simT"><h3 id="simT">Похожие товары</h3><div class="rail">${list.map((x, k) => cardHTML(x, k, "sm")).join("")}</div></section>`;
  }

  function buybarHTML(it) {
    const inCart = cartLine(it.id), eq = rubEq(it.price);
    return `
      <div class="bb-info"><b data-roll="bb">${money(it.price)}</b><span ${eq ? 'data-roll="bb-eq"' : ""}>${eq || (inStock(it) ? "Оплата при получении" : "Предзаказ · " + esc(it.status))}</span></div>
      ${inCart
        ? `<button class="buy alt fresh" data-act="gocart">В корзине (${inCart.qty}) · Оформить</button>`
        : `<button class="buy" data-act="add" data-id="${esc(it.id)}">${inStock(it) ? "В корзину" : "Предзаказать"}</button>`}`;
  }
  function refreshBuybar() {
    const it = sheetCtx && find(sheetCtx.id);
    const bb = $(".buybar", sheet);
    if (it && bb) bb.innerHTML = buybarHTML(it);
    syncMain();
  }

  function productHTML(it, landed) {
    const p = P(it), d = delta(it), fav = favs.has(it.id), watch = watches.has(it.id), eq = rubEq(it.price);
    const specs = [
      ["Состояние", p.condNote],
      p.memory && ["Память", p.memory],
      p.color && ["Цвет", p.color],
      p.region && ["Регион", `${p.region} ${p.flags}`],
      p.sim && ["SIM", p.sim],
      ["Наличие", inStock(it) ? `в наличии${+it.qty > 0 ? `, ${it.qty} шт` : ""}` : it.status],
    ].filter(Boolean);
    const desc = String(it.description || "");
    return `
      <button class="x" data-act="close" aria-label="Закрыть">${ICON.x}</button>
      ${galleryHTML(it, landed)}
      <div class="p-body">
        <div class="p-cat">${esc(it.category)}${p.condNote !== "Новый" ? ` · ${esc(p.condNote)}` : ""}</div>
        <h2 class="p-name" id="sheetTitle">${esc(p.title)} <span class="flags">${p.flags}</span></h2>
        <div class="p-price"><b data-roll="p-price" data-haptic>${money(it.price)}</b>${d < 0 ? `<s aria-label="Было ${money(it.prev_price)}">${money(it.prev_price)}</s>` : ""}${deltaTag(it)}</div>
        ${eq ? `<div class="p-eq"><span data-roll="p-eq">${eq}</span><small>${rateCaption()}</small></div>` : ""}
        <div class="p-avail ${inStock(it) ? "" : "wait"}">${esc(statusText(it))}</div>
        ${variantsHTML(it)}
        <div class="quick">
          <button class="qbtn press ${fav ? "on" : ""}" data-act="fav" data-id="${esc(it.id)}" aria-pressed="${fav}">${ICON.heart}<span>${fav ? "В избранном" : "В избранное"}</span></button>
          <button class="qbtn press bell ${watch ? "on" : ""}" data-act="watch" data-id="${esc(it.id)}" aria-pressed="${watch}" aria-label="Сообщить о снижении цены">${ICON.bell}<span>${watch ? "Слежу за ценой" : "Снижение цены"}</span></button>
          <button class="qbtn press" data-act="contact" data-id="${esc(it.id)}">${ICON.chat}<span>Спросить</span></button>
          <button class="qbtn press" data-act="share" data-id="${esc(it.id)}">${ICON.share}<span>Поделиться</span></button>
        </div>
        <div class="watch-note" id="watchNote" hidden></div>
        <div class="specs">${specs.map(([k, v]) => `<div class="spec"><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
        ${desc ? `<div class="desc ${desc.length > 120 ? "clamp" : ""}" id="desc">${esc(desc)}</div>` : ""}
        ${desc.length > 120 ? `<button class="link" data-act="more">Читать полностью</button>` : ""}
        ${similarHTML(it)}
      </div>
      <div class="buybar tg-hide">${buybarHTML(it)}</div>
      <div class="sheet-end tg-only" hidden></div>`;
  }

  function showProduct(id, opts = {}) {
    const it = find(id);
    if (!it) return toast("Товар не найден");
    if (state.searchMode && state.q.trim()) saveRecent(state.q);
    let prevHero = null;
    if (opts.variant) {
      const h = $(".p-hero", sheet);
      if (h) prevHero = { a: h.style.getPropertyValue("--tile-a"), b: h.style.getPropertyValue("--tile-b"), art: h.querySelector(".art-svg") };
    }
    const isNew = !(sheetCtx && sheetCtx.type === "product" && sheetCtx.id === it.id);
    openSheet(productHTML(it, opts.keepScroll), { type: "product", id: it.id }, opts);
    if (prevHero) M.heroSwap($(".p-hero", sheet), prevHero);
    if (inTelegram) { const end = $(".sheet-end", sheet); if (end) end.hidden = false; }
    bindGallery();
    tiltOff = M.tilt($(".p-hero", sheet), inTelegram ? tg : null);
    if (isNew && !opts.keepScroll) {
      track.push("view", { item_id: it.id });
      store.set("seen", [it.id, ...store.get("seen", []).filter((x) => x !== it.id)].slice(0, 12));
    }
  }

  // ---------- подписка на снижение цены ----------
  function toggleWatch(it, btn) {
    const on = !watches.has(it.id);
    const note = $("#watchNote");
    if (!inTelegram) {
      if (note) {
        const link = cfg.BOT_APP_LINK ? `${cfg.BOT_APP_LINK}?startapp=p_${encodeURIComponent(it.id)}` : shop.manager ? `https://t.me/${shop.manager}` : "";
        // без BOT_APP_LINK ведём к менеджеру — и так и подписываем, а не «Открыть в Telegram»
        const linkText = cfg.BOT_APP_LINK ? "Открыть в Telegram" : "Написать менеджеру";
        note.innerHTML = `${ICON.bell}<span>Откройте в Telegram, чтобы получать уведомления о снижении цены.${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">${linkText}</a>` : ""}</span>`;
        note.hidden = false;
        note.classList.remove("pop"); void note.offsetWidth; note.classList.add("pop");
      }
      hap.note("warning");
      return;
    }
    const commit = () => {
      on ? watches.add(it.id) : watches.delete(it.id);
      store.set("watches", [...watches]);
      if (btn) {
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on);
        $("span", btn).textContent = on ? "Слежу за ценой" : "Снижение цены";
      }
      hap.note("success");
      toast(on ? `Сообщим, когда станет дешевле ${money(it.price)}` : "Больше не следим за ценой");
      if (on) track.push("watch", { item_id: it.id });
      if (cfg.API_URL) {
        try { fetch(cfg.API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "watch", item_id: it.id, on, initData: tg.initData }) }).catch(() => {}); } catch {}
      }
    };
    if (on && tgAt("6.9") && tg.requestWriteAccess) {
      try { tg.requestWriteAccess((granted) => { if (granted) commit(); else toast("Разрешите боту писать вам, чтобы получать уведомления"); }); }
      catch { commit(); }
    } else commit();
  }

  // ---------- фильтры (шторка) ----------
  function filterSheetHTML(key) {
    const base = catItems();
    const label = key === "price" ? "Цена" : FILTERS.find(([k]) => k === key)[1];
    const count = applyFilters(base).length;
    let body;
    if (key === "price") {
      const [lo, hi] = facets(applyFilters(base, "price").length ? applyFilters(base, "price") : base).price;
      const step = Math.max(1, Math.round((hi - lo) / 100));
      const a = state.f.min ?? lo, b = state.f.max ?? hi;
      body = `<div class="range" data-lo="${lo}" data-hi="${hi}">
          <div class="range-vals"><span data-roll="r-lo" id="rLo">${money(a)}</span><span>—</span><span data-roll="r-hi" id="rHi">${money(b)}</span></div>
          <div class="range-track"><i id="rFill"></i>
            <input type="range" id="rMin" min="${lo}" max="${hi}" step="${step}" value="${a}" aria-label="Цена от">
            <input type="range" id="rMax" min="${lo}" max="${hi}" step="${step}" value="${b}" aria-label="Цена до"></div>
        </div>`;
    } else {
      const vals = facets(applyFilters(base, key))[key];
      body = `<div class="fopts" role="group" aria-labelledby="sheetTitle">${vals.map(([v, n]) => {
        const on = state.f[key].has(v);
        const sw = key === "color" ? window.ProductArt.swatch(v) : null;
        return `<button class="fopt press ${on ? "on" : ""}" data-fv="${esc(v)}" aria-pressed="${on}">${sw ? `<i style="background:linear-gradient(135deg, ${sw[0]}, ${sw[1]})"></i>` : ""}<span>${esc(v)}</span><small>${n}</small></button>`;
      }).join("")}</div>`;
    }
    return `
      <button class="x plain" data-act="close" aria-label="Закрыть">${ICON.x}</button>
      <div class="sheet-head"><h2 id="sheetTitle">${esc(label)}</h2><p>${esc(routeCat())}</p></div>
      <div class="fsheet">${body}</div>
      <div class="actions tg-hide">
        <button class="ghost" data-act="f-clear" data-key="${key}">Сбросить</button>
        <button class="buy" data-act="close" id="fShow">Показать ${goods(count)}</button>
      </div>
      <div class="sheet-end"></div>`;
  }
  let fRenderT;
  function filterChanged() {
    const count = applyFilters(catItems()).length;
    const b = $("#fShow");
    if (b) b.textContent = `Показать ${goods(count)}`;
    clearTimeout(fRenderT);
    fRenderT = setTimeout(() => render({ keepScroll: false }), 120);
    syncMain();
  }
  function bindRange() {
    const mn = $("#rMin"), mx = $("#rMax");
    if (!mn) return;
    const box = $(".range", sheet), lo = +box.dataset.lo, hi = +box.dataset.hi;
    // ползунок ходит шагами step от lo и может не доставать до hi (185 + 18·100 = 1985 < 1990):
    // крайнее правое положение = hi, иначе самые дорогие товары молча отсекаются
    const step = +mx.step || 1, top = lo + Math.floor((hi - lo) / step) * step;
    const snap = (v) => (v >= top ? hi : v);
    const paint = (init) => {
      let a = snap(Math.min(+mn.value, +mx.value)), b = snap(Math.max(+mn.value, +mx.value));
      // при открытии — ровно выбранные границы (как на чипе), а не значения, округлённые к сетке ползунка
      if (init) { a = M.clamp(state.f.min ?? lo, lo, hi); b = M.clamp(state.f.max ?? hi, a, hi); }
      const fill = $("#rFill");
      fill.style.left = `${((a - lo) / (hi - lo || 1)) * 100}%`;
      fill.style.right = `${100 - ((b - lo) / (hi - lo || 1)) * 100}%`;
      $("#rLo").textContent = money(a); $("#rHi").textContent = money(b);
      return [a, b];
    };
    paint(true);
    const on = () => {
      const [a, b] = paint();
      state.f.min = a > lo ? a : null;
      state.f.max = b < hi ? b : null;
      filterChanged();
    };
    mn.addEventListener("input", on);
    mx.addEventListener("input", on);
    [mn, mx].forEach((el) => el.addEventListener("change", () => hap.sel()));
  }
  function openFilter(key) {
    hap.sel();
    openSheet(filterSheetHTML(key), { type: "filter", key });
    bindRange();
  }

  // ---------- все категории ----------
  function allCatsHTML() {
    return `
      <button class="x plain" data-act="close" aria-label="Закрыть">${ICON.x}</button>
      <div class="sheet-head"><h2 id="sheetTitle">Все категории</h2><p>${goods(state.items.length)} в ${catGroup.size} ${plural(catGroup.size, "категории", "категориях", "категориях")}</p></div>
      <div class="cs-search"><label class="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="catQ" type="search" placeholder="Найти категорию" autocomplete="off" aria-label="Найти категорию"></label></div>
      <div class="cs-list" id="csList">${state.groups.map((g) => {
        const art = groupArt(g);
        return `<section class="cg">
          <button class="cg-head" data-group="${esc(g.name)}"><span class="tile cg-ico" style="${art.style}">${art.svg}</span><b>${esc(g.name)}</b><small>${g.count}</small>${ICON.chevron}</button>
          <div class="rows">${g.categories.map((c) => `<button class="row" data-cat="${esc(c.name)}" data-from="${esc(g.name)}"><span>${esc(c.name)}</span><small>${c.count}</small>${ICON.chevron}</button>`).join("")}</div>
        </section>`;
      }).join("")}<p class="cs-empty" hidden>Ничего не нашлось</p></div>
      <div class="sheet-end"></div>`;
  }
  function openAllCats() {
    hap.tap();
    openSheet(allCatsHTML(), { type: "cats" });
    const inp = $("#catQ");
    inp.addEventListener("input", () => {
      const q = norm(inp.value, true);
      let any = false;
      $$(".cg", sheet).forEach((sec) => {
        let n = 0;
        $$(".row", sec).forEach((r) => {
          const ok = !q.length || q.every((t) => norm(`${r.dataset.cat} ${r.dataset.from}`).some((h) => tokMatch(t, h)));
          r.hidden = !ok; if (ok) n++;
        });
        sec.hidden = !n; if (n) any = true;
      });
      $(".cs-empty", sheet).hidden = any;
    });
  }

  // ---------- оформление ----------
  function contactFields(saved, name) {
    return `
        <div class="group-label" id="gl-contacts">Контакты</div>
        <div class="fields" role="group" aria-labelledby="gl-contacts">
          <input name="customer" placeholder="Имя" aria-label="Имя" required autocomplete="name" value="${esc(name)}">
          <input name="phone" type="tel" placeholder="Телефон" aria-label="Телефон" required autocomplete="tel" inputmode="tel" value="${esc(saved.phone || "")}">
        </div>`;
  }
  const tgUserName = () => { const u = inTelegram ? (tg.initDataUnsafe && tg.initDataUnsafe.user) || {} : {}; return [u.first_name, u.last_name].filter(Boolean).join(" "); };

  function checkoutHTML() {
    const rows = cartRows().filter((r) => r.it);
    const total = cartTotal(), count = rows.reduce((s, r) => s + r.qty, 0), eq = rubEq(total);
    const saved = store.get("contact", {});
    const name = saved.customer || tgUserName();
    const deliv = saved.delivery === "Доставка" ? "Доставка" : "Самовывоз";
    return `
      <button class="x plain" data-act="close" aria-label="Закрыть">${ICON.x}</button>
      <div class="sheet-head"><h2 id="sheetTitle">Оформление</h2><p>${goods(count)} на ${money(total)}${eq ? ` · ${eq}` : ""}</p></div>
      <div class="co-lines">${rows.map((r) => `<div class="co-line">${tileHTML(r.it)}<div>${esc(P(r.it).title)} <span class="flags">${P(r.it).flags}</span></div><span>${r.qty > 1 ? `${r.qty} × ` : ""}${money(r.it.price)}</span></div>`).join("")}</div>
      <form class="form" id="orderForm" novalidate>
        ${contactFields(saved, name)}
        <div class="group-label" id="gl-deliv">Получение</div>
        <div class="seg" data-thumb="deliv" role="radiogroup" aria-labelledby="gl-deliv">
          <label><input type="radio" name="delivery" value="Самовывоз" ${deliv === "Самовывоз" ? "checked" : ""}><span>Самовывоз</span></label>
          <label><input type="radio" name="delivery" value="Доставка" ${deliv === "Доставка" ? "checked" : ""}><span>Доставка</span></label>
        </div>
        <div class="fields" id="addrBox" ${deliv === "Доставка" ? "" : "hidden"}>
          <textarea name="address" rows="2" placeholder="Адрес доставки" aria-label="Адрес доставки" autocomplete="street-address">${esc(saved.address || "")}</textarea>
        </div>
        <div class="group-label">Комментарий</div>
        <div class="fields"><textarea name="comment" rows="2" placeholder="Удобное время, вопросы…" aria-label="Комментарий"></textarea></div>
        <div class="err" id="formErr" role="alert" hidden></div>
        <p class="note">${DEMO_NOTE}Оплата при получении${eq ? ` — ${eq} ${rateCaption()}` : ""}. Менеджер свяжется для подтверждения${shop.phone ? ` · ${esc(shop.phone)}` : ""}.</p>
        <div class="actions tg-hide"><button class="buy" type="submit">Отправить заказ · ${money(total)}</button></div>
        <div class="sheet-end"></div>
      </form>`;
  }
  function openCheckout() {
    if (!cartRows().some((r) => r.it)) return toast("Корзина пуста");
    hap.tap();
    openSheet(checkoutHTML(), { type: "checkout" });
    const f = $("#orderForm");
    if (!f.customer.value && !desktop.matches) setTimeout(() => f.customer.focus(), 450);
  }

  function requestHTML(q) {
    const saved = store.get("contact", {});
    return `
      <button class="x plain" data-act="close" aria-label="Закрыть">${ICON.x}</button>
      <div class="sheet-head"><h2 id="sheetTitle">Привезём под заказ</h2><p>Найдём товар у поставщиков и сообщим цену и срок.</p></div>
      <form class="form" id="reqForm" novalidate>
        <div class="group-label" id="gl-req">Что ищете</div>
        <div class="fields" role="group" aria-labelledby="gl-req"><textarea name="request" rows="2" required aria-label="Что ищете" placeholder="Модель, память, цвет…">${esc(q)}</textarea></div>
        ${contactFields(saved, saved.customer || tgUserName())}
        <div class="group-label">Комментарий</div>
        <div class="fields"><textarea name="comment" rows="2" placeholder="Бюджет, сроки, вопросы…" aria-label="Комментарий"></textarea></div>
        <div class="err" id="formErr" role="alert" hidden></div>
        <p class="note">${DEMO_NOTE}Это не заказ: менеджер свяжется, чтобы уточнить детали${shop.phone ? ` · ${esc(shop.phone)}` : ""}.</p>
        <div class="actions tg-hide"><button class="buy" type="submit">Отправить заявку</button></div>
        <div class="sheet-end"></div>
      </form>`;
  }
  function openRequest() {
    hap.tap();
    openSheet(requestHTML(state.q.trim()), { type: "request" });
  }

  let submitting = false;
  function formError(form, field, msg) {
    $$(".invalid", form).forEach((el) => { el.classList.remove("invalid"); el.removeAttribute("aria-invalid"); });
    const err = $("#formErr");
    if (!msg) { err.hidden = true; return; }
    const el = form[field];
    el.classList.add("invalid");
    el.setAttribute("aria-invalid", "true");
    err.textContent = msg;
    err.hidden = false;
    el.focus();
    hap.note("error");
  }
  let mainBusy = false; // на MainButton крутится индикатор: setParams его не снимает, нужен hideProgress (см. syncMain)
  function setBusy(form, busy, label) {
    const btn = $("button[type=submit]", form);
    if (btn) { btn.disabled = busy; btn.textContent = busy ? "Отправляем…" : label; }
    mainBusy = busy && inTelegram;
    if (inTelegram) try { busy ? (tg.MainButton.showProgress(false), tg.MainButton.disable()) : (tg.MainButton.hideProgress(), tg.MainButton.enable()); } catch {}
  }
  async function post(payload) {
    if (!cfg.API_URL) { await new Promise((r) => setTimeout(r, 500)); return { ok: true, order_id: String(Date.now()).slice(-5) }; } // демо-режим
    const res = await fetch(cfg.API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Ошибка");
    return data;
  }
  // ошибка отправки (антиспам, нет связи…) — текстом в форме, а не только всплывашкой на 2 с; форма остаётся заполненной
  function sendFailed(form, e) {
    formError(form);
    const err = $("#formErr", form);
    const text = e instanceof TypeError || e instanceof SyntaxError || !e.message ? "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз." : e.message;
    if (err) { err.textContent = `Не удалось отправить: ${text}`; err.hidden = false; err.scrollIntoView({ block: "nearest" }); }
    hap.note("error");
    toast("Не удалось отправить");
  }
  const validContacts = (form, fd) => {
    if (!fd.customer) { formError(form, "customer", "Укажите имя"); return false; }
    if ((fd.phone.match(/\d/g) || []).length < 10) { formError(form, "phone", "Укажите телефон — минимум 10 цифр"); return false; }
    return true;
  };

  function doneHTML(title, text, specs) {
    return `
      <div class="done">
        <div class="done-mark"><i class="glow" aria-hidden="true"></i><i class="ring" aria-hidden="true"></i>
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="44"/><path d="M31 51l13 13 26-28"/></svg></div>
        <h2 id="sheetTitle">${title}</h2>
        <p>${text}</p>
      </div>
      <div class="ticket specs">${specs.map(([k, v]) => `<div class="spec"><span>${k}</span><b>${v}</b></div>`).join("")}</div>
      <div class="done-actions">
        <button class="ghost" data-act="home">На главную</button>
        <button class="buy" data-act="orders">Мои заказы</button>
      </div>`;
  }

  async function submitOrder(form) {
    if (submitting) return;
    const rows = cartRows().filter((r) => r.it);
    if (!rows.length) return toast("Корзина пуста");
    const fd = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
    if (!validContacts(form, fd)) return;
    if (fd.delivery === "Доставка" && fd.address.length < 5) return formError(form, "address", "Укажите адрес доставки");
    formError(form);
    submitting = true;
    const total = cartTotal();
    const label = `Отправить заказ · ${money(total)}`;
    setBusy(form, true, label);
    const items = rows.map((r) => ({ item_id: r.it.id, qty: r.qty }));
    const lines = rows.map((r) => `${P(r.it).title}${P(r.it).flags ? " " + P(r.it).flags : ""} × ${r.qty}`);
    const delivery = fd.delivery === "Доставка" ? "Доставка" : "Самовывоз";
    const address = delivery === "Доставка" ? fd.address : "";
    const comment = fd.comment || "";
    const payload = { action: "order", item_id: items[0].item_id, item: lines.join("; "), price: total, items,
      customer: fd.customer, phone: fd.phone, delivery, address, comment, initData: inTelegram ? tg.initData : "" };
    let orderId;
    try { orderId = (await post(payload)).order_id; }
    catch (e) {
      submitting = false;
      setBusy(form, false, label);
      return sendFailed(form, e);
    }
    submitting = false;
    const date = new Date().toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    const order = { id: orderId, date, total, currency: shop.currency, delivery, address, items: rows.map((r) => ({ id: r.it.id, title: P(r.it).title, qty: r.qty, price: r.it.price })) };
    store.set("orders", [order, ...store.get("orders", [])].slice(0, 50));
    store.set("contact", { customer: fd.customer, phone: fd.phone, delivery, address: fd.address });
    rows.forEach((r) => track.push("order", { item_id: r.it.id, n: r.qty }));
    track.flush();
    cart = [];
    saveCart();
    render();
    hap.note("success");
    const eq = rubEq(total);
    openSheet(doneHTML("Заказ отправлен", cfg.DEMO ? DEMO_DONE : "Менеджер свяжется с вами в течение 15 минут.", [
      ["Номер заказа", `#${esc(orderId)}`],
      ["Товары", order.items.map((x) => `${esc(x.title)}${x.qty > 1 ? ` × ${x.qty}` : ""}`).join("<br>")],
      ["Получение", `${esc(delivery)}${address ? `<br>${esc(address)}` : ""}`],
      ["Сумма", `${money(total)}${eq ? `<br><small class="eq">${eq}</small>` : ""}`],
    ]), { type: "done" });
  }

  async function submitRequest(form) {
    if (submitting) return;
    const fd = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
    if (fd.request.length < 2) return formError(form, "request", "Напишите, что нужно привезти");
    if (!validContacts(form, fd)) return;
    formError(form);
    submitting = true;
    setBusy(form, true, "Отправить заявку");
    const payload = { action: "order", request: fd.request, customer: fd.customer, phone: fd.phone, comment: fd.comment || "", initData: inTelegram ? tg.initData : "" };
    let id;
    try { id = (await post(payload)).order_id; }
    catch (e) {
      submitting = false;
      setBusy(form, false, "Отправить заявку");
      return sendFailed(form, e);
    }
    submitting = false;
    const saved = store.get("contact", {});
    store.set("contact", { ...saved, customer: fd.customer, phone: fd.phone });
    const date = new Date().toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    store.set("orders", [{ id, date, request: fd.request, comment: fd.comment }, ...store.get("orders", [])].slice(0, 50));
    hap.note("success");
    openSheet(doneHTML("Заявка отправлена", cfg.DEMO ? DEMO_DONE : "Менеджер найдёт товар и свяжется с вами.", [
      ["Номер заявки", `#${esc(id)}`], ["Что привезти", esc(fd.request)],
    ]), { type: "done" });
  }

  function shareLink(it) {
    if (cfg.BOT_APP_LINK) return `${cfg.BOT_APP_LINK}?startapp=p_${it.id}`;
    const u = new URL(location.href);
    u.search = `?p=${it.id}`;
    u.hash = "";
    return u.toString();
  }

  // ---------- Telegram MainButton ----------
  let mainFn = null;
  function syncMain() {
    if (!inTelegram || !tg.MainButton) return;
    let m = null;
    const ctx = sheetCtx;
    if (ctx && ctx.type === "product") {
      const it = find(ctx.id), l = it && cartLine(it.id);
      if (it) m = l ? { text: `В корзине (${l.qty}) · Оформить`, fn: goCart } : { text: `${inStock(it) ? "В корзину" : "Предзаказать"} · ${money(it.price)}`, fn: () => addToCart(it.id) };
    } else if (ctx && ctx.type === "checkout") {
      // заказ принят и корзина уже пуста — шторку сейчас сменит «Готово»; не показываем «Отправить заказ · $0»
      if (!cartRows().some((r) => r.it)) return;
      m = { text: `Отправить заказ · ${money(cartTotal())}`, fn: () => { const f = $("#orderForm"); if (f) submitOrder(f); } };
    } else if (ctx && ctx.type === "request") {
      m = { text: "Отправить заявку", fn: () => { const f = $("#reqForm"); if (f) submitRequest(f); } };
    } else if (ctx && ctx.type === "filter") {
      m = { text: `Показать ${goods(applyFilters(catItems()).length)}`, fn: closeSheet };
    } else if (ctx && ctx.type === "done") {
      m = { text: "Готово", fn: closeSheet };
    } else if (!ctx && state.tab === "cart" && cartRows().some((r) => r.it)) {
      m = { text: `Оформить заказ · ${money(cartTotal())}`, fn: openCheckout };
    }
    mainFn = m && m.fn;
    try {
      // после успешной отправки: иначе индикатор остаётся и на «Готово», и на всех следующих кнопках
      if (mainBusy && !submitting) { mainBusy = false; tg.MainButton.hideProgress(); }
      if (m) tg.MainButton.setParams({ text: m.text, is_visible: true, is_active: true, color: "#0071e3", text_color: "#ffffff" });
      else tg.MainButton.hide();
    } catch {}
  }

  // ---------- навигация ----------
  function markTabs() {
    $$("#tabbar button").forEach((b) => {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle("active", on);
      on ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current");
    });
    M.glide($("#tabbar"));
  }
  function setTab(tab) {
    if (tab === state.tab && tab === "catalog" && !isSearching() && state.route.name !== "home") return go({ name: "home" });
    if (tab === state.tab) return window.scrollTo({ top: 0, behavior: M.reduced() ? "auto" : "smooth" });
    if (isSearching()) exitSearch();
    state.tab = tab;
    markTabs();
    render({ anim: true, keepScroll: false });
    window.scrollTo(0, 0);
  }
  function goCart() { closeSheet(); setTab("cart"); }
  function go(route) {
    if (isSearching()) exitSearch();
    if (route.name === "cat" && routeCat() !== route.cat) { resetFilters(); state.sort = "pop"; }
    state.route = route;
    state.tab = "catalog";
    markTabs();
    renderCats();
    render({ anim: true, keepScroll: false });
    window.scrollTo(0, 0);
    const active = $("#cats .active");
    if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: M.reduced() ? "auto" : "smooth" });
  }
  const openCat = (cat, from) => go({ name: "cat", cat, from: from || groupOf(cat) || "" });

  // ---------- поиск: события ----------
  const qInput = $("#q");
  let searchT, trackedQ = "";
  function saveRecent(q) {
    q = String(q).trim();
    if (q.length < 2) return;
    const r = store.get("recent", []).filter((x) => x.toLowerCase() !== q.toLowerCase());
    store.set("recent", [q, ...r].slice(0, 6));
  }
  function trackSearch() {
    clearTimeout(searchT);
    const q = state.q.trim();
    if (q.length < 2 || q === trackedQ) return;
    trackedQ = q;
    track.push("search", { q, n: searchResults().length });
  }
  function setQuery(q) {
    state.q = q;
    qInput.value = q;
    $("#qClear").hidden = !q;
    if (state.sort === "pop") state.sort = "default";
    render({ keepScroll: false });
    window.scrollTo(0, 0);
    clearTimeout(searchT);
    searchT = setTimeout(trackSearch, 1500);
  }
  function exitSearch() {
    trackSearch();
    state.searchMode = false;
    state.q = "";
    qInput.value = "";
    $("#qClear").hidden = true;
    if (state.sort === "default") state.sort = "pop";
    qInput.blur();
  }
  function cancelSearch() {
    exitSearch();
    render({ anim: true, keepScroll: false });
    window.scrollTo(0, 0);
  }
  qInput.addEventListener("focus", () => {
    if (state.searchMode) return;
    state.searchMode = true;
    if (state.sort === "pop") state.sort = "default";
    if (state.tab !== "catalog") { state.tab = "catalog"; markTabs(); }
    render({ keepScroll: false });
    window.scrollTo(0, 0);
  });
  qInput.addEventListener("input", () => setQuery(qInput.value));
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveRecent(state.q); trackSearch(); qInput.blur(); }
    if (e.key === "Escape") { e.preventDefault(); cancelSearch(); }
  });
  $("#qClear").addEventListener("click", () => { setQuery(""); qInput.focus(); });
  $("#qCancel").addEventListener("click", cancelSearch);

  // ---------- события ----------
  $("#cats").addEventListener("click", (e) => {
    const c = e.target.closest(".cat");
    if (!c) return;
    if (c.dataset.act === "all-cats") return openAllCats();
    const g = c.dataset.group;
    if (g === activeGroup() && state.route.name !== "cat") return;
    hap.sel();
    go(g === "Все" ? { name: "home" } : { name: "group", group: g });
  });
  $("#tabbar").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { hap.sel(); setTab(b.dataset.tab); } });
  $("#navBack").addEventListener("click", backAction);
  $("#navRight").addEventListener("click", (e) => { if (e.target.closest('[data-act="clear-cart"]')) clearCart(); });
  scrim.addEventListener("click", () => closeSheet());
  window.addEventListener("scroll", onScroll, { passive: true });
  let resizeT;
  window.addEventListener("resize", () => {
    onScroll();
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { M.thumbs($("#cats")); M.thumbs($("#view")); M.glide($("#tabbar")); if (sheetCtx) M.thumbs(sheet); }, 150);
  });

  function clearCart() {
    confirmAsk("Очистить корзину?", () => { cart = []; saveCart(); hap.note("warning"); render(); });
  }
  function toggleFav(it, btn) {
    const on = !favs.has(it.id);
    if (on) { favs.add(it.id); toast("Добавлено в избранное"); track.push("fav", { item_id: it.id }); }
    else { favs.delete(it.id); toast("Убрано из избранного"); }
    saveFavs();
    hap.tap("medium");
    if (btn) {
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on);
      $("span", btn).textContent = on ? "В избранном" : "В избранное";
    }
    render();
  }
  function share(it) {
    track.push("share", { item_id: it.id });
    const url = shareLink(it), text = `${P(it).title} — ${money(it.price)}`;
    if (inTelegram) openLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
    else if (navigator.share) navigator.share({ title: text, url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(`${text}\n${url}`).then(() => toast("Ссылка скопирована"), () => toast(url));
    else toast(url);
  }

  $("#view").addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) {
      hap.tap();
      if (isSearching() && state.q.trim()) track.push("click_search", { q: state.q.trim(), item_id: card.dataset.id });
      return showProduct(card.dataset.id, { from: $(".tile", card) });
    }
    const t = e.target.closest("[data-q], [data-cat], [data-group], [data-sort], [data-stock], [data-filter], [data-act]");
    if (!t) return;
    if (t.dataset.q !== undefined) { hap.sel(); saveRecent(t.dataset.q); qInput.blur(); if (!state.searchMode) state.searchMode = true; return setQuery(t.dataset.q); }
    if (t.dataset.cat !== undefined) { hap.sel(); return openCat(t.dataset.cat, state.route.name === "group" ? state.route.group : ""); }
    if (t.dataset.group !== undefined) { hap.sel(); return go({ name: "group", group: t.dataset.group }); }
    if (t.dataset.sort) { hap.sel(); state.sort = t.dataset.sort; return render(); }
    if (t.dataset.stock !== undefined) { hap.sel(); state.stockOnly = !state.stockOnly; return render(); }
    if (t.dataset.filter) return openFilter(t.dataset.filter);
    const id = t.dataset.id;
    switch (t.dataset.act) {
      case "retry": renderSkeleton(); refresh(); break;
      case "chat": contactManager(); break;
      case "go-catalog": setTab("catalog"); break;
      case "all-cats": openAllCats(); break;
      case "clear-recent": store.set("recent", []); render(); break;
      case "clear-seen": store.set("seen", []); render(); break;
      case "more-grid": morePage(); break;
      case "f-reset": hap.sel(); resetFilters(); state.stockOnly = false; render(); break;
      case "request": openRequest(); break;
      case "open": showProduct(id, { from: $(".tile", t) }); break;
      case "inc": { const l = cartLine(id); if (l) setQty(id, l.qty + 1); break; }
      case "dec": { const l = cartLine(id); if (l) { const last = l.qty <= 1; setQty(id, l.qty - 1); if (last) toast("Удалено из корзины"); } break; }
      case "remove": setQty(id, 0); break;
      case "checkout": openCheckout(); break;
      case "repeat": {
        const o = store.get("orders", [])[+t.dataset.i];
        const items = o ? (o.items || [{ id: o.item_id, qty: 1 }]) : [];
        let added = 0;
        items.forEach((x) => {
          const it = find(x.id);
          if (!it) return;
          const l = cartLine(it.id);
          if (l) l.qty = Math.min(maxQty(it), l.qty + (x.qty || 1)); else cart.push({ id: it.id, qty: Math.min(maxQty(it), x.qty || 1), title: P(it).title, price: it.price });
          added++;
        });
        if (!added) return toast("Этих товаров больше нет в продаже");
        saveCart();
        hap.tap("medium");
        setTab("cart");
        break;
      }
    }
  });

  $("#sheet").addEventListener("submit", (e) => { e.preventDefault(); e.target.id === "reqForm" ? submitRequest(e.target) : submitOrder(e.target); });
  $("#sheet").addEventListener("change", (e) => {
    if (e.target.name === "delivery") {
      hap.sel();
      M.glide(e.target.closest(".seg"));
      const box = $("#addrBox");
      box.hidden = e.target.value !== "Доставка";
      if (!box.hidden) { box.classList.remove("appear"); void box.offsetWidth; box.classList.add("appear"); setTimeout(() => box.querySelector("textarea").focus(), 50); }
    }
  });
  $("#sheet").addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) { hap.tap(); return showProduct(card.dataset.id); }
    const fopt = e.target.closest("[data-fv]");
    if (fopt && sheetCtx && sheetCtx.type === "filter") {
      const set = state.f[sheetCtx.key], v = fopt.dataset.fv;
      set.has(v) ? set.delete(v) : set.add(v);
      const on = set.has(v);
      fopt.classList.toggle("on", on);
      fopt.setAttribute("aria-pressed", on);
      hap.sel();
      return filterChanged();
    }
    const nav = e.target.closest("[data-cat], [data-group]");
    if (nav && sheetCtx && sheetCtx.type === "cats") {
      hap.sel();
      closeSheet();
      return nav.dataset.cat ? openCat(nav.dataset.cat, nav.dataset.from) : go({ name: "group", group: nav.dataset.group });
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const it = find(b.dataset.id || (sheetCtx && sheetCtx.id));
    switch (b.dataset.act) {
      case "close": closeSheet(); break;
      case "home": closeSheet(); setTab("catalog"); if (state.route.name !== "home") go({ name: "home" }); break;
      case "orders": closeSheet(); setTab("orders"); break;
      case "more": $("#desc").classList.remove("clamp"); b.remove(); break;
      case "add": addToCart(it.id); break;
      case "gocart": goCart(); break;
      case "variant": if (it && it.id !== sheetCtx.id) { hap.sel(); showProduct(it.id, { keepScroll: true, variant: true }); } break;
      case "slide": { const tr = $("#gTrack"); if (tr) tr.scrollTo({ left: tr.clientWidth * +b.dataset.i, behavior: "smooth" }); break; }
      case "contact": contactManager(it); break;
      case "fav": toggleFav(it, b); break;
      case "watch": toggleWatch(it, b); break;
      case "share": share(it); break;
      case "f-clear": {
        const k = b.dataset.key;
        if (k === "price") { state.f.min = state.f.max = null; } else state.f[k].clear();
        hap.sel();
        openSheet(filterSheetHTML(k), { type: "filter", key: k }, { keepScroll: true });
        bindRange();
        filterChanged();
        break;
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetCtx) { e.preventDefault(); closeSheet(); return; }
    if (e.key === "Tab" && sheetCtx) {
      const f = $$('button:not([disabled]), [href], input:not([type=hidden]), textarea, [tabindex]:not([tabindex="-1"])', sheet).filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------- тема, Telegram, старт ----------
  function applyTheme() {
    const dark = inTelegram ? tg.colorScheme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const bg = dark ? "#000000" : "#f5f5f7";
    $('meta[name="theme-color"]').content = bg;
    if (inTelegram) {
      // шапка, фон и нижняя панель Telegram — цвета витрины: в полноэкранном режиме нет «рамок» другого цвета
      try { if (tgAt("6.1")) { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } } catch {}
      try { if (tgAt("7.10") && tg.setBottomBarColor) tg.setBottomBarColor(bg); } catch {}
    }
  }
  // отступы: SDK (Bot API 8.0+) сам пишет --tg-safe-area-inset-* и --tg-content-safe-area-inset-* в :root,
  // CSS складывает их (styles.css, --safe-top/--safe-bottom); здесь — те же суммы для старых версий SDK + класс полноэкранного режима
  function applyInsets() {
    if (!inTelegram) return;
    const s = tg.safeAreaInset || {}, c = tg.contentSafeAreaInset || {};
    document.documentElement.style.setProperty("--tg-top", `${(s.top || 0) + (c.top || 0)}px`);
    document.documentElement.style.setProperty("--tg-bottom", `${(s.bottom || 0) + (c.bottom || 0)}px`);
    document.body.classList.toggle("tg-fullscreen", !!tg.isFullscreen);
    onScroll();
  }
  function lockSwipes() { if (tgAt("7.7")) try { tg.disableVerticalSwipes(); } catch {} }
  // полноэкранный режим без рамок — только на телефонах (на ПК и в веб-версии окно и так своё)
  const tgMobile = inTelegram && /^(ios|android)$/i.test(String(tg.platform || ""));
  function goFullscreen() {
    if (!tgMobile || !tgAt("8.0") || typeof tg.requestFullscreen !== "function" || tg.isFullscreen) return;
    try { tg.requestFullscreen(); } catch {}
  }
  function lockPortrait() {
    if (!tgMobile || !tgAt("8.0") || typeof tg.lockOrientation !== "function") return;
    if (innerWidth > innerHeight) return; // lockOrientation фиксирует текущую ориентацию — «боком» не фиксируем
    try { tg.lockOrientation(); } catch {}
  }
  let insetT;
  function onViewport() {
    applyInsets();
    clearTimeout(insetT);
    insetT = setTimeout(() => { M.glide($("#tabbar")); M.thumbs($("#cats")); }, 150);
  }

  applyTheme();
  if (inTelegram) {
    document.body.classList.add("tg");
    try { tg.ready(); } catch {}
    try { tg.expand(); } catch {}
    goFullscreen();
    lockSwipes();
    lockPortrait();
    try { tg.BackButton.onClick(backAction); } catch {}
    try { tg.MainButton.onClick(() => mainFn && mainFn()); } catch {}
    tg.onEvent("themeChanged", applyTheme);
    tg.onEvent("safeAreaChanged", applyInsets);
    tg.onEvent("contentSafeAreaChanged", applyInsets);
    tg.onEvent("fullscreenChanged", onViewport);
    tg.onEvent("fullscreenFailed", (e) => { if (debug) console.debug("[tg] fullscreenFailed", e && e.error); });
    tg.onEvent("viewportChanged", (e) => { if (!e || e.isStateStable !== false) onViewport(); });
    applyInsets();
  } else {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }
  renderBadges();
  M.glide($("#tabbar"));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { M.glide($("#tabbar")); M.thumbs($("#cats")); });

  // мгновенный показ из кэша, затем обновление из сети
  const cached = store.get(CACHE_KEY, null);
  if (cached && cached.data) { try { ingest(cached.data); afterLoad(true); } catch { state.loaded = false; } }
  if (!state.loaded) renderSkeleton();
  refresh();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastFetch > 5 * 60 * 1000) refresh(); });
  window.addEventListener("online", () => { if (state.offline || !state.loaded) refresh(); });

  // для отладки из консоли: StoreApp.refresh(), StoreApp.parse("17 Pro Max 256 Orange esim+esim", "iPhone")
  window.StoreApp = { refresh, parse: (name, category) => parse({ name, category }), track };
})();
