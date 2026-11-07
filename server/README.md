# 私有交付服务端（部署说明）

> 本文件包含私有交付契约（接口路径、字段、存储约定）。请只放在私有环境或私有仓，
> **不要提交到公开仓库**；当前仓库若为公开，请把本文件移到私有仓或加入 `.gitignore`。

## 1. 它要做什么

爬虫每天跑完后：

1. 用 GitHub App 临时 token 读取私有仓 `upload.json`，拿到 `upload_url` / `upload_token`
2. 把本次**全量 JSON** POST 到服务端
3. 服务端落盘并原子更新 `latest.json` 指针

第二天的爬虫再通过 `latest_url` 回读这份全量包，作为增量抓取的基线。

所以服务端只有两件事：**收包持久化** + **返回上一份全量包清单**。

## 2. 接口契约

### POST /api/upload

| 项 | 值 |
| --- | --- |
| 认证 | `Authorization: Bearer <upload_token>` |
| Content-Type | `multipart/form-data` |
| 表单字段 | `snapshot_date`（`YYYYMMDD`）+ 重复的 `files` |
| 文件 | `train_list_YYYYMMDD.json`、`train_detail_YYYYMMDD.json`（必含）、分组详情、`stopped.json`、`stopped_detail.json`、`summary.json` |
| 成功响应 | 任意 `2xx`，响应体不使用 |
| 失败 | `401` 鉴权失败、`400` 字段/文件不合法、`5xx` 服务端错误（爬虫会重试 3 次） |

### GET /api/latest

返回上一份**成功上传**的全量包清单，供次日增量回读：

```json
{
  "snapshot_date": "20261106",
  "files": {
    "train_list": "https://data.example.com/data/20261106/train_list_20261106.json",
    "train_detail": "https://data.example.com/data/20261106/train_detail_20261106.json",
    "stopped": "https://data.example.com/data/20261106/stopped.json",
    "stopped_detail": "https://data.example.com/data/20261106/stopped_detail.json"
  }
}
```

- `snapshot_date` 必须是 `YYYYMMDD`，爬虫用它判断快照年龄（10 天强制全量）
- `train_list` / `train_detail` 必须有；`stopped` / `stopped_detail` 建议有
- 地址可以是绝对 URL，也可以是以 `/` 开头的相对地址（爬虫会相对 `latest_url` 解析）
- 这些文件地址同样需要接受 `Authorization: Bearer <latest_token>`
- 还没有任何快照时返回 `404`，爬虫会自动全量抓取（不影响交付）

## 3. 存储布局

```
data/
  latest.json                 # 指针，只在整包落盘校验通过后才替换
  20261106/
    train_list_20261106.json
    train_detail_20261106.json
    train_detail_G_20261106.json
    stopped.json
    stopped_detail.json
    summary.json
  .staging/                   # 上传暂存，整包成功后整体改名到 data/<date>/
  .trash/                     # 被替换的旧目录，定期清空
```

**发布顺序（保证"要么旧包、要么新包"）：**

1. 上传文件全部落到 `.staging/<date>-<随机>/`
2. 校验 `train_list_YYYYMMDD.json`、`train_detail_YYYYMMDD.json` 存在
3. `data/<date>/` 已存在则先移到 `.trash/`，再把暂存目录整体改名为 `data/<date>/`
4. 写入 `.latest.tmp` 后 `rename` 成 `latest.json`（原子替换）

第 4 步完成前，`latest.json` 始终指向上一份完整快照，爬虫不会读到半成品。

## 4. 参考实现（Node 20 + Express + multer）

```bash
npm i express multer
```

```js
// server.mjs
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(process.env.DATA_DIR ?? "./data");
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? ""; // 留空则输出 /data/... 相对地址
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN ?? "";
const LATEST_TOKEN = process.env.LATEST_TOKEN ?? UPLOAD_TOKEN;
const STAGE = path.join(ROOT, ".staging");
const TRASH = path.join(ROOT, ".trash");

await fs.mkdir(STAGE, { recursive: true });
await fs.mkdir(TRASH, { recursive: true });

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const bearer = (req) => (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
const guard = (token) => (req, res, next) =>
  token && !safeEqual(bearer(req), token) ? res.status(401).json({ error: "unauthorized" }) : next();

const app = express();
app.disable("x-powered-by");
const receive = multer({ dest: STAGE, limits: { fileSize: 300 * 1024 * 1024, files: 64 } });

app.post("/api/upload", guard(UPLOAD_TOKEN), receive.array("files"), async (req, res) => {
  const date = String(req.body?.snapshot_date ?? "");
  const files = req.files ?? [];
  if (!/^\d{8}$/.test(date)) {
    await Promise.allSettled(files.map((f) => fs.unlink(f.path)));
    return res.status(400).json({ error: "bad snapshot_date" });
  }

  const staging = path.join(STAGE, `${date}-${crypto.randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const file of files) {
      const name = path.basename(file.originalname);
      if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) throw new Error("bad filename");
      await fs.rename(file.path, path.join(staging, name));
    }
    await fs.access(path.join(staging, `train_list_${date}.json`));
    await fs.access(path.join(staging, `train_detail_${date}.json`));

    // 同一日期重跑：旧目录先挪走，再整体切换
    const target = path.join(ROOT, date);
    try {
      await fs.rename(target, path.join(TRASH, `${date}-${Date.now()}`));
    } catch {}
    await fs.rename(staging, target);

    const fileUrl = (name) => `${PUBLIC_BASE}/data/${date}/${name}`;
    const manifest = {
      snapshot_date: date,
      files: {
        train_list: fileUrl(`train_list_${date}.json`),
        train_detail: fileUrl(`train_detail_${date}.json`),
      },
    };
    for (const [key, name] of [["stopped", "stopped.json"], ["stopped_detail", "stopped_detail.json"]]) {
      try {
        await fs.access(path.join(target, name));
        manifest.files[key] = fileUrl(name);
      } catch {}
    }
    const tmp = path.join(ROOT, ".latest.tmp");
    await fs.writeFile(tmp, JSON.stringify(manifest));
    await fs.rename(tmp, path.join(ROOT, "latest.json")); // 指针原子切换

    console.log(`[upload] ${date} 已发布，${files.length} 个文件`); // 不打印地址与 token
    res.json({ ok: true, snapshot_date: date, received: files.length });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    console.error("[upload]", error.message);
    res.status(400).json({ error: "invalid package" });
  }
});

app.get("/api/latest", guard(LATEST_TOKEN), async (_req, res) => {
  try {
    res.type("application/json").send(await fs.readFile(path.join(ROOT, "latest.json"), "utf8"));
  } catch {
    res.status(404).json({ error: "no snapshot" });
  }
});

// 基线文件下载：只放行 /data/<YYYYMMDD>/<name>.json，且与 latest 同一 token
app.use(
  "/data/:date/:name",
  (req, res, next) =>
    /^\d{8}$/.test(req.params.date) && /\.json$/.test(req.params.name)
      ? next()
      : res.status(404).end(),
  guard(LATEST_TOKEN),
  express.static(ROOT, { index: false, dotfiles: "deny" }),
);

app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
```

## 5. 部署

环境变量：

```bash
DATA_DIR=/var/lib/train-data
PUBLIC_BASE=https://data.example.com
UPLOAD_TOKEN=<随机 32 字节以上>
LATEST_TOKEN=<随机 32 字节以上，可与 UPLOAD_TOKEN 相同>
PORT=3000
```

要点：

- 只监听 `127.0.0.1`，由 nginx/caddy 提供 HTTPS（爬虫的地址必须是 `https://`）
- 反向代理需放开上传体积与超时：

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  client_max_body_size 0;        # 全量包可能有几十 MB
  proxy_read_timeout 600s;
  proxy_request_buffering off;
}
```

- 磁盘保留策略：保留最近 14 个 `data/<date>/` 目录，**永远不要删 `latest.json` 指向的那一天**
- 定期清空 `.trash/`、清理 `.staging/` 中超过 1 天的残留
- 备份只需要 `latest.json` + 它指向的目录

## 6. 私有仓 `upload.json` 与 GitHub App

`upload.json`（放在私有仓，路径由 `CONFIG_PATH` 指定）：

```json
{
  "upload_url": "https://data.example.com/api/upload",
  "upload_token": "<UPLOAD_TOKEN>",
  "latest_url": "https://data.example.com/api/latest",
  "latest_token": "<LATEST_TOKEN>"
}
```

GitHub App：

1. 创建 App，权限只给 **Contents: Read-only**，安装到存放 `upload.json` 的私有仓
2. 生成私钥，写入仓库 Secret `GH_APP_PRIVATE_KEY`
3. 另配 Secret：`GH_APP_ID`、`GH_APP_INSTALLATION_ID`（可省略，省略时取第一个安装）、`CONFIG_REPO`（`owner/repo`）
4. 爬虫只在运行时换取 1 小时 installation token，token 不落盘、不进日志

## 7. 验收

```bash
# 还没有快照时应返回 404
curl -i -H "Authorization: Bearer $LATEST_TOKEN" https://data.example.com/api/latest

# 手工推一份最小包（从 dist 取真实文件）
curl -X POST https://data.example.com/api/upload \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -F snapshot_date=20261106 \
  -F files=@dist/train_list_20261106.json \
  -F files=@dist/train_detail_20261106.json

# 再查 latest，应指向刚上传的日期，且文件地址可直接带 token 下载
curl -H "Authorization: Bearer $LATEST_TOKEN" https://data.example.com/api/latest
```

第二天看 Actions 日志：出现 `[基线] 已读取服务端全量包 ...` 说明增量链路通了；出现 `[基线] 读取失败，将全量抓取详情` 则检查 `latest_url`、token 和文件地址。
