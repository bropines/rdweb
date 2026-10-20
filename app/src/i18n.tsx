// App strings (the session UI brings its own catalog from rdweb/react).
import { createContext, useContext } from "react";
import { resolveLang, type Lang } from "rdweb/react";

const en = {
  tagline: "Web remote desktop for RustDesk servers",
  language: "Language",
  theme: { label: "Theme", light: "Light", dark: "Dark", system: "System" },
  connect: {
    title: "Connect",
    server: "Server",
    device: "Device ID",
    button: "Connect",
    files: "Files only",
    terminal: "Terminal",
    recent: "Recent",
    noServers: "Add your server first: its address and public key.",
    hint: "The device must be online and allow incoming connections. You will be asked for its password unless someone accepts the request on the device.",
    unknownServer: "This server was removed.",
  },
  public: {
    option: "RustDesk public server (experimental)",
    short: "RustDesk public server",
    hint: "No server of your own yet: sessions go through RustDesk's public server, which may not accept browsers. For reliable connections",
    title: "Connect through RustDesk's public server?",
    desc: "You have not added a server of your own, so this session uses rs-ny.rustdesk.com.",
    p1: "That server is run by RustDesk (Purslane Ltd.), not by rdweb. Browser access is experimental and may stop working at any time.",
    p2: "The session stays end-to-end encrypted with the device; the server sees device IDs and when you connect.",
    p3: "Your choice is remembered in this browser; you will not be asked again.",
    accept: "Connect",
  },
  servers: {
    title: "Servers",
    add: "Add server",
    edit: "Edit server",
    delete: "Delete",
    deleteTitle: "Delete {{name}}?",
    deleteDesc: "The server is removed from this browser. Remembered device passwords for it stay until you clear the data.",
    empty: "No servers yet.",
    key: "Key",
    check: "Check server",
  },
  editor: {
    importTitle: "Import a RustDesk config string",
    importHint: "Paste the string from RustDesk's “Export server config” (ID/Relay server settings) or RD Panel's Server page; it fills in the form.",
    importButton: "Import",
    imported: "Server settings imported",
    importFailed: "This is not a RustDesk server config string.",
    name: "Name",
    namePlaceholder: "My server",
    address: "ID server",
    addressPlaceholder: "rd.example.com or wss://rd.example.com/ws/id",
    addressHint: "The HTTPS host that proxies /ws/id and /ws/relay (for RD Panel: the panel's address), or the full WebSocket URL of hbbs.",
    ipWarning: "Browsers need a domain name with a valid certificate; an IP address almost never has one. Use the domain that serves /ws/id.",
    relay: "Relay (optional)",
    relayPlaceholder: "relay.example.com or wss://relay.example.com/ws/relay",
    relayHint: "Only when hbbr is proxied on another host or path; by default it is next to the ID server.",
    resolved: "Connects to {{id}} and {{relay}}.",
    key: "Public key",
    keyHint: "The contents of id_ed25519.pub next to hbbs (the “Key” in RustDesk's ID/Relay server settings, also on RD Panel's Server page). It proves that devices are the ones the server knows.",
    keyRequired: "The public key is required.",
    keyInvalid: "This does not look like the server's public key ({{detail}}).",
    addressRequired: "The address is required.",
    requirementsTitle: "What the server must expose",
    requirements:
      "Browsers can only use WebSockets over TLS: /ws/id must reach hbbs (port 21118) and /ws/relay must reach hbbr (port 21119), for example through nginx, Caddy or angie with a certificate. RD Panel does this out of the box.",
    save: "Save",
    cancel: "Cancel",
    check: "Check",
  },
  about: {
    title: "About",
    intro: "rdweb is an open-source browser client for RustDesk-compatible servers (MIT). This page is static: there is no backend behind it.",
    privacyTitle: "Privacy and security",
    p1: "Everything runs in your browser. Connections go straight from this page to the server you configured; nothing is sent anywhere else and there are no analytics.",
    p2: "Device passwords travel only to the device, inside the encrypted session. The server key is used to verify the device before anything is sent.",
    p3: "“Remember password” stores a salted hash in this browser (not the password itself), bound to the server key and device id. Servers, recent devices, settings and choices such as using the public server also stay in this browser (local storage, no cookies or tracking).",
    clear: "Clear all data in this browser",
    clearConfirm: "Click again to delete servers, remembered passwords and settings",
    cleared: "All saved data was removed from this browser.",
    source: "Source code",
    build: "Build",
    close: "Close",
    install: "rdweb can be installed as an app; it then works without a connection to this website (your server is still needed to reach devices).",
  },
  install: {
    button: "Install",
    title: "Install rdweb",
    hint: "The app opens in its own window and starts even when this website is unreachable.",
    here: "On this device",
    others: "Other browsers and devices",
    platform: {
      "android-chrome": "Chrome on Android",
      "android-other": "Other Android browsers",
      ios: "iPhone and iPad",
      "macos-safari": "Safari on macOS",
      "desktop-chromium": "Chrome and Edge on a computer",
      firefox: "Firefox",
      other: "This browser",
    },
    steps: {
      "android-chrome": "Tap ⋮ at the top right, then “Install app” (or “Add to Home screen” → “Install”).",
      "android-other":
        "In the browser menu, choose “Install app” or “Add to Home screen” (Samsung Internet: ≡ → “Add page to” → “Home screen”; Firefox: ⋮ → “Add to Home screen”). If there is no such item, open this page in Chrome.",
      ios: "In Safari, tap Share, then “Add to Home Screen”. On iOS 16.4 and later the Share menu of Chrome and Edge offers it too.",
      "macos-safari": "In Safari 17 or later, choose File → Add to Dock in the menu bar.",
      "desktop-chromium":
        "Click the install icon at the right end of the address bar, or use the menu: Chrome ⋮ → “Cast, save and share” → “Install page as app”; Edge ⋯ → “Apps” → “Install this site as an app”.",
      firefox: "Firefox on a computer cannot install web apps. Install rdweb from Chrome, Edge or Safari, or keep using it in a tab: it works the same.",
      other: "Look for “Install app” or “Add to Home screen” in the browser menu. Chrome, Edge, Samsung Internet and Safari can install rdweb.",
    },
    troubleTitle: "Installing fails on Android?",
    trouble: {
      vpn: "Try again with a VPN on: Chrome builds the installed app (a WebAPK) through a Google service that may be unreachable from your network.",
      clearData: "Delete this site's stored data in Chrome's site settings, reload and try again (this also removes the servers saved in rdweb).",
      xiaomi:
        "Xiaomi, Redmi, POCO (HyperOS, MIUI): allow Chrome to install apps (Settings → Apps → Chrome → “Install unknown apps”) and turn off the security scan of new apps while installing.",
      otherBrowser: "Or install from Samsung Internet or Microsoft Edge.",
      shortcut: "If nothing helps: Chrome menu ⋮ → “Add to Home screen” → “Create shortcut”. This adds a shortcut instead of an installed app.",
    },
  },
  official: {
    title: "Official RustDesk apps",
    text: "The official RustDesk client can connect directly (P2P) and has more features. rdweb is an independent client, not made by the RustDesk team.",
    github: "GitHub releases (Windows, macOS, Linux, Android)",
    play: "Google Play",
    fdroid: "F-Droid",
    appstore: "App Store (iPhone, iPad)",
  },
  check: {
    title: "Check {{name}}",
    description: "Checks what a browser needs from this server. No device is contacted.",
    device: "Device ID (optional)",
    deviceHint: "The ID server tells whether this device is online; the device itself gets no request.",
    run: "Check",
    running: "Checking…",
    passed: "Everything a browser needs works.",
    failed: "Some checks failed; see the hints below.",
    ms: "{{ms}} ms",
    status: { ok: "passed", fail: "failed", skip: "not checked", running: "checking" },
    step: { rendezvous: "ID server (hbbs)", key: "Server key", relay: "Relay (hbbr)", device: "Device {{id}}" },
    hint: {
      rendezvous:
        "The browser could not open {{url}}. The domain must serve /ws/id over HTTPS with a valid certificate and pass it to hbbs (port 21118); an IP address or a RustDesk port such as 21116 or 21118 does not work in a browser.",
      relay: "The browser could not open {{url}}. /ws/relay must reach hbbr (port 21119) over HTTPS with a valid certificate.",
      badUrl: "This is not a WebSocket address a browser can open; check the server settings.",
      keyMismatch:
        "The ID server's key is signed with a different key than the one configured. Copy id_ed25519.pub from next to hbbs (the Key on RD Panel's Server page) into the server settings.",
      keyInvalid: "The configured key is not a valid public key. Copy id_ed25519.pub from next to hbbs (the Key on RD Panel's Server page).",
      keySkipped:
        "Cannot be checked here: hbbs signs its key only on TCP connections, not over WebSocket. A wrong key shows up as “the server key does not match” when you connect.",
      notReached: "Not checked: the ID server was not reached.",
      online: "The device is online and registered on this server.",
      offline:
        "The ID server does not list this device as online. The device must be on, running RustDesk and registered on this server (with this server's ID server and key).",
      noAnswer: "The ID server did not answer the presence query.",
    },
    error: "The check could not run: {{error}}",
  },
  update: { available: "A new version is available", reload: "Reload" },
  session: { back: "Back to devices" },
};

type Messages = typeof en;

const ru: Messages = {
  tagline: "Веб-доступ к рабочему столу через серверы RustDesk",
  language: "Язык",
  theme: { label: "Тема", light: "Светлая", dark: "Тёмная", system: "Системная" },
  connect: {
    title: "Подключение",
    server: "Сервер",
    device: "ID устройства",
    button: "Подключиться",
    files: "Только файлы",
    terminal: "Терминал",
    recent: "Недавние",
    noServers: "Сначала добавьте сервер: его адрес и публичный ключ.",
    hint: "Устройство должно быть в сети и принимать входящие подключения. Если никто не подтвердит запрос на устройстве, потребуется его пароль.",
    unknownServer: "Этот сервер удалён.",
  },
  public: {
    option: "Публичный сервер RustDesk (экспериментально)",
    short: "Публичный сервер RustDesk",
    hint: "Своего сервера пока нет: сессии идут через публичный сервер RustDesk, который может не пускать браузеры. Для надёжной работы",
    title: "Подключиться через публичный сервер RustDesk?",
    desc: "Свой сервер не добавлен, поэтому сессия пойдёт через rs-ny.rustdesk.com.",
    p1: "Этот сервер принадлежит RustDesk (Purslane Ltd.), а не rdweb. Работа из браузера экспериментальная и может прекратиться в любой момент.",
    p2: "Сессия остаётся сквозно зашифрованной с устройством; сервер видит ID устройств и время подключений.",
    p3: "Выбор запомнится в этом браузере, больше спрашивать не будем.",
    accept: "Подключить",
  },
  servers: {
    title: "Серверы",
    add: "Добавить сервер",
    edit: "Изменить сервер",
    delete: "Удалить",
    deleteTitle: "Удалить {{name}}?",
    deleteDesc: "Сервер будет удалён из этого браузера. Запомненные пароли устройств останутся, пока вы не очистите данные.",
    empty: "Серверов пока нет.",
    key: "Ключ",
    check: "Проверить сервер",
  },
  editor: {
    importTitle: "Импорт строки конфигурации RustDesk",
    importHint: "Вставьте строку из «Экспорт конфигурации сервера» в настройках ID/Relay-сервера RustDesk или со страницы «Сервер» RD Panel — форма заполнится сама.",
    importButton: "Импортировать",
    imported: "Настройки сервера импортированы",
    importFailed: "Это не строка конфигурации сервера RustDesk.",
    name: "Название",
    namePlaceholder: "Мой сервер",
    address: "ID-сервер",
    addressPlaceholder: "rd.example.com или wss://rd.example.com/ws/id",
    addressHint: "HTTPS-хост, который проксирует /ws/id и /ws/relay (для RD Panel — адрес панели), или полный WebSocket-адрес hbbs.",
    ipWarning: "Браузеру нужно доменное имя с действительным сертификатом, у IP-адреса его почти никогда нет. Укажите домен, который обслуживает /ws/id.",
    relay: "Ретранслятор (необязательно)",
    relayPlaceholder: "relay.example.com или wss://relay.example.com/ws/relay",
    relayHint: "Только если hbbr проксируется на другом хосте или пути; по умолчанию — рядом с ID-сервером.",
    resolved: "Подключение к {{id}} и {{relay}}.",
    key: "Публичный ключ",
    keyHint: "Содержимое id_ed25519.pub рядом с hbbs («Ключ» в настройках ID/Relay-сервера RustDesk, также на странице «Сервер» RD Panel). Он подтверждает, что устройство то самое, которое знает сервер.",
    keyRequired: "Нужен публичный ключ.",
    keyInvalid: "Это не похоже на публичный ключ сервера ({{detail}}).",
    addressRequired: "Нужен адрес.",
    requirementsTitle: "Что должен открывать сервер",
    requirements:
      "Браузеры умеют только WebSocket поверх TLS: /ws/id должен вести на hbbs (порт 21118), а /ws/relay — на hbbr (порт 21119), например через nginx, Caddy или angie с сертификатом. RD Panel делает это сразу.",
    save: "Сохранить",
    cancel: "Отмена",
    check: "Проверить",
  },
  about: {
    title: "О программе",
    intro: "rdweb — клиент с открытым кодом (MIT) для серверов, совместимых с RustDesk, прямо в браузере. Эта страница статическая: за ней нет никакого бэкенда.",
    privacyTitle: "Приватность и безопасность",
    p1: "Всё работает в вашем браузере. Подключения идут напрямую с этой страницы на указанный вами сервер; больше никуда ничего не отправляется, аналитики нет.",
    p2: "Пароли устройств передаются только самому устройству внутри зашифрованного сеанса. Перед этим устройство проверяется по ключу сервера.",
    p3: "«Запомнить пароль» хранит в этом браузере хеш с солью (а не сам пароль), привязанный к ключу сервера и ID устройства. Серверы, недавние устройства, настройки и выборы вроде публичного сервера тоже хранятся только в этом браузере (локальное хранилище, без cookie и отслеживания).",
    clear: "Удалить все данные в этом браузере",
    clearConfirm: "Нажмите ещё раз, чтобы удалить серверы, запомненные пароли и настройки",
    cleared: "Все сохранённые данные удалены из этого браузера.",
    source: "Исходный код",
    build: "Сборка",
    close: "Закрыть",
    install: "rdweb можно установить как приложение: тогда оно работает и без связи с этим сайтом (для подключения к устройствам по-прежнему нужен ваш сервер).",
  },
  install: {
    button: "Установить",
    title: "Установка rdweb",
    hint: "Приложение откроется в отдельном окне и запустится, даже если этот сайт недоступен.",
    here: "На этом устройстве",
    others: "Другие браузеры и устройства",
    platform: {
      "android-chrome": "Chrome на Android",
      "android-other": "Другие браузеры на Android",
      ios: "iPhone и iPad",
      "macos-safari": "Safari на macOS",
      "desktop-chromium": "Chrome и Edge на компьютере",
      firefox: "Firefox",
      other: "Этот браузер",
    },
    steps: {
      "android-chrome": "Нажмите ⋮ справа вверху, затем «Установить приложение» (или «Добавить на главный экран» → «Установить»).",
      "android-other":
        "В меню браузера выберите «Установить приложение» или «Добавить на главный экран» (Samsung Internet: ≡ → «Добавить страницу на» → «Главный экран»; Firefox: ⋮ → «Добавить на главный экран»). Если такого пункта нет, откройте эту страницу в Chrome.",
      ios: "В Safari нажмите «Поделиться», затем «На экран „Домой“». В iOS 16.4 и новее этот пункт есть и в меню «Поделиться» Chrome и Edge.",
      "macos-safari": "В Safari 17 или новее выберите в строке меню «Файл» → «Добавить в Dock».",
      "desktop-chromium":
        "Нажмите значок установки справа в адресной строке или откройте меню: Chrome ⋮ → «Трансляция, сохранение и отправка» → «Установить страницу как приложение»; Edge ⋯ → «Приложения» → «Установить этот сайт как приложение».",
      firefox: "Firefox на компьютере не устанавливает веб-приложения. Установите rdweb из Chrome, Edge или Safari или пользуйтесь им во вкладке — работает так же.",
      other: "Поищите в меню браузера «Установить приложение» или «Добавить на главный экран». Установить rdweb умеют Chrome, Edge, Samsung Internet и Safari.",
    },
    troubleTitle: "Не устанавливается на Android?",
    trouble: {
      vpn: "Попробуйте ещё раз с включённым VPN: Chrome собирает установленное приложение (WebAPK) через сервис Google, который из вашей сети может быть недоступен.",
      clearData: "Удалите данные этого сайта в настройках сайтов Chrome, обновите страницу и попробуйте снова (это удалит и серверы, сохранённые в rdweb).",
      xiaomi:
        "Xiaomi, Redmi, POCO (HyperOS, MIUI): разрешите Chrome устанавливать приложения («Настройки» → «Приложения» → Chrome → «Установка неизвестных приложений») и на время установки отключите проверку новых приложений на безопасность.",
      otherBrowser: "Или установите из Samsung Internet или Microsoft Edge.",
      shortcut: "Если ничего не помогло: меню Chrome ⋮ → «Добавить на главный экран» → «Создать ярлык». Появится ярлык вместо установленного приложения.",
    },
  },
  official: {
    title: "Официальные приложения RustDesk",
    text: "Официальный клиент RustDesk умеет подключаться напрямую (P2P) и умеет больше. rdweb — независимый клиент, его делает не команда RustDesk.",
    github: "Релизы на GitHub (Windows, macOS, Linux, Android)",
    play: "Google Play",
    fdroid: "F-Droid",
    appstore: "App Store (iPhone, iPad)",
  },
  check: {
    title: "Проверка: {{name}}",
    description: "Проверяет то, что нужно браузеру от этого сервера. К устройствам проверка не подключается.",
    device: "ID устройства (необязательно)",
    deviceHint: "ID-сервер сообщит, в сети ли устройство; само устройство запроса не получит.",
    run: "Проверить",
    running: "Проверка…",
    passed: "Всё, что нужно браузеру, работает.",
    failed: "Часть проверок не прошла — см. подсказки ниже.",
    ms: "{{ms}} мс",
    status: { ok: "пройдено", fail: "ошибка", skip: "не проверялось", running: "проверяется" },
    step: { rendezvous: "ID-сервер (hbbs)", key: "Ключ сервера", relay: "Ретранслятор (hbbr)", device: "Устройство {{id}}" },
    hint: {
      rendezvous:
        "Браузер не смог открыть {{url}}. Домен должен отдавать /ws/id по HTTPS с действительным сертификатом и передавать его на hbbs (порт 21118); IP-адрес или порт RustDesk вроде 21116 или 21118 в браузере не работают.",
      relay: "Браузер не смог открыть {{url}}. /ws/relay должен вести на hbbr (порт 21119) по HTTPS с действительным сертификатом.",
      badUrl: "Это не WebSocket-адрес, который может открыть браузер; проверьте настройки сервера.",
      keyMismatch:
        "Ключ ID-сервера подписан другим ключом, не тем, что указан. Скопируйте в настройки сервера id_ed25519.pub рядом с hbbs («Ключ» на странице «Сервер» RD Panel).",
      keyInvalid: "Указанный ключ — не публичный ключ. Скопируйте id_ed25519.pub рядом с hbbs («Ключ» на странице «Сервер» RD Panel).",
      keySkipped:
        "Здесь не проверить: hbbs подписывает свой ключ только в TCP-подключениях, не в WebSocket. Неверный ключ проявится при подключении как «ключ сервера не совпадает».",
      notReached: "Не проверялось: ID-сервер недоступен.",
      online: "Устройство в сети и зарегистрировано на этом сервере.",
      offline:
        "ID-сервер не видит это устройство в сети. Устройство должно быть включено, RustDesk запущен и зарегистрирован на этом сервере (ID-сервер и ключ — этого сервера).",
      noAnswer: "ID-сервер не ответил на запрос о статусе устройства.",
    },
    error: "Проверка не запустилась: {{error}}",
  },
  update: { available: "Доступна новая версия", reload: "Обновить" },
  session: { back: "К списку устройств" },
};

const catalogs: Record<Lang, Messages> = { en, ru };

export type AppT = (key: string, vars?: Record<string, string | number>) => string;

export function appTranslator(lang: Lang): AppT {
  return (key, vars) => {
    let node: unknown = catalogs[lang];
    for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
    const s = typeof node === "string" ? node : key;
    return vars ? s.replace(/\{\{(\w+)\}\}/g, (m, n: string) => (vars[n] === undefined ? m : String(vars[n]))) : s;
  };
}

const LANG_KEY = "rdweb.app.lang";

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "ru") return saved;
  } catch {
    /* storage unavailable */
  }
  return resolveLang(navigator.language);
}

export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* storage unavailable */
  }
}

export const AppI18n = createContext<{ t: AppT; lang: Lang }>({ t: appTranslator("en"), lang: "en" });

export function useAppI18n() {
  return useContext(AppI18n);
}
