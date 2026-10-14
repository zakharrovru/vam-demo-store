// Иллюстрации товаров без фото: цвет плитки = цвет товара, силуэт — по типу устройства.
window.ProductArt = (() => {
  const PALETTES = [
    // [ключевые слова, фон плитки, корпус, тон]
    [["cosmic orange", "orange", "оранж", "citrus", "copper", "медн"], ["#ffc08f", "#f0631a"], ["#ff9a52", "#c8501a"], "light"],
    [["deep blue", "midnight", "navy", "indigo", "темно-син", "prussian", "onyx"], ["#4b6a9d", "#121d35"], ["#34507f", "#18253f"], "light"],
    [["sky blue", "mist blue", "ice blue", "icyblue", "icy blue", "cloud blue", "голуб", "light blue"], ["#e3f2ff", "#94c6f2"], ["#c9e3fb", "#7fb3e3"], "dark"],
    [["lavender", "лаванд", "purple", "lilac", "violet", "фиолет"], ["#efe6ff", "#b39fe5"], ["#dccdf7", "#a28bd6"], "dark"],
    [["rose gold", "pink", "розов", "blush", "berry", "rose"], ["#ffe1eb", "#f08db0"], ["#ffc6d8", "#e17aa0"], "dark"],
    [["camouflage", "камуфл"], ["#cfd3d8", "#737b84"], ["#a9aeb5", "#666d75"], "light"],
    [["desert", "natural", "titanium", "титан", "light gold", "gold", "золот", "starlight", "starlite", "cream", "беж"], ["#f6efe4", "#cdb89a"], ["#efe3cf", "#b39a76"], "dark"],
    [["silver", "серебр", "white", "бел", "cloud white", "golden white"], ["#fbfbfd", "#d3d6dd"], ["#f4f5f7", "#bfc3cb"], "dark"],
    [["space black", "jet black", "black", "черн", "чёрн", "graphite", "obsidian", "space gray", "space grey", "gray", "grey", "сер"], ["#56565c", "#1a1a1c"], ["#3d3d40", "#141416"], "light"],
    [["teal", "ultramarine", "mint", "бирюз"], ["#c9f1ec", "#3fb3a8"], ["#a8e4dc", "#2f9488"], "dark"],
    [["blue", "син", "pacific"], ["#a9c9ea", "#4c79aa"], ["#86aad2", "#3d6898"], "light"],
    [["sage", "green", "зелен", "olive", "emerald", "хаки"], ["#cfe3c9", "#6f9468"], ["#b6d1ae", "#5f8358"], "light"],
    [["red", "красн", "product"], ["#ffb3b0", "#d7262f"], ["#f2615f", "#b51d27"], "light"],
    [["yellow", "желт"], ["#fff3b8", "#f2c94c"], ["#ffe680", "#d9ad2b"], "dark"],
    [["brown", "коричн"], ["#d9c2ad", "#7a5638"], ["#b38b69", "#6a482d"], "light"],
  ];
  const FALLBACK = [[], ["#ffffff", "#e8e8ed"], ["#f2f2f5", "#c9cad0"], "dark"];
  // нейтральный тон по типу, когда цвет в названии не найден
  const KIND_TINT = {
    scooter: [["#e9ecef", "#9aa3ad"], ["#4a4f55", "#202326"], "dark"],
    fridge: [["#eef2f5", "#b8c3cc"], ["#f7f9fa", "#aab5be"], "dark"],
    heater: [["#f3efe9", "#c9bba8"], ["#e04a2f", "#9e2c19"], "dark"],
    motor: [["#e7edf3", "#9fb1c2"], ["#3d4652", "#1d232b"], "dark"],
    sup: [["#e0f4f7", "#7fc8d6"], ["#2f9db5", "#1c6c80"], "dark"],
    radio: [["#eceeea", "#a8ae9f"], ["#3a3d38", "#1b1d1a"], "dark"],
    coffee: [["#f4ece4", "#c7ab90"], ["#3b3735", "#191716"], "dark"],
    camera: [["#eceef2", "#aab0bb"], ["#3a3c41", "#18191c"], "dark"],
    tv: [["#e8eaf3", "#a2a9c4"], ["#2a2c33", "#101114"], "dark"],
    console: [["#eef0f6", "#b4bacb"], ["#ffffff", "#d7dbe3"], "dark"],
    glasses: [["#eceae6", "#b3aca1"], ["#2b2b2d", "#111112"], "dark"],
    dashcam: [["#eceef2", "#aab0bb"], ["#3a3c41", "#18191c"], "dark"],
  };

  const KINDS = [ // [вид, ключи в названии] — порядок важен
    ["airtag", ["airtag", "smarttag", "трекер"]],
    ["styler", ["airstrait", "airwrap", "стайлер", "выпрямит", "straightener", "corrale"]],
    ["hairdryer", ["supersonic", "hair dryer", "фен "]],
    ["headphones", ["marshall", "major", "airpods max", "наушники wh", "wh-1000"]],
    ["earbuds", ["airpods", "buds", "earpods"]],
    ["gamepad", ["геймпад", "dualsense", "gamepad", "джойстик"]],
    ["console", ["playstation", "ps5 slim", "ps5 pro", "xbox", "nintendo"]],
    ["speaker", ["станция", "колонка", "homepod", "jbl", "колонк"]],
    ["charger", ["блок", "зарядк", "20w", "adapter", "кабель", "power bank", "павербанк"]],
    ["glasses", ["ray-ban", "очки", "oakley"]],
    ["camera", ["gopro", "insta 360", "insta360", "камера", "dji osmo"]],
    ["dashcam", ["видеорегистр", "радар"]],
    ["radio", ["рация", "baofeng", "quansheng", "motorola"]],
    ["tv", ["телевизор", " tv"]],
    ["coffee", ["кофе", "delonghi", "espresso"]],
    ["fridge", ["холодильн", "alpicool"]],
    ["heater", ["отопител", "генератор", "станция питания"]],
    ["scooter", ["kugoo", "самокат", "ninebot", "велосипед", "электровел"]],
    ["sup", ["sup", "сап "]],
    ["motor", ["мотор"]],
    ["imac", ["imac", "монитор", "studio display"]],
    ["laptop", ["macbook", "ноутбук", "matebook", "laptop"]],
    ["tablet", ["ipad", "pad ", "tab ", "xpad", "планшет", "matepad"]],
    ["watch", ["watch", "garmin", "approach", "fenix", "forerunner", "fit3", "fitbit", "часы", "venu", "instinct", "epix", "vivo"]],
    ["phone", ["iphone", "pro max", "galaxy", "redmi", "honor", "pixel", "poco", "xiaomi", "17", "16", "15", "14", "13"]],
  ];
  const CAT_KIND = {
    "iPhone": "phone", "iPhone б/у": "phone", "Samsung": "phone", "Xiaomi": "phone", "Honor и Huawei": "phone", "Смартфоны": "phone",
    "MacBook": "laptop", "Ноутбуки": "laptop", "iMac": "imac", "iPad и планшеты": "tablet",
    "Apple Watch": "watch", "Galaxy Watch": "watch", "Смарт-часы": "watch", "Garmin": "watch",
    "Умные очки": "glasses", "Колонки": "speaker", "Кофе": "coffee", "Телевизоры": "tv", "Камеры": "camera", "Рации": "radio",
    "Электротранспорт": "scooter", "Автохолодильники": "fridge", "Отопители и генераторы": "heater", "SUP-доски": "sup", "Лодочные моторы": "motor", "Автотехника": "dashcam",
  };
  const MIXED = new Set(["Наушники", "Аксессуары", "Игры", "Dyson", "Samsung"]); // тип по названию важнее категории

  function palette(name) {
    const n = ` ${String(name || "").toLowerCase()} `;
    return PALETTES.find(([keys]) => keys.some((k) => n.includes(k))) || null;
  }
  function kind(item) {
    const n = ` ${String(item.name || "").toLowerCase()} `;
    const cat = String(item.category || "");
    if (CAT_KIND[cat] && !MIXED.has(cat)) {
      const k = CAT_KIND[cat];
      if (k === "phone" && /\b(tab|pad)\b/.test(n)) return "tablet";
      if (k === "phone" && /\bwatch|buds\b/.test(n)) return /buds/.test(n) ? "earbuds" : "watch";
      return k;
    }
    const hit = KINDS.find(([, keys]) => keys.some((k) => n.includes(k)));
    if (hit) return hit[0];
    if (cat === "Dyson") return "hairdryer";
    if (cat === "Samsung") return "phone";
    return CAT_KIND[cat] || "box";
  }
  function brand(item) {
    const n = `${item.name} ${item.category}`.toLowerCase();
    if (/samsung|galaxy|^s2\d|^a\d|^z (fold|flip)/i.test(n) || item.category === "Samsung") return "samsung";
    if (/xiaomi|redmi|poco|honor|huawei|pixel/.test(n)) return "android";
    return "apple";
  }

  let uid = 0;
  function svg(item) {
    const k = kind(item);
    const pal = palette(item.name) || (KIND_TINT[k] ? [[], KIND_TINT[k][0], KIND_TINT[k][1], KIND_TINT[k][2]] : FALLBACK);
    const [, , body, tone] = pal;
    const id = `g${++uid}`;
    const [b1, b2] = body;
    const line = tone === "light" ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.08)";
    const ink = "#1b1b1d";
    const lens = `<circle r="9.5" fill="${ink}"/><circle r="6" fill="#2c3440"/><circle r="2.2" cx="-2" cy="-2" fill="#6d7f99" opacity=".8"/>`;
    const lensS = `<circle r="7" fill="${ink}"/><circle r="4.4" fill="#2c3440"/><circle r="1.6" cx="-1.4" cy="-1.4" fill="#6d7f99" opacity=".8"/>`;
    const screen = `<linearGradient id="${id}w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${b1}"/><stop offset=".55" stop-color="${b2}"/><stop offset="1" stop-color="#0d0d10"/></linearGradient>`;
    const defs = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${b1}"/><stop offset="1" stop-color="${b2}"/></linearGradient>${screen}
      <radialGradient id="${id}s"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>`;
    const F = `url(#${id})`, W = `url(#${id}w)`;
    const shadow = `<ellipse cx="100" cy="186" rx="58" ry="7" fill="url(#${id}s)"/>`;
    const name = String(item.name || "");
    const isPro = /pro|ultra/i.test(name);
    const br = brand(item);
    let shape;
    switch (k) {
      case "phone":
        if (br === "samsung") {
          const fold = /fold/i.test(name);
          shape = `<g transform="rotate(-9 100 100)">
            <rect x="${fold ? 48 : 58}" y="16" width="${fold ? 104 : 84}" height="166" rx="${isPro ? 10 : 16}" fill="${F}"/>
            <rect x="${fold ? 48.5 : 58.5}" y="16.5" width="${fold ? 103 : 83}" height="165" rx="${isPro ? 9.5 : 15.5}" fill="none" stroke="${line}"/>
            ${fold ? `<path d="M100 16v166" stroke="${line}" stroke-width="1.5"/>` : ""}
            <g transform="translate(${fold ? 116 : 76} 34)">${lensS}</g><g transform="translate(${fold ? 116 : 76} 52)">${lensS}</g><g transform="translate(${fold ? 116 : 76} 70)">${lensS}</g>
            ${isPro ? `<g transform="translate(${fold ? 132 : 92} 40)">${lensS}</g>` : ""}
            <circle cx="${fold ? 132 : 92}" cy="${isPro ? 62 : 36}" r="2.4" fill="#f4efe1" opacity=".9"/></g>`;
        } else if (br === "android") {
          shape = `<g transform="rotate(-9 100 100)">
            <rect x="58" y="16" width="84" height="166" rx="18" fill="${F}"/>
            <rect x="58.5" y="16.5" width="83" height="165" rx="17.5" fill="none" stroke="${line}"/>
            <circle cx="88" cy="50" r="22" fill="${b2}" opacity=".6"/><circle cx="88" cy="50" r="21.5" fill="none" stroke="${line}"/>
            <g transform="translate(80 42)">${lensS}</g><g transform="translate(96 42)">${lensS}</g><g transform="translate(88 58)">${lensS}</g></g>`;
        } else if (isPro) {
          shape = `<g transform="rotate(-9 100 100)">
             <rect x="56" y="14" width="88" height="170" rx="20" fill="${F}"/>
             <rect x="56.5" y="14.5" width="87" height="169" rx="19.5" fill="none" stroke="${line}"/>
             <path d="M76 14h48a20 20 0 0 1 20 20v26H56V34a20 20 0 0 1 20-20Z" fill="${b1}" opacity=".85"/>
             <path d="M56 60h88" stroke="${line}"/>
             <g transform="translate(77 31)">${lens}</g><g transform="translate(77 49)">${lens}</g><g transform="translate(95 40)">${lens}</g>
             <circle cx="124" cy="31" r="3.5" fill="#f4efe1" opacity=".9"/><circle cx="124" cy="49" r="2.5" fill="${ink}" opacity=".7"/></g>`;
        } else {
          shape = `<g transform="rotate(-9 100 100)">
             <rect x="58" y="16" width="84" height="166" rx="20" fill="${F}"/>
             <rect x="58.5" y="16.5" width="83" height="165" rx="19.5" fill="none" stroke="${line}"/>
             <rect x="68" y="26" width="24" height="44" rx="12" fill="${b2}" opacity=".55"/>
             <g transform="translate(80 37)">${lens}</g><g transform="translate(80 59)">${lens}</g></g>`;
        }
        break;
      case "tablet":
        shape = `<g transform="rotate(-7 100 100)"><rect x="44" y="22" width="112" height="152" rx="14" fill="${F}"/>
          <rect x="44.5" y="22.5" width="111" height="151" rx="13.5" fill="none" stroke="${line}"/>
          <g transform="translate(62 40)">${lensS}</g><circle cx="100" cy="98" r="9" fill="${b2}" opacity=".35"/></g>`;
        break;
      case "laptop":
        shape = `<rect x="38" y="44" width="124" height="88" rx="8" fill="${ink}"/>
          <rect x="43" y="49" width="114" height="78" rx="4" fill="${W}"/>
          <path d="M43 49h114v30C120 64 80 92 43 84Z" fill="#fff" opacity=".08"/>
          <path d="M24 134h152l-6 12a6 6 0 0 1-5 3H35a6 6 0 0 1-5-3Z" fill="${F}"/>
          <path d="M88 134h24v3a3 3 0 0 1-3 3H91a3 3 0 0 1-3-3Z" fill="${b2}" opacity=".6"/>`;
        break;
      case "imac":
        shape = `<rect x="34" y="30" width="132" height="104" rx="9" fill="${F}"/>
          <rect x="40" y="36" width="120" height="76" rx="3" fill="${W}"/>
          <rect x="34.5" y="30.5" width="131" height="103" rx="8.5" fill="none" stroke="${line}"/>
          <path d="M86 134h28l6 34H80Z" fill="${b2}"/><rect x="72" y="166" width="56" height="5" rx="2.5" fill="${b2}"/>`;
        break;
      case "watch": {
        const round = /garmin|approach|fenix|forerunner|instinct|epix|venu|galaxy|classic/i.test(`${name} ${item.category}`) && !/apple|fit3|se2|se3|ultra/i.test(name);
        shape = `<rect x="78" y="16" width="44" height="52" rx="12" fill="${b2}"/><rect x="78" y="132" width="44" height="52" rx="12" fill="${b2}"/>
          ${round
            ? `<circle cx="100" cy="100" r="44" fill="${F}"/><circle cx="100" cy="100" r="35" fill="${ink}"/><circle cx="100" cy="100" r="31" fill="${W}" opacity=".9"/>
               <rect x="144" y="86" width="7" height="12" rx="3" fill="${b2}"/><rect x="144" y="104" width="7" height="12" rx="3" fill="${b2}"/>`
            : `<rect x="62" y="54" width="76" height="92" rx="22" fill="${F}"/><rect x="68" y="60" width="64" height="80" rx="17" fill="${ink}"/>
               <rect x="72" y="64" width="56" height="72" rx="14" fill="${W}" opacity=".9"/><rect x="138" y="80" width="6" height="16" rx="3" fill="${b2}"/>`}`;
        break;
      }
      case "earbuds":
        shape = `<rect x="48" y="66" width="104" height="96" rx="38" fill="${F}"/>
          <path d="M48 100h104" stroke="rgba(0,0,0,.09)" stroke-width="1.5"/>
          <rect x="48.5" y="66.5" width="103" height="95" rx="37.5" fill="none" stroke="rgba(0,0,0,.06)"/>
          <circle cx="100" cy="122" r="2.6" fill="#7bd88f"/>`;
        break;
      case "headphones":
        shape = `<path d="M52 118V96a48 48 0 0 1 96 0v22" fill="none" stroke="${b2}" stroke-width="10" stroke-linecap="round"/>
          <rect x="36" y="104" width="38" height="64" rx="16" fill="${F}"/><rect x="126" y="104" width="38" height="64" rx="16" fill="${F}"/>
          <rect x="43" y="114" width="24" height="44" rx="10" fill="${b2}" opacity=".6"/><rect x="133" y="114" width="24" height="44" rx="10" fill="${b2}" opacity=".6"/>`;
        break;
      case "gamepad":
        shape = `<path d="M62 70h76c18 0 30 14 34 34l8 40c3 16-12 26-24 16l-22-20H66l-22 20c-12 10-27 0-24-16l8-40c4-20 16-34 34-34Z" fill="${F}"/>
          <path d="M74 70h52v26a8 8 0 0 1-8 8H82a8 8 0 0 1-8-8Z" fill="${ink}" opacity=".85"/>
          <circle cx="80" cy="128" r="11" fill="${ink}" opacity=".85"/><circle cx="120" cy="128" r="11" fill="${ink}" opacity=".85"/>
          <path d="M50 102h18M59 93v18" stroke="${ink}" stroke-width="5" stroke-linecap="round" opacity=".75"/>
          <g fill="${ink}" opacity=".75"><circle cx="146" cy="94" r="4"/><circle cx="146" cy="112" r="4"/><circle cx="137" cy="103" r="4"/><circle cx="155" cy="103" r="4"/></g>`;
        break;
      case "console":
        shape = `<path d="M70 22c-10 30-12 120-4 156h20V22Z" fill="${F}"/><path d="M130 22c10 30 12 120 4 156h-20V22Z" fill="${F}"/>
          <rect x="86" y="22" width="28" height="156" rx="3" fill="${ink}"/><path d="M90 30h20" stroke="#4d8cff" stroke-width="2" stroke-linecap="round"/>`;
        break;
      case "speaker":
        shape = `<rect x="62" y="58" width="76" height="116" rx="34" fill="${F}"/>
          <ellipse cx="100" cy="66" rx="30" ry="8" fill="${b2}" opacity=".45"/><ellipse cx="100" cy="66" rx="16" ry="4" fill="#8f7bff" opacity=".9"/>`;
        break;
      case "airtag":
        shape = `<circle cx="84" cy="104" r="46" fill="${F}" stroke="rgba(0,0,0,.06)"/><circle cx="84" cy="104" r="30" fill="#e9eaee"/>
          <circle cx="126" cy="122" r="40" fill="${F}" stroke="rgba(0,0,0,.08)"/><circle cx="126" cy="122" r="26" fill="#dfe0e5"/>`;
        break;
      case "charger":
        shape = `<rect x="66" y="70" width="68" height="76" rx="14" fill="${F}"/>
          <rect x="66.5" y="70.5" width="67" height="75" rx="13.5" fill="none" stroke="rgba(0,0,0,.08)"/>
          <rect x="90" y="102" width="20" height="8" rx="4" fill="${ink}" opacity=".8"/>
          <path d="M88 70V52M112 70V52" stroke="#c9c9ce" stroke-width="6" stroke-linecap="round"/>`;
        break;
      case "glasses":
        shape = `<path d="M30 84h140" stroke="${b2}" stroke-width="6" stroke-linecap="round"/>
          <path d="M34 84h54l-4 30a16 16 0 0 1-16 14H52a16 16 0 0 1-16-13Z" fill="${F}"/><path d="M112 84h54l-2 31a16 16 0 0 1-16 13h-16a16 16 0 0 1-16-14Z" fill="${F}"/>
          <path d="M42 92h40l-3 20a10 10 0 0 1-10 8H54a10 10 0 0 1-10-9Z" fill="#2c3440" opacity=".85"/><path d="M118 92h40l-2 20a10 10 0 0 1-10 8h-14a10 10 0 0 1-10-8Z" fill="#2c3440" opacity=".85"/>
          <path d="M88 88q12-8 24 0" fill="none" stroke="${b2}" stroke-width="5"/>`;
        break;
      case "hairdryer":
        shape = `<rect x="86" y="96" width="28" height="84" rx="14" fill="${F}"/><rect x="88" y="150" width="24" height="6" rx="3" fill="${b2}" opacity=".5"/>
          <circle cx="100" cy="70" r="46" fill="${F}"/><circle cx="100" cy="70" r="24" fill="${b2}" opacity=".9"/><circle cx="100" cy="70" r="17" fill="#f5f5f7" opacity=".85"/>
          <circle cx="100" cy="70" r="45.5" fill="none" stroke="${line}"/>`;
        break;
      case "styler":
        shape = `<g transform="rotate(-24 100 100)"><rect x="80" y="18" width="18" height="160" rx="9" fill="${F}"/><rect x="102" y="18" width="18" height="150" rx="9" fill="${F}"/>
          <rect x="80" y="130" width="40" height="48" rx="12" fill="${b2}"/><rect x="96" y="24" width="8" height="90" rx="4" fill="${b2}" opacity=".5"/></g>`;
        break;
      case "coffee":
        shape = `<rect x="48" y="30" width="104" height="146" rx="12" fill="${F}"/><rect x="48.5" y="30.5" width="103" height="145" rx="11.5" fill="none" stroke="${line}"/>
          <rect x="60" y="42" width="80" height="26" rx="6" fill="${ink}" opacity=".85"/><circle cx="74" cy="55" r="4" fill="#ffb340"/>
          <rect x="74" y="82" width="52" height="14" rx="4" fill="${b2}"/><rect x="92" y="96" width="16" height="12" rx="2" fill="${ink}"/>
          <path d="M84 132h32v20a8 8 0 0 1-8 8H92a8 8 0 0 1-8-8Z" fill="#fff"/><rect x="60" y="164" width="80" height="6" rx="3" fill="${ink}" opacity=".5"/>`;
        break;
      case "camera":
        shape = `<rect x="44" y="62" width="112" height="84" rx="16" fill="${F}"/><rect x="44.5" y="62.5" width="111" height="83" rx="15.5" fill="none" stroke="${line}"/>
          <circle cx="94" cy="104" r="30" fill="${ink}"/><circle cx="94" cy="104" r="21" fill="#2c3440"/><circle cx="88" cy="98" r="6" fill="#6d7f99" opacity=".7"/>
          <rect x="128" y="74" width="18" height="12" rx="3" fill="${ink}" opacity=".75"/><rect x="56" y="54" width="24" height="10" rx="3" fill="${b2}"/>`;
        break;
      case "dashcam":
        shape = `<rect x="52" y="76" width="96" height="62" rx="14" fill="${F}"/><circle cx="100" cy="107" r="20" fill="${ink}"/><circle cx="100" cy="107" r="12" fill="#2c3440"/>
          <circle cx="96" cy="103" r="4" fill="#6d7f99" opacity=".7"/><path d="M100 76V52h20" stroke="${b2}" stroke-width="6" stroke-linecap="round" fill="none"/>`;
        break;
      case "radio":
        shape = `<rect x="104" y="14" width="10" height="56" rx="5" fill="${b2}"/><rect x="66" y="56" width="68" height="124" rx="14" fill="${F}"/>
          <rect x="76" y="68" width="48" height="28" rx="5" fill="#9fd3a6" opacity=".85"/>
          <g stroke="${ink}" stroke-width="3" stroke-linecap="round" opacity=".55"><path d="M80 112h40M80 122h40M80 132h40M80 142h40M80 152h40"/></g>
          <rect x="58" y="88" width="8" height="26" rx="3" fill="${b2}"/>`;
        break;
      case "tv":
        shape = `<rect x="18" y="40" width="164" height="100" rx="6" fill="${ink}"/><rect x="22" y="44" width="156" height="92" rx="3" fill="${W}"/>
          <path d="M22 44h156v40C140 70 70 100 22 92Z" fill="#fff" opacity=".07"/><path d="M60 140l-10 26M140 140l10 26" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>`;
        break;
      case "scooter":
        shape = `<circle cx="52" cy="152" r="20" fill="none" stroke="${ink}" stroke-width="9"/><circle cx="150" cy="152" r="20" fill="none" stroke="${ink}" stroke-width="9"/>
          <path d="M56 146h76" stroke="${F}" stroke-width="12" stroke-linecap="round"/><path d="M58 140h70" stroke="${line}" stroke-width="2" stroke-linecap="round"/>
          <path d="M150 152 130 36" stroke="${b2}" stroke-width="8" stroke-linecap="round"/><path d="M114 36h34" stroke="${ink}" stroke-width="9" stroke-linecap="round"/>`;
        break;
      case "fridge":
        shape = `<rect x="40" y="70" width="120" height="98" rx="14" fill="${F}"/><rect x="36" y="58" width="128" height="24" rx="10" fill="${b2}"/>
          <rect x="40.5" y="70.5" width="119" height="97" rx="13.5" fill="none" stroke="${line}"/>
          <rect x="112" y="96" width="34" height="14" rx="4" fill="${ink}" opacity=".8"/><circle cx="120" cy="103" r="2" fill="#4cd37b"/>
          <path d="M66 58c0-16 68-16 68 0" fill="none" stroke="${b2}" stroke-width="6"/>`;
        break;
      case "heater":
        shape = `<rect x="48" y="62" width="104" height="96" rx="14" fill="${F}"/>
          <g stroke="${ink}" stroke-width="4" stroke-linecap="round" opacity=".55"><path d="M64 84h72M64 96h72M64 108h72"/></g>
          <rect x="64" y="124" width="36" height="20" rx="4" fill="${ink}" opacity=".8"/><circle cx="124" cy="134" r="9" fill="${ink}" opacity=".7"/>
          <path d="M152 92h14v40" stroke="#9aa0a6" stroke-width="8" stroke-linecap="round" fill="none"/><rect x="60" y="158" width="16" height="8" rx="2" fill="${ink}"/><rect x="124" y="158" width="16" height="8" rx="2" fill="${ink}"/>`;
        break;
      case "sup":
        shape = `<g transform="rotate(-28 100 100)"><ellipse cx="100" cy="100" rx="30" ry="88" fill="${F}"/><ellipse cx="100" cy="100" rx="22" ry="78" fill="none" stroke="${line}" stroke-width="2"/>
          <rect x="88" y="88" width="24" height="34" rx="6" fill="${ink}" opacity=".35"/></g>`;
        break;
      case "motor":
        shape = `<path d="M70 26h60a14 14 0 0 1 14 14v40a14 14 0 0 1-14 14H70a14 14 0 0 1-14-14V40a14 14 0 0 1 14-14Z" fill="${F}"/>
          <rect x="92" y="94" width="16" height="64" fill="${b2}"/><path d="M82 156h44l-8 14H88Z" fill="${b2}"/>
          <path d="M126 162c14-8 22 4 10 10M82 166c-14-6-20 6-8 10" fill="none" stroke="${ink}" stroke-width="6" stroke-linecap="round"/>
          <rect x="66" y="38" width="44" height="8" rx="4" fill="#fff" opacity=".35"/>`;
        break;
      default:
        shape = `<rect x="50" y="56" width="100" height="110" rx="16" fill="${F}"/><path d="M50 84h100" stroke="${line}"/>`;
    }
    return `<svg viewBox="0 0 200 200" class="art-svg" aria-hidden="true">${defs}${shadow}${shape}</svg>`;
  }

  function tile(item) {
    const k = kind(item);
    const p = palette(item.name);
    const bg = p ? p[1] : KIND_TINT[k] ? KIND_TINT[k][0] : FALLBACK[1];
    return { style: `--tile-a:${bg[0]};--tile-b:${bg[1]}`, tone: p ? p[3] : "dark", svg: svg(item), kind: k };
  }

  // Цвет корпуса для кружков выбора цвета: [светлый, тёмный] или null.
  function swatch(colorName) {
    if (!colorName) return null;
    const p = palette(colorName);
    return p ? p[2] : null;
  }

  return { tile, swatch, kind };
})();
