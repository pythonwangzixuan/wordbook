// 背默通 · 局域网共享服务器
// 用法：node server.js  （可在命令行加端口号，如 node server.js 8080）
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8765;
const MAX_UPLOAD = 60 * 1024 * 1024;
const MAX_JSON = 20 * 1024 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2"
};

/* ================= MySQL 存储 ================= */
let mysql = null;
try { mysql = require("mysql2/promise"); } catch (e) { /* 没装驱动时退回浏览器缓存模式 */ }

function readDbConfig() {
  if (process.env.MYSQL_USER) {
    return {
      host: process.env.MYSQL_HOST || "127.0.0.1",
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASS || "",
      database: process.env.MYSQL_DB || "wordbook"
    };
  }
  try {
    const raw = fs.readFileSync(path.join(ROOT, "db.config.json"), "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg.user) return null;
    return {
      host: cfg.host || "127.0.0.1",
      port: Number(cfg.port) || 3306,
      user: cfg.user,
      password: cfg.password || "",
      database: cfg.database || "wordbook"
    };
  } catch (e) { return null; }
}

const DB_CFG = readDbConfig();
let pool = null, dbReady = false;

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function initDb() {
  if (!DB_CFG || !mysql) {
    console.log("  存储：浏览器 localStorage（未配置 MySQL）\n");
    return;
  }
  try {
    pool = mysql.createPool({
      host: DB_CFG.host, port: DB_CFG.port, user: DB_CFG.user, password: DB_CFG.password,
      database: DB_CFG.database, connectionLimit: 6, charset: "utf8mb4", waitForConnections: true
    });
    await pool.query("SELECT 1");
    await pool.query(`CREATE TABLE IF NOT EXISTS users(
      id VARCHAR(40) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
      pass VARCHAR(255) NOT NULL, created BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sessions(
      token CHAR(64) PRIMARY KEY, user_id VARCHAR(40) NOT NULL,
      created BIGINT NOT NULL, expires BIGINT NOT NULL,
      INDEX idx_sess_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS books(
      user_id VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL,
      name VARCHAR(200) NOT NULL, descr TEXT, color VARCHAR(16), created BIGINT,
      sort INT NOT NULL DEFAULT 0, PRIMARY KEY(user_id,id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS entries(
      user_id VARCHAR(40) NOT NULL, book_id VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL,
      type VARCHAR(24), en MEDIUMTEXT, zh MEDIUMTEXT, ipa VARCHAR(255), ex MEDIUMTEXT, note MEDIUMTEXT,
      blanks JSON NULL, right_count INT NOT NULL DEFAULT 0, wrong_count INT NOT NULL DEFAULT 0,
      last_result VARCHAR(16) NULL, star TINYINT NOT NULL DEFAULT 0, sort INT NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,book_id,id), INDEX idx_book (user_id,book_id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_day_stats(
      user_id VARCHAR(40) NOT NULL, day CHAR(10) NOT NULL,
      study INT NOT NULL DEFAULT 0, right_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_meta(
      user_id VARCHAR(40) NOT NULL, k VARCHAR(32) NOT NULL, v TEXT,
      PRIMARY KEY(user_id,k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query("DELETE FROM sessions WHERE expires < ?", [Date.now()]);
    dbReady = true;
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM users");
    console.log(`  存储：MySQL ${DB_CFG.host}:${DB_CFG.port}/${DB_CFG.database}（已连接，现有 ${rows[0].n} 个账号）\n`);
  } catch (e) {
    dbReady = false;
    console.log(`  存储：MySQL 连接失败（${e.code || e.message}），改用浏览器 localStorage\n`);
  }
}

/* ================= 账号 / 会话 ================= */
const SESSION_DAYS = 30;
const COOKIE_NAME = "wb_sid";

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return "scrypt$" + salt + "$" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function verifyPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expect = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(pw, parts[1], 64);
  return actual.length === expect.length && crypto.timingSafeEqual(actual, expect);
}
function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await pool.query("INSERT INTO sessions(token,user_id,created,expires) VALUES (?,?,?,?)",
    [token, userId, now, now + SESSION_DAYS * 86400000]);
  return token;
}
async function currentUser(req) {
  if (!dbReady || !pool) return null;
  const token = readCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const [rows] = await pool.query(
    "SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
    [token, Date.now()]
  );
  if (!rows.length) return null;
  return { id: rows[0].id, username: rows[0].username, token };
}

async function handleAuth(req, res, action) {
  if (action === "me") {
    if (!dbReady) return json(res, 200, { enabled: false });
    try {
      const u = await currentUser(req);
      return json(res, 200, { enabled: true, user: u ? { id: u.id, username: u.username } : null });
    } catch (e) {
      return json(res, 500, { error: "读取登录状态失败：" + e.message });
    }
  }
  if (action === "logout") {
    const token = readCookies(req)[COOKIE_NAME];
    if (dbReady && token) {
      try { await pool.query("DELETE FROM sessions WHERE token=?", [token]); } catch (_) { /* ignore */ }
    }
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }
  if (!dbReady) return json(res, 503, { error: "MySQL 未连接，暂时无法登录" });
  if (action !== "register" && action !== "login") return json(res, 404, { error: "接口不存在" });

  readJsonBody(req, async (err, body) => {
    if (err) return json(res, 400, { error: err.message });
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (username.length < 2 || username.length > 20) return json(res, 400, { error: "用户名需 2-20 个字符" });
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]+$/.test(username))
      return json(res, 400, { error: "用户名只能包含中英文、数字、下划线、点和短横线" });
    if (password.length < 4 || password.length > 64) return json(res, 400, { error: "密码需 4-64 位" });
    try {
      if (action === "register") {
        const [exists] = await pool.query("SELECT id FROM users WHERE username=?", [username]);
        if (exists.length) return json(res, 409, { error: "该用户名已被注册" });
        const id = "u" + crypto.randomBytes(8).toString("hex");
        await pool.query("INSERT INTO users(id,username,pass,created) VALUES (?,?,?,?)",
          [id, username, hashPassword(password), Date.now()]);
        const token = await createSession(id);
        setSessionCookie(res, token);
        return json(res, 200, { ok: true, user: { id, username } });
      }
      const [rows] = await pool.query("SELECT id,username,pass FROM users WHERE username=?", [username]);
      if (!rows.length || !verifyPassword(password, rows[0].pass))
        return json(res, 401, { error: "用户名或密码不正确" });
      await pool.query("DELETE FROM sessions WHERE expires<?", [Date.now()]);
      const token = await createSession(rows[0].id);
      setSessionCookie(res, token);
      return json(res, 200, { ok: true, user: { id: rows[0].id, username: rows[0].username } });
    } catch (e) {
      console.error("登录/注册失败：", e);
      return json(res, 500, { error: "服务器错误：" + e.message });
    }
  });
}

async function handleGetData(req, res, user) {
  if (!dbReady) return json(res, 200, { enabled: false });
  try {
    const [books] = await pool.query(
      "SELECT id,name,descr,color,created FROM books WHERE user_id=? ORDER BY sort,created", [user.id]
    );
    const [entries] = await pool.query(
      "SELECT id,book_id,type,en,zh,ipa,ex,note,blanks,right_count,wrong_count,last_result,star FROM entries WHERE user_id=? ORDER BY book_id,sort",
      [user.id]
    );
    const [days] = await pool.query("SELECT day,study,right_count FROM user_day_stats WHERE user_id=?", [user.id]);
    const [meta] = await pool.query("SELECT k,v FROM user_meta WHERE user_id=?", [user.id]);
    const map = new Map(books.map(b => [b.id, {
      id: b.id, name: b.name, desc: b.descr || "", color: b.color || "#6366f1",
      created: Number(b.created) || 0, entries: []
    }]));
    for (const e of entries) {
      const b = map.get(e.book_id);
      if (!b) continue;
      let blanks = null;
      if (e.blanks) { try { blanks = typeof e.blanks === "string" ? JSON.parse(e.blanks) : e.blanks; } catch (_) { blanks = null; } }
      b.entries.push({
        id: e.id, type: e.type || "word", en: e.en || "", zh: e.zh || "", ipa: e.ipa || "",
        ex: e.ex || "", note: e.note || "", blanks,
        right: Number(e.right_count) || 0, wrong: Number(e.wrong_count) || 0,
        last: e.last_result || null, star: !!e.star
      });
    }
    const dayOut = {};
    for (const d of days) dayOut[d.day] = { study: Number(d.study) || 0, right: Number(d.right_count) || 0 };
    const metaMap = {};
    meta.forEach(m => { metaMap[m.k] = m.v; });
    json(res, 200, {
      enabled: true,
      books: [...map.values()],
      days: dayOut,
      theme: metaMap.theme || "light",
      updatedAt: Number(metaMap.updatedAt) || 0
    });
  } catch (e) {
    console.error("读取数据失败：", e);
    json(res, 500, { error: "读取数据库失败：" + e.message });
  }
}

function readJsonBody(req, cb) {
  const chunks = [];
  let size = 0, aborted = false;
  req.on("data", c => {
    size += c.length;
    if (size > MAX_JSON) { aborted = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return cb(new Error("请求内容过大"));
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch (e) { cb(new Error("请求格式不是合法 JSON")); }
  });
}

async function handlePutData(req, res, user) {
  if (!dbReady) return json(res, 503, { error: "MySQL 未连接，数据未写入数据库" });
  readJsonBody(req, async (err, body) => {
    if (err) return json(res, 400, { error: err.message });
    const books = Array.isArray(body.books) ? body.books : null;
    if (!books) return json(res, 400, { error: "缺少 books 数组" });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("DELETE FROM entries WHERE user_id=?", [user.id]);
      await conn.query("DELETE FROM books WHERE user_id=?", [user.id]);
      await conn.query("DELETE FROM user_day_stats WHERE user_id=?", [user.id]);
      const seenBook = new Set();
      for (let i = 0; i < books.length; i++) {
        const b = books[i] || {};
        const bid = String(b.id || "");
        if (!bid || seenBook.has(bid)) continue;   // 前端若传来重复 id，跳过而不是让事务失败
        seenBook.add(bid);
        await conn.query(
          "INSERT INTO books(user_id,id,name,descr,color,created,sort) VALUES (?,?,?,?,?,?,?)",
          [user.id, bid, String(b.name || "未命名"), String(b.desc || ""), String(b.color || ""), Number(b.created) || Date.now(), i]
        );
        const list = Array.isArray(b.entries) ? b.entries : [];
        const seenEntry = new Set();
        for (let j = 0; j < list.length; j += 200) {
          const chunk = list.slice(j, j + 200);
          const params = [];
          let rows = 0;
          for (let k = 0; k < chunk.length; k++) {
            const e = chunk[k] || {};
            let eid = String(e.id || `${bid}_${j + k}`);
            if (seenEntry.has(eid)) eid = `${eid}_${j + k}_dup`;
            seenEntry.add(eid);
            params.push(
              user.id, bid, eid, String(e.type || "word"),
              String(e.en ?? ""), String(e.zh ?? ""), String(e.ipa ?? ""),
              String(e.ex ?? ""), String(e.note ?? ""),
              Array.isArray(e.blanks) ? JSON.stringify(e.blanks) : null,
              Number(e.right) || 0, Number(e.wrong) || 0,
              e.last === "right" || e.last === "wrong" ? e.last : null,
              e.star ? 1 : 0, j + k
            );
            rows++;
          }
          if (!rows) continue;
          await conn.query(
            "INSERT INTO entries(user_id,book_id,id,type,en,zh,ipa,ex,note,blanks,right_count,wrong_count,last_result,star,sort) VALUES " +
            chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(","),
            params
          );
        }
      }
      const days = body.days && typeof body.days === "object" ? body.days : {};
      for (const [day, v] of Object.entries(days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !v) continue;
        await conn.query(
          "INSERT INTO user_day_stats(user_id,day,study,right_count) VALUES (?,?,?,?)",
          [user.id, day, Number(v.study) || 0, Number(v.right) || 0]
        );
      }
      await conn.query(
        "INSERT INTO user_meta(user_id,k,v) VALUES (?,?,?),(?,?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)",
        [user.id, "theme", String(body.theme || "light"), user.id, "updatedAt", String(Date.now())]
      );
      await conn.commit();
      json(res, 200, { ok: true, books: books.length });
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      console.error("写入数据失败：", e);
      json(res, 500, { error: "写入数据库失败：" + e.message });
    } finally {
      conn.release();
    }
  });
}

/* ================= 扫描版 PDF OCR ================= */
/* 调用 Windows 自带的 PDF 渲染 + OCR 引擎，逐页流式返回 NDJSON */
function handleOcrPdf(req, res) {
  const jsonError = (code, obj) => json(res, code, obj);
  if (process.platform !== "win32") return jsonError(501, { error: "扫描版 PDF 识别目前仅支持 Windows" });

  const chunks = [];
  let size = 0, aborted = false;
  req.on("data", c => {
    size += c.length;
    if (size > MAX_UPLOAD) { aborted = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (!buf.length) return jsonError(400, { error: "没有收到 PDF 内容" });

    const tmp = path.join(os.tmpdir(), `wb_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(tmp, buf);

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store"
    });

    const ps = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", path.join(ROOT, "ocr.ps1"),
      "-Path", tmp
    ], { windowsHide: true });

    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ps.kill(); } catch (e) { /* ignore */ }
      fs.unlink(tmp, () => {});
    };
    const timer = setTimeout(() => {
      if (finished) return;
      try { res.write(JSON.stringify({ error: "OCR 超时（超过 5 分钟）" }) + "\n"); } catch (e) { /* ignore */ }
      try { res.end(); } catch (e) { /* ignore */ }
      stop();
    }, 5 * 60 * 1000);

    ps.stdout.on("data", d => { if (!finished) res.write(d); });
    ps.stderr.on("data", d => process.stderr.write(d));
    ps.on("error", e => {
      if (finished) return;
      try { res.write(JSON.stringify({ error: "无法启动 OCR 进程：" + e.message }) + "\n"); } catch (_) { /* ignore */ }
      try { res.end(); } catch (_) { /* ignore */ }
      stop();
    });
    ps.on("close", code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        try { res.write(JSON.stringify({ error: "OCR 进程异常退出（代码 " + code + "）" }) + "\n"); } catch (e) { /* ignore */ }
      }
      try { res.end(); } catch (e) { /* ignore */ }
      fs.unlink(tmp, () => {});
    });
    res.on("close", () => {
      if (!finished && !res.writableEnded) stop();
    });
  });
}

/* ================= HTTP 服务 ================= */
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath.startsWith("/api/auth/")) {
    const action = urlPath.slice("/api/auth/".length);
    if (req.method === "GET" && action === "me") return handleAuth(req, res, "me");
    if (req.method === "POST" && ["register", "login", "logout"].includes(action))
      return handleAuth(req, res, action);
    return json(res, 405, { error: "不支持的请求方法" });
  }
  if (urlPath === "/api/data") {
    if (req.method !== "GET" && req.method !== "PUT") return json(res, 405, { error: "不支持的请求方法" });
    return currentUser(req)
      .catch(() => null)
      .then(user => {
        if (!user) return json(res, 401, { error: "请先登录" });
        return req.method === "GET" ? handleGetData(req, res, user) : handlePutData(req, res, user);
      });
  }
  if (req.method === "POST" && urlPath === "/api/ocr-pdf") return handleOcrPdf(req, res);

  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 页面不存在");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
});

initDb().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces()))
      for (const n of list || [])
        if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    console.log("\n  背默通已启动，局域网内设备可用以下地址访问：\n");
    ips.forEach(ip => console.log(`    http://${ip}:${PORT}`));
    console.log(`    http://localhost:${PORT}  (本机)\n`);
    console.log("  按 Ctrl+C 停止共享\n");
  });
});
