// Настройки витрины. API_URL — адрес веб-приложения Apps Script (см. README).
// Пока пусто — каталог берётся из локального catalog.json, заказы сохраняются только на устройстве.
window.APP_CONFIG = {
  API_URL: "",
  SHOP_NAME: "VAM — демо",
  MANAGER_USERNAME: "appleVAM_bot", // без @, кнопка «Связаться» откроет чат с ним
  PHONE: "",
  BOT_APP_LINK: "", // ссылка из /newapp, напр. https://t.me/my_bot/shop — для кнопки «Поделиться»
  DEMO: true // плашка «Демонстрация»: до согласия владельца магазина
};
