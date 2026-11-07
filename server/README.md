# 私有交付服务端（部署说明）

> 本文件包含私有交付契约（接口路径、字段、存储约定）。请只放在私有环境或私有仓，
> **不要提交到公开仓库**；当前仓库若为公开，请把本文件移到私有仓或加入 `.gitignore`。

## 1. 它要做什么

爬虫每天跑完后：

1. 用 GitHub App 临时 token 读取私有仓 `config/upload.json`，拿到 `upload_url` / `upload_token`
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
| 批量标识 | `batch_id`（每次运行一个 UUID），`file_index`（1 起），`file_total` |
| 每次请求 | 只带**一个** `files`（单文件），避免整包单请求超时 |
| 收尾请求 | 同一 `batch_id`，带 `finalize=1`，不带文件；服务端此时校验并发布 |
| 大文件分片 | 同一 `batch_id`，带 `chunk_of`（目标文件名）、`chunk_index`（1 起）、`chunk_total`，`files` 中放文件名 `<name>.json.p<index>` 的字节片段；服务端按序号拼接 |
| 文件 | 只传两个全量主文件：`train_list_YYYYMMDD.json`、`train_detail_YYYYMMDD.json` |
| 成功响应 | 任意 `2xx`，响应体不使用 |
| 失败 | `401` 鉴权失败、`400` 字段/文件不合法、`5xx` 服务端错误（爬虫按文件重试 3 次） |

兼容：不带 `batch_id` 时按旧协议处理，即一次请求提交整包并立即发布（对应配置 `upload_mode: "single"`）。

### 一次完整上传的请求顺序

```text
POST snapshot_date=20261106 batch_id=<uuid> file_index=1 file_total=2 files=train_list_20261106.json.gz
POST ... file_index=2 ... files=train_detail_20261106.json.gz   （大文件则走分片，见下）
POST snapshot_date=20261106 batch_id=<uuid> file_total=2 finalize=1
```

客户端会先 gzip 再传（39 MB 详情通常压到 4 MB 左右）。服务端把 `<name>.json.gz` 原样落盘，`finalize` 解压成 `<name>.json` 后再校验；旧客户端送 `.json` 也照常接受。

- 单文件失败只重传该文件，前面的文件保留在暂存目录
- 收尾前 `latest.json` 不变，任何中断都不会影响已有快照
- 客户端中途放弃时，暂存目录需按 TTL 清理（建议 24 小时）

### 大文件分片（避免 Cloudflare 524 / 网关 100s 超时）

压缩后超过 2 MB 的文件会拆成多个请求，单片失败只重传该片：

```text
POST snapshot_date=20261106 batch_id=<uuid> chunk_of=train_detail_20261106.json.gz
     chunk_index=1 chunk_total=3 files=train_detail_20261106.json.gz.p1
...
POST snapshot_date=20261106 batch_id=<uuid> file_total=2 finalize=1
```

- 分片以 `<name>.json.gz.p<index>` 落在 `.staging/<batch_id>/`
- `finalize` 时按序号拼回 `.json.gz`，再解压成 `.json`；序号必须连续（缺片返回 `400 invalid package`）
- 拼接和解压完成后才校验 `train_list`/`train_detail`，所以分片不影响原子发布
- 分片大小固定 2 MB（按压缩后字节计），不再随配置或失败调整
- 单个分片失败重试 6 次；仍失败则整批放弃，不会无限重传

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
  .staging/<batch_id>/        # 逐文件上传的暂存目录，finalize 成功后整体改名到 data/<date>/
  .trash/                     # 被替换的旧目录，定期清空
```

**发布顺序（保证"要么旧包、要么新包"）：**

1. 同一 `batch_id` 的文件逐个落到 `.staging/<batch_id>/`（单文件失败只影响这一个文件）
2. 收到 `finalize=1` 后校验文件数、`train_list_YYYYMMDD.json`、`train_detail_YYYYMMDD.json` 是否存在
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
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);
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

// 校验暂存目录为完整快照后，原子切换到 data/<date>/ 并更新 latest.json
const publishSnapshot = async (staging, date) => {
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
};

const moveUploaded = async (staging, files) => {
  await fs.mkdir(staging, { recursive: true });
  for (const file of files) {
    const name = path.basename(file.originalname);
    // 允许 .json（旧客户端）和 .json.gz（压缩客户端）
    if (!/^[A-Za-z0-9_.-]+\.json(\.gz)?$/.test(name)) throw new Error("bad filename");
    await fs.rename(file.path, path.join(staging, name));
  }
};
const discardTemp = (files) => Promise.allSettled(files.map((f) => fs.unlink(f.path)));

// 大文件分片：<name>.json.gz.p1、p2…，finalize 时按序号拼接后再解压
const PART_RE = /^(.+\.json(?:\.gz)?)\.p(\d+)$/;
const assembleChunks = async (staging) => {
  const bases = new Set();
  for (const name of await fs.readdir(staging)) {
    const match = PART_RE.exec(name);
    if (match) bases.add(match[1]);
  }
  for (const base of bases) {
    const parts = (await fs.readdir(staging))
      .map((name) => ({ match: PART_RE.exec(name), name }))
      .filter((item) => item.match && item.match[1] === base)
      .map((item) => ({ name: item.name, index: Number(item.match[2]) }))
      .sort((a, b) => a.index - b.index);
    parts.forEach((part, i) => {
      if (part.index !== i + 1) throw new Error(`missing chunk for ${base}`);
    });
    const target = path.join(staging, base);
    await fs.writeFile(target, "");
    for (const part of parts) {
      await fs.appendFile(target, await fs.readFile(path.join(staging, part.name)));
    }
    for (const part of parts) await fs.unlink(path.join(staging, part.name));
  }
};

// 拼接完成后再解压：train_detail_...json.gz → train_detail_...json，磁盘上只存原始 JSON
const gunzipStaged = async (staging) => {
  for (const name of await fs.readdir(staging)) {
    if (!name.endsWith(".json.gz")) continue;
    const target = path.join(staging, name.slice(0, -3));
    await fs.writeFile(target, await gunzipAsync(await fs.readFile(path.join(staging, name))));
    await fs.unlink(path.join(staging, name));
  }
};

app.post("/api/upload", guard(UPLOAD_TOKEN), receive.array("files"), async (req, res) => {
  const date = String(req.body?.snapshot_date ?? "");
  const files = req.files ?? [];
  if (!/^\d{8}$/.test(date)) {
    await discardTemp(files);
    return res.status(400).json({ error: "bad snapshot_date" });
  }

  const batchId = String(req.body?.batch_id ?? "").trim();

  // 兼容旧协议：没有 batch_id 就整包一次提交，立即发布
  if (!batchId) {
    const staging = path.join(STAGE, `${date}-${crypto.randomUUID()}`);
    try {
      await moveUploaded(staging, files);
      await publishSnapshot(staging, date);
      console.log(`[upload] ${date} 已发布（整包，${files.length} 个文件）`); // 不打印地址与 token
      return res.json({ ok: true, snapshot_date: date, received: files.length });
    } catch (error) {
      await discardTemp(files);
      await fs.rm(staging, { recursive: true, force: true });
      console.error("[upload]", error.message);
      return res.status(400).json({ error: "invalid package" });
    }
  }

  if (!/^[0-9a-f-]{36}$/i.test(batchId)) {
    await discardTemp(files);
    return res.status(400).json({ error: "bad batch_id" });
  }

  // 逐文件上传：先落 .staging/<batch_id>/，finalize=1 时才校验并发布
  const staging = path.join(STAGE, batchId);
  try {
    // 分片请求：只存 <name>.json.p<index>，不参与整包校验
    const chunkOf = String(req.body?.chunk_of ?? "").trim();
    if (chunkOf) {
      if (!/^[A-Za-z0-9_.-]+\.json(\.gz)?$/.test(chunkOf)) throw new Error("bad chunk_of");
      const index = Number(req.body?.chunk_index ?? 0);
      if (!Number.isInteger(index) || index <= 0) throw new Error("bad chunk_index");
      if (!files[0]) throw new Error("empty chunk");
      await fs.mkdir(staging, { recursive: true });
      await fs.rename(files[0].path, path.join(staging, `${chunkOf}.p${index}`));
      return res.json({ ok: true, snapshot_date: date, received: 1 });
    }

    await moveUploaded(staging, files);
    if (String(req.body?.finalize ?? "") !== "1") {
      return res.json({ ok: true, snapshot_date: date, received: files.length });
    }

    await assembleChunks(staging);
    await gunzipStaged(staging);
    const expected = Number(req.body?.file_total ?? 0);
    const staged = (await fs.readdir(staging)).filter((name) => !PART_RE.test(name));
    if (expected > 0 && staged.length < expected) {
      return res.status(400).json({ error: `incomplete batch: ${staged.length}/${expected}` });
    }
    await publishSnapshot(staging, date);
    console.log(`[upload] ${date} 已发布（batch ${batchId}，${staged.length} 个文件）`);
    res.json({ ok: true, snapshot_date: date, received: staged.length });
  } catch (error) {
    await discardTemp(files);
    console.error("[upload]", error.message); // 暂存目录保留，便于客户端重试或由 TTL 清理
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

`config/upload.json`（放在私有仓，路径由 `CONFIG_PATH` 指定，默认 `config/upload.json`）：

```json
{
  "upload_url": "https://data.example.com/api/upload",
  "upload_token": "<UPLOAD_TOKEN>",
  "latest_url": "https://data.example.com/api/latest",
  "latest_token": "<LATEST_TOKEN>",
  "upload_mode": "per_file"
}
```

`upload_mode` 默认 `per_file`（逐文件 + finalize）；服务端还是旧版整包接口时改成 `"single"`。

GitHub App：

1. 创建 App，权限只给 **Contents: Read-only**，安装到存放 `config/upload.json` 的私有仓
2. 在爬虫仓库配置：Variable `APP_CLIENT_ID`（App 的 Client ID）、Secret `APP_PRIVATE_KEY`（App 私钥）、Secret `CONFIG_REPO`（`owner/repo`）
3. Workflow 用 `actions/create-github-app-token@v3` 换取 1 小时 installation token（`client-id` 取 `vars.APP_CLIENT_ID`），再以 `GITHUB_APP_TOKEN` 传给爬虫
4. token 由 Action 自动掩码，代码只读环境变量，不打印、不落盘

## 7. 验收

```bash
# 还没有快照时应返回 404
curl -i -H "Authorization: Bearer $LATEST_TOKEN" https://data.example.com/api/latest

# 手工推一份最小包（旧整包协议，无 batch_id 时立即发布）
curl -X POST https://data.example.com/api/upload \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -F snapshot_date=20261106 \
  -F files=@dist/train_list_20261106.json \
  -F files=@dist/train_detail_20261106.json

# 逐文件协议：同一 batch_id 传完所有文件，再发 finalize
BATCH=$(uuidgen | tr 'A-Z' 'a-z')
curl -X POST https://data.example.com/api/upload \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -F snapshot_date=20261106 -F batch_id=$BATCH \
  -F file_index=1 -F file_total=2 \
  -F files=@dist/train_list_20261106.json
curl -X POST https://data.example.com/api/upload \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -F snapshot_date=20261106 -F batch_id=$BATCH \
  -F file_index=2 -F file_total=2 \
  -F files=@dist/train_detail_20261106.json
curl -X POST https://data.example.com/api/upload \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -F snapshot_date=20261106 -F batch_id=$BATCH \
  -F file_total=2 -F finalize=1

# 再查 latest，应指向刚上传的日期，且文件地址可直接带 token 下载
curl -H "Authorization: Bearer $LATEST_TOKEN" https://data.example.com/api/latest
```

第二天看 Actions 日志：出现 `[基线] 已读取服务端全量包 ...` 说明增量链路通了；出现 `[基线] 读取失败，将全量抓取详情` 则检查 `latest_url`、token 和文件地址。
