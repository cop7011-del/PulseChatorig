# PulseChat

Полноценный веб-мессенджер на Node.js + SQLite + WebSocket + vanilla JS.

## Запуск

```bash
npm install
npm start
```

Открыть: http://localhost:4000/pulse.html

## Структура

- `server/` - backend, API, WebSocket, БД, загрузки
- `public/` - frontend (статические файлы, whitelist)
- `data/` - создаётся автоматически (sqlite db, uploads)

## Тест-аккаунты

При первом запуске создаются:
- `alice` / `password123`
- `bob` / `password123`
