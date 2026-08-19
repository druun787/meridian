// ==========================================================
// meridian — учебный пример backend-сервера
// Node.js + Express + SQLite (better-sqlite3) + bcrypt + JWT
// ==========================================================
//
// Как запустить:
// 1) npm init -y
// 2) npm install express better-sqlite3 bcrypt jsonwebtoken cors dotenv
// 3) создать рядом файл .env с одной строкой:
//      TMDB_API_KEY=твой_настоящий_ключ_от_TMDB
// 4) node server-example.js
// Сервер поднимется на http://localhost:3000
//
// Это НЕ готовый продакшн-сервер — здесь минимум для понимания
// принципа. Нет валидации email, нет ограничения запросов,
// секрет для токенов зашит в код (в реальном проекте он должен
// лежать в переменных окружения, а не в файле).

require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = 'учебный-секрет-поменяй-меня'; // в реальном проекте — из .env

// TMDB-ключ теперь живёт только здесь, на сервере — браузер его
// никогда не видит. Читается из переменной окружения TMDB_API_KEY
// (задаётся в файле .env локально, или в настройках хостинга
// в проде — см. раздел "Environment Variables").
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
if (!TMDB_API_KEY) {
  console.warn('⚠️  TMDB_API_KEY не задан — поиск фильмов работать не будет.');
  console.warn('   Создай файл .env рядом с этим скриптом со строкой:');
  console.warn('   TMDB_API_KEY=твой_ключ');
}

// ---------------------------------------------------------
// База данных: файл meridian.db создастся автоматически
// рядом со скриптом при первом запуске
// ---------------------------------------------------------
const db = new Database('meridian.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    poster_path TEXT DEFAULT '',
    rating REAL,
    review TEXT DEFAULT '',
    watched_date TEXT,
    release_year INTEGER,
    genres TEXT DEFAULT '',
    status TEXT DEFAULT 'watched',
    added_date TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Миграции для базы, созданной ДО добавления этих колонок —
// если колонка уже есть, SQLite вернёт ошибку, которую мы тихо
// игнорируем (значит, всё уже на месте). Существующие записи,
// у которых ещё нет status, по умолчанию получат 'watched' —
// они были сохранены до появления watchlist, значит это точно
// просмотренные фильмы.
for (const alter of [
  `ALTER TABLE entries ADD COLUMN poster_path TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN release_year INTEGER`,
  `ALTER TABLE entries ADD COLUMN genres TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN status TEXT DEFAULT 'watched'`,
  `ALTER TABLE entries ADD COLUMN added_date TEXT`
]) {
  try { db.exec(alter); } catch (err) { /* колонка уже существует — ок */ }
}

// Один пользователь — одна запись на конкретный фильм TMDB.
// Без этого повторное сохранение оценки создавало бы дубликат
// вместо обновления существующей строки.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_user_tmdb ON entries(user_id, tmdb_id)`);
} catch (err) {
  console.warn('Не удалось создать уникальный индекс — возможно, в базе уже есть дубликаты одного фильма у одного пользователя.');
  console.warn('Если увидишь эту надпись: проще всего остановить сервер, удалить файл meridian.db и запустить заново — это тестовые данные, их не жалко.');
}

// ---------------------------------------------------------
// РЕГИСТРАЦИЯ
// Браузер присылает { username, password }
// ---------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Нужны username и password' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Такой username уже занят' });
  }

  // Превращаем пароль в "фарш" — 10 означает сложность хеширования
  const passwordHash = await bcrypt.hash(password, 10);

  const result = db.prepare(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)'
  ).run(username, passwordHash);

  const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

// ---------------------------------------------------------
// ВХОД
// Браузер присылает { username, password }
// ---------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Неверный username или пароль' });
  }

  // сравниваем "фарш" из базы с "фаршем" из введённого пароля
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Неверный username или пароль' });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, bio: user.bio, avatar_url: user.avatar_url });
});

// ---------------------------------------------------------
// Middleware — проверяет токен на всех "защищённых" запросах
// (то есть на всём, что требует знать, кто именно пользователь)
// ---------------------------------------------------------
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization; // ожидаем "Bearer <токен>"
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // Токен может быть подписан правильно, но ссылаться на пользователя,
    // которого уже нет в базе (например, база была пересоздана заново).
    // Проверяем это явно — иначе следующий запрос к базе упадёт с
    // непонятной ошибкой FOREIGN KEY constraint failed.
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(payload.userId);
    if (!user) {
      return res.status(401).json({ error: 'Сессия устарела — войди заново' });
    }

    req.userId = payload.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
}

// ---------------------------------------------------------
// ДОБАВИТЬ ФИЛЬМ В ПРОФИЛЬ (или ОБНОВИТЬ, если уже есть)
// Браузер присылает { tmdb_id, title, poster_path, rating, review,
//                      watched_date, release_year, genres }
// вместе с заголовком Authorization: Bearer <токен>
//
// Если у этого пользователя уже есть запись с таким tmdb_id —
// она обновится (новая оценка, новая дата и т.д.), а не задвоится.
// Это называется "upsert" — insert, который в случае конфликта
// превращается в update. Работает благодаря уникальному индексу
// idx_entries_user_tmdb, который мы создали выше.
// ---------------------------------------------------------
app.post('/api/entries', requireAuth, (req, res) => {
  const { tmdb_id, title, poster_path, rating, review, watched_date, release_year, genres } = req.body;

  if (!tmdb_id || !title) {
    return res.status(400).json({ error: 'Нужны хотя бы tmdb_id и title' });
  }

  // genres приходит с фронтенда массивом (["Sci-Fi", "Drama"]) —
  // в базе храним просто строкой через запятую, так проще фильтровать
  const genresText = Array.isArray(genres) ? genres.join(', ') : (genres || '');

  try {
    const stmt = db.prepare(`
      INSERT INTO entries (user_id, tmdb_id, title, poster_path, rating, review, watched_date, release_year, genres, status)
      VALUES (@user_id, @tmdb_id, @title, @poster_path, @rating, @review, @watched_date, @release_year, @genres, 'watched')
      ON CONFLICT(user_id, tmdb_id) DO UPDATE SET
        title = excluded.title,
        poster_path = excluded.poster_path,
        rating = excluded.rating,
        review = excluded.review,
        watched_date = excluded.watched_date,
        release_year = excluded.release_year,
        genres = excluded.genres,
        status = 'watched'
    `);

    stmt.run({
      user_id: req.userId,
      tmdb_id,
      title,
      poster_path: poster_path || '',
      rating: rating ?? null,
      review: review || '',
      watched_date: watched_date || null,
      release_year: release_year ?? null,
      genres: genresText
    });

    const saved = db.prepare('SELECT * FROM entries WHERE user_id = ? AND tmdb_id = ?').get(req.userId, tmdb_id);
    res.json(saved);

  } catch (err) {
    console.error('Ошибка при сохранении entry:', err.message);
    res.status(500).json({ error: 'Не получилось сохранить запись на сервере' });
  }
});

// ---------------------------------------------------------
// ДОБАВИТЬ ФИЛЬМ В WATCHLIST ("посмотреть позже")
// Браузер присылает { tmdb_id, title, poster_path, release_year, genres }
//
// Если фильм уже отмечен как ПРОСМОТРЕННЫЙ (status='watched') —
// мы НЕ понижаем его обратно до watchlist, просто отвечаем как есть.
// Это работает через тот же трюк ON CONFLICT, но с условием CASE:
// "оставь status и added_date как были, если уже watched".
// ---------------------------------------------------------
app.post('/api/watchlist', requireAuth, (req, res) => {
  const { tmdb_id, title, poster_path, release_year, genres } = req.body;

  if (!tmdb_id || !title) {
    return res.status(400).json({ error: 'Нужны хотя бы tmdb_id и title' });
  }

  const genresText = Array.isArray(genres) ? genres.join(', ') : (genres || '');
  const addedDate = new Date().toISOString().slice(0, 10);

  try {
    const stmt = db.prepare(`
      INSERT INTO entries (user_id, tmdb_id, title, poster_path, release_year, genres, status, added_date)
      VALUES (@user_id, @tmdb_id, @title, @poster_path, @release_year, @genres, 'watchlist', @added_date)
      ON CONFLICT(user_id, tmdb_id) DO UPDATE SET
        title = excluded.title,
        poster_path = excluded.poster_path,
        release_year = excluded.release_year,
        genres = excluded.genres,
        status = CASE WHEN entries.status = 'watched' THEN entries.status ELSE excluded.status END,
        added_date = CASE WHEN entries.status = 'watched' THEN entries.added_date ELSE excluded.added_date END
    `);

    stmt.run({
      user_id: req.userId,
      tmdb_id,
      title,
      poster_path: poster_path || '',
      release_year: release_year ?? null,
      genres: genresText,
      added_date: addedDate
    });

    const saved = db.prepare('SELECT * FROM entries WHERE user_id = ? AND tmdb_id = ?').get(req.userId, tmdb_id);
    res.json(saved);

  } catch (err) {
    console.error('Ошибка при сохранении в watchlist:', err.message);
    res.status(500).json({ error: 'Не получилось добавить в watchlist' });
  }
});

// ---------------------------------------------------------
// УДАЛИТЬ ФИЛЬМ ИЗ WATCHLIST
// ---------------------------------------------------------
app.delete('/api/watchlist/:tmdbId', requireAuth, (req, res) => {
  db.prepare(
    `DELETE FROM entries WHERE user_id = ? AND tmdb_id = ? AND status = 'watchlist'`
  ).run(req.userId, req.params.tmdbId);
  res.json({ ok: true });
});

// ---------------------------------------------------------
// ПОЛУЧИТЬ ПРОФИЛЬ + ВСЕ ФИЛЬМЫ ПОЛЬЗОВАТЕЛЯ
// GET /api/profile/velvet_meridian
// (открытый эндпоинт — чтобы чужой профиль тоже можно было смотреть)
// ---------------------------------------------------------
app.get('/api/profile/:username', (req, res) => {
  const user = db.prepare(
    'SELECT id, username, bio, avatar_url FROM users WHERE username = ?'
  ).get(req.params.username);

  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const entries = db.prepare(
    `SELECT * FROM entries WHERE user_id = ? ORDER BY COALESCE(watched_date, added_date) DESC`
  ).all(user.id);

  res.json({ ...user, entries });
});

// ---------------------------------------------------------
// ОБНОВИТЬ СВОЙ ПРОФИЛЬ (био и ссылка на аватар)
// Браузер присылает { bio, avatar_url } вместе с токеном
// ---------------------------------------------------------
app.put('/api/profile', requireAuth, (req, res) => {
  const { bio, avatar_url } = req.body;

  db.prepare('UPDATE users SET bio = ?, avatar_url = ? WHERE id = ?')
    .run(bio || '', avatar_url || '', req.userId);

  const updated = db.prepare('SELECT username, bio, avatar_url FROM users WHERE id = ?').get(req.userId);
  res.json(updated);
});

// ---------------------------------------------------------
// TMDB-ПРОКСИ
// Браузер обращается сюда вместо api.themoviedb.org напрямую.
// Ключ добавляется здесь, на сервере — наружу он не уходит.
// Эти три эндпоинта открытые (без requireAuth), потому что поиск
// фильмов не требует входа в аккаунт — как и на самом TMDB.
// ---------------------------------------------------------
app.get('/api/tmdb/search', async (req, res) => {
  const query = (req.query.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Нужен параметр query' });

  try {
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=ru-RU`;
    const tmdbRes = await fetch(url);
    const data = await tmdbRes.json();
    res.status(tmdbRes.status).json(data);
  } catch (err) {
    console.error('Ошибка TMDB-прокси (search):', err.message, '| причина:', err.cause);
    res.status(502).json({ error: 'TMDB недоступен' });
  }
});

app.get('/api/tmdb/movie/:id', async (req, res) => {
  try {
    const url = `https://api.themoviedb.org/3/movie/${req.params.id}?api_key=${TMDB_API_KEY}&language=ru-RU`;
    const tmdbRes = await fetch(url);
    const data = await tmdbRes.json();
    res.status(tmdbRes.status).json(data);
  } catch (err) {
    console.error('Ошибка TMDB-прокси (movie):', err.message, '| причина:', err.cause);
    res.status(502).json({ error: 'TMDB недоступен' });
  }
});

app.get('/api/tmdb/movie/:id/credits', async (req, res) => {
  try {
    const url = `https://api.themoviedb.org/3/movie/${req.params.id}/credits?api_key=${TMDB_API_KEY}&language=ru-RU`;
    const tmdbRes = await fetch(url);
    const data = await tmdbRes.json();
    res.status(tmdbRes.status).json(data);
  } catch (err) {
    console.error('Ошибка TMDB-прокси (credits):', err.message, '| причина:', err.cause);
    res.status(502).json({ error: 'TMDB недоступен' });
  }
});

app.listen(3000, () => {
  console.log('Сервер запущен: http://localhost:3000');
});
