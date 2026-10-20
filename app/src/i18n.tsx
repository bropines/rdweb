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
  servers: {
    title: "Servers",
    add: "Add server",
    edit: "Edit server",
    delete: "Delete",
    deleteTitle: "Delete {{name}}?",
    deleteDesc: "The server is removed from this browser. Remembered device passwords for it stay until you clear the data.",
    empty: "No servers yet.",
    key: "Key",
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
  },
  about: {
    title: "About",
    intro: "rdweb is an open-source browser client for RustDesk-compatible servers (MIT). This page is static: there is no backend behind it.",
    privacyTitle: "Privacy and security",
    p1: "Everything runs in your browser. Connections go straight from this page to the server you configured; nothing is sent anywhere else and there are no analytics.",
    p2: "Device passwords travel only to the device, inside the encrypted session. The server key is used to verify the device before anything is sent.",
    p3: "“Remember password” stores a salted hash in this browser (not the password itself), bound to the server key and device id. Servers, recent devices and settings also stay in this browser.",
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
    ios: "Tap Share, then “Add to Home Screen”.",
    macos: "In Safari's menu bar, choose File → Add to Dock.",
    hint: "The app opens in its own window and starts even when this website is unreachable.",
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
  servers: {
    title: "Серверы",
    add: "Добавить сервер",
    edit: "Изменить сервер",
    delete: "Удалить",
    deleteTitle: "Удалить {{name}}?",
    deleteDesc: "Сервер будет удалён из этого браузера. Запомненные пароли устройств останутся, пока вы не очистите данные.",
    empty: "Серверов пока нет.",
    key: "Ключ",
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
  },
  about: {
    title: "О программе",
    intro: "rdweb — клиент с открытым кодом (MIT) для серверов, совместимых с RustDesk, прямо в браузере. Эта страница статическая: за ней нет никакого бэкенда.",
    privacyTitle: "Приватность и безопасность",
    p1: "Всё работает в вашем браузере. Подключения идут напрямую с этой страницы на указанный вами сервер; больше никуда ничего не отправляется, аналитики нет.",
    p2: "Пароли устройств передаются только самому устройству внутри зашифрованного сеанса. Перед этим устройство проверяется по ключу сервера.",
    p3: "«Запомнить пароль» хранит в этом браузере хеш с солью (а не сам пароль), привязанный к ключу сервера и ID устройства. Серверы, недавние устройства и настройки тоже хранятся только в этом браузере.",
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
    ios: "Нажмите «Поделиться», затем «На экран „Домой“».",
    macos: "В строке меню Safari выберите «Файл» → «Добавить в Dock».",
    hint: "Приложение откроется в отдельном окне и запустится, даже если этот сайт недоступен.",
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
