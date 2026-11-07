import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

/**
 * 交付服务端回读的上一份全量包（原始 JSON，由调用方做业务校验）
 */
export type DeliveryBaseline = {
  snapshotDate: string;
  trainListPayload: unknown;
  trainDetailsPayload: unknown;
  stoppedPayload: unknown;
  stoppedDetailsPayload: unknown;
};

type DeliveryConfig = {
  uploadUrl: string;
  uploadToken: string;
  latestUrl?: string;
  latestToken?: string;
  /** per_file（默认，逐个文件上传后 finalize）或 single（整包单请求，兼容旧服务端） */
  uploadMode: "per_file" | "single";
  /** 大文件分片大小（MB），默认 4；小于该值的文件仍单请求上传 */
  chunkSizeMb: number;
};

const CONFIG_REPO = (process.env.CONFIG_REPO ?? "").trim();
// 允许 CONFIG_PATH 写成 ./config/upload.json 或带反斜杠
const CONFIG_PATH =
  (process.env.CONFIG_PATH ?? "config/upload.json")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "") || "config/upload.json";
const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";
// 由 actions/create-github-app-token 以 App 身份换取；代码不再自行签发 JWT
const APP_TOKEN = process.env.GITHUB_APP_TOKEN ?? "";
const USER_AGENT = "cr-12306-train-info-delivery";
const UPLOAD_MAX_ATTEMPTS = 3;

let cachedConfig: DeliveryConfig | null = null;
let pendingConfig: Promise<DeliveryConfig> | null = null;

const ghHeaders = (
  bearer: string,
  accept = "application/vnd.github+json",
): Record<string, string> => ({
  Accept: accept,
  Authorization: `Bearer ${bearer}`,
  "User-Agent": USER_AGENT,
  "X-GitHub-Api-Version": "2022-11-28",
});

export const hasDeliveryCredentials = (): boolean =>
  Boolean(APP_TOKEN && CONFIG_REPO);

/** 读取私有仓中的 upload.json（只在内存中使用，不落盘、不打印内容） */
const loadConfig = async (): Promise<DeliveryConfig> => {
  if (!hasDeliveryCredentials()) {
    throw new Error(
      "[交付] 缺少 GITHUB_APP_TOKEN 或 CONFIG_REPO，无法读取私有仓配置（token 应由 actions/create-github-app-token 提供）",
    );
  }
  const readRepoFile = async (filePath: string): Promise<string | null> => {
    const encodedPath = filePath
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    const rsp = await fetch(
      `${GITHUB_API}/repos/${CONFIG_REPO}/contents/${encodedPath}`,
      {
        headers: ghHeaders(APP_TOKEN, "application/vnd.github.raw+json"),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (rsp.status === 404) return null;
    if (!rsp.ok) {
      throw new Error(
        `[交付] 读取私有仓配置失败 HTTP ${rsp.status}（${CONFIG_REPO}/${filePath}）`,
      );
    }
    return rsp.text();
  };

  // 配置约定在 config/upload.json；兼容旧布局，找不到时再试仓库根目录的 upload.json
  const candidates =
    CONFIG_PATH === "upload.json" ? [CONFIG_PATH] : [CONFIG_PATH, "upload.json"];
  let text: string | null = null;
  let usedPath = CONFIG_PATH;
  for (const candidate of candidates) {
    text = await readRepoFile(candidate);
    if (text !== null) {
      usedPath = candidate;
      break;
    }
  }
  if (text === null) {
    throw new Error(
      `[交付] 私有仓 ${CONFIG_REPO} 中找不到配置 ${CONFIG_PATH}（HTTP 404）：请确认 CONFIG_REPO、CONFIG_PATH，以及 App 已安装到该仓并获得 Contents: read`,
    );
  }
  if (usedPath !== CONFIG_PATH) {
    console.log(`[交付] ${CONFIG_PATH} 不存在，已回退到 ${usedPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("[交付] 私有仓配置不是合法 JSON");
  }
  const config = parsed as {
    upload_url?: unknown;
    upload_token?: unknown;
    latest_url?: unknown;
    latest_token?: unknown;
    upload_mode?: unknown;
    chunk_size_mb?: unknown;
  };
  if (
    typeof config?.upload_url !== "string" ||
    !config.upload_url ||
    typeof config?.upload_token !== "string" ||
    !config.upload_token
  ) {
    throw new Error("[交付] 私有仓配置缺少 upload_url 或 upload_token");
  }
  const latestUrl =
    typeof config.latest_url === "string" && config.latest_url
      ? config.latest_url
      : undefined;
  const latestToken =
    typeof config.latest_token === "string" && config.latest_token
      ? config.latest_token
      : undefined;
  // 默认逐文件上传；旧服务端只支持整包单请求时配置 upload_mode: "single"
  const uploadMode: "per_file" | "single" =
    config.upload_mode === "single" ? "single" : "per_file";
  const rawChunkSize = Number(config.chunk_size_mb);
  const chunkSizeMb = Number.isFinite(rawChunkSize) && rawChunkSize > 0 ? rawChunkSize : 4;
  console.log(
    `[交付] 已读取私有仓配置 ${CONFIG_REPO}/${usedPath}：upload_mode=${uploadMode}，latest_url ${latestUrl ? "已配置" : "未配置"}`,
  );
  return {
    uploadUrl: config.upload_url,
    uploadToken: config.upload_token,
    latestUrl,
    latestToken,
    uploadMode,
    chunkSizeMb,
  };
};

const getConfig = async (): Promise<DeliveryConfig> => {
  if (cachedConfig) return cachedConfig;
  if (!pendingConfig) {
    pendingConfig = loadConfig()
      .then((config) => {
        cachedConfig = config;
        return config;
      })
      .finally(() => {
        pendingConfig = null;
      });
  }
  return pendingConfig;
};

const normalizeSnapshotDate = (value: unknown): string | null => {
  const digits = String(value ?? "").replace(/[-/.]/g, "");
  return /^\d{8}$/.test(digits) ? digits : null;
};

const resolveAssetUrl = (baseUrl: string, value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
};

/** 下载基线 JSON，错误只保留状态码，不回显地址 */
const downloadJson = async (
  url: string,
  headers: Record<string, string>,
): Promise<unknown> => {
  const rsp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (!rsp.ok) {
    throw new Error(`HTTP ${rsp.status}`);
  }
  return rsp.json();
};

/**
 * 回读上一份全量包。
 * upload.json 需提供 latest_url，其返回清单格式：
 * { "snapshot_date": "YYYYMMDD", "files": { "train_list": "...", "train_detail": "...", "stopped": "...", "stopped_detail": "..." } }
 * files 中的地址可为绝对地址，也可为相对 latest_url 的地址。
 * 任何一步不可用都返回 null，由调用方回落全量抓取。
 */
export const fetchBaseline = async (): Promise<DeliveryBaseline | null> => {
  if (!hasDeliveryCredentials()) {
    console.log("[基线] 未配置 GitHub App 凭据，将全量抓取详情");
    return null;
  }
  try {
    const config = await getConfig();
    if (!config.latestUrl) {
      console.log("[基线] 私有仓配置未提供 latest_url，将全量抓取详情");
      return null;
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (config.latestToken) {
      headers.Authorization = `Bearer ${config.latestToken}`;
    }

    const rsp = await fetch(config.latestUrl, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (!rsp.ok) {
      console.log(
        `[基线] 读取上一份全量包清单失败 HTTP ${rsp.status}，将全量抓取详情`,
      );
      return null;
    }
    const manifest = (await rsp.json()) as {
      snapshot_date?: unknown;
      files?: unknown;
    };
    const snapshotDate = normalizeSnapshotDate(manifest?.snapshot_date);
    if (!snapshotDate) {
      console.log("[基线] 清单缺少合法的 snapshot_date，将全量抓取详情");
      return null;
    }
    if (
      !manifest?.files ||
      typeof manifest.files !== "object" ||
      Array.isArray(manifest.files)
    ) {
      console.log("[基线] 清单缺少 files 映射，将全量抓取详情");
      return null;
    }
    const files = manifest.files as Record<string, unknown>;
    const trainListUrl = resolveAssetUrl(config.latestUrl, files.train_list);
    const trainDetailsUrl = resolveAssetUrl(config.latestUrl, files.train_detail);
    if (!trainListUrl || !trainDetailsUrl) {
      console.log("[基线] 清单缺少 train_list 或 train_detail 地址，将全量抓取详情");
      return null;
    }
    const stoppedUrl = resolveAssetUrl(config.latestUrl, files.stopped);
    const stoppedDetailUrl = resolveAssetUrl(
      config.latestUrl,
      files.stopped_detail,
    );

    const [
      trainListPayload,
      trainDetailsPayload,
      stoppedPayload,
      stoppedDetailsPayload,
    ] = await Promise.all([
      downloadJson(trainListUrl, headers),
      downloadJson(trainDetailsUrl, headers),
      stoppedUrl ? downloadJson(stoppedUrl, headers) : Promise.resolve([]),
      stoppedDetailUrl
        ? downloadJson(stoppedDetailUrl, headers)
        : Promise.resolve([]),
    ]);

    if (
      !Array.isArray(trainListPayload) ||
      !Array.isArray(trainDetailsPayload) ||
      trainListPayload.length === 0 ||
      trainDetailsPayload.length === 0 ||
      !Array.isArray(stoppedPayload) ||
      !Array.isArray(stoppedDetailsPayload)
    ) {
      console.log("[基线] 全量包内容不完整，将全量抓取详情");
      return null;
    }

    console.log(
      `[基线] 已读取服务端全量包 ${snapshotDate}：车次列表 ${trainListPayload.length} 条，详情 ${trainDetailsPayload.length} 条，停运 ${stoppedPayload.length} 条`,
    );
    return {
      snapshotDate,
      trainListPayload,
      trainDetailsPayload,
      stoppedPayload,
      stoppedDetailsPayload,
    };
  } catch (error) {
    console.log(
      "[基线] 读取失败，将全量抓取详情：",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};

/** 交付只发送两个全量主文件：车次列表与车次详情 */
const selectFullPackageFiles = (snapshotDate: string): string[] => [
  `train_list_${snapshotDate}.json`,
  `train_detail_${snapshotDate}.json`,
];

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 单个文件 15 分钟、整包单请求 10 分钟、finalize 2 分钟 */
const PER_FILE_TIMEOUT_MS = 900_000;
const SINGLE_TIMEOUT_MS = 600_000;
const FINALIZE_TIMEOUT_MS = 120_000;
/** 网关持续超时时分片可以缩到的最小粒度 */
const MIN_CHUNK_BYTES = 256 * 1024;

const postForm = async (
  config: DeliveryConfig,
  form: FormData,
  snapshotDate: string,
  timeoutMs: number,
): Promise<void> => {
  const rsp = await fetch(config.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.uploadToken}`,
      "User-Agent": USER_AGENT,
      "X-Snapshot-Date": snapshotDate,
    },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!rsp.ok) {
    const detail = await rsp.text().catch(() => "");
    // 网关错误页（如 Cloudflare 524）是 HTML，截断也没意义，只保留状态码
    const snippet =
      detail && !detail.trimStart().startsWith("<")
        ? ` ${detail.slice(0, 200)}`
        : "";
    throw new Error(`HTTP ${rsp.status}${snippet}`);
  }
};

/** 网关超时（如 Cloudflare 524）标记：不重试同一分片，交给外层缩小分片重传 */
const SLOW_GATEWAY = "slowGateway";

const isSlowGateway = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      (error as Record<string, unknown>)[SLOW_GATEWAY] === true,
  );

const isGatewayTimeout = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /\b524\b/.test(message) || /timed out|timeout|aborted/i.test(message);
};

const markSlowGateway = <T>(error: T): T => {
  if (error && typeof error === "object") {
    (error as Record<string, unknown>)[SLOW_GATEWAY] = true;
  }
  return error;
};

/** 上传阶段专用：遇到网关超时立刻抛出，避免原地重试浪费时间 */
const uploadRequest = async (
  config: DeliveryConfig,
  form: FormData,
  snapshotDate: string,
  timeoutMs: number,
): Promise<void> => {
  try {
    await postForm(config, form, snapshotDate, timeoutMs);
  } catch (error) {
    if (isGatewayTimeout(error)) throw markSlowGateway(error);
    throw error;
  }
};

const withRetry = async (
  label: string,
  action: () => Promise<void>,
): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await action();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSlowGateway(error)) throw error;
      if (attempt >= UPLOAD_MAX_ATTEMPTS) {
        throw new Error(
          `[交付] ${label} 失败（已尝试 ${UPLOAD_MAX_ATTEMPTS} 次）：${message}`,
        );
      }
      const delay = 2 ** attempt * 1000;
      console.log(
        `[交付] ${label} 第 ${attempt} 次失败：${message}，${delay / 1000}s 后重试`,
      );
      await wait(delay);
    }
  }
};

/**
 * 把本次全量 JSON 以 multipart/form-data 上传到交付服务端。
 *
 * per_file：一个请求只带一个文件（snapshot_date / batch_id / file_index / file_total），
 * 全部传完后单独发 finalize=1，由服务端校验并原子发布。避免整包单请求超时。
 * single：兼容旧服务端，整包一次 POST。
 */
export const uploadFullPackage = async (
  distDir: string,
  snapshotDate: string,
): Promise<void> => {
  const config = await getConfig();
  const files = selectFullPackageFiles(snapshotDate);
  const missing = files.filter(
    (name) => !fs.existsSync(path.join(distDir, name)),
  );
  if (missing.length > 0) {
    throw new Error(`[交付] dist 中缺少 ${missing.join("、")}`);
  }

  const totalBytes = files.reduce(
    (sum, name) => sum + fs.statSync(path.join(distDir, name)).size,
    0,
  );
  console.log(
    `[交付] 准备上传 ${files.length} 个全量 JSON（${(totalBytes / 1024 / 1024).toFixed(2)} MB，upload_mode=${config.uploadMode}）`,
  );

  if (config.uploadMode === "per_file") {
    const startedAt = Date.now();
    const initialChunkBytes = Math.max(
      MIN_CHUNK_BYTES,
      Math.round(config.chunkSizeMb * 1024 * 1024),
    );
    let chunkBytes = initialChunkBytes;

    const uploadFile = async (
      batchId: string,
      index: number,
      name: string,
    ): Promise<void> => {
      const content = fs.readFileSync(path.join(distDir, name));
      const megabytes = (content.byteLength / 1024 / 1024).toFixed(2);
      const chunkTotal = Math.ceil(content.byteLength / chunkBytes);

      if (chunkTotal <= 1) {
        console.log(
          `[交付] 上传 ${index + 1}/${files.length} ${name}（${megabytes} MB）`,
        );
        await withRetry(`上传 ${name}`, async () => {
          const form = new FormData();
          form.append("snapshot_date", snapshotDate);
          form.append("batch_id", batchId);
          form.append("file_index", String(index + 1));
          form.append("file_total", String(files.length));
          form.append(
            "files",
            new Blob([new Uint8Array(content)], { type: "application/json" }),
            name,
          );
          await uploadRequest(config, form, snapshotDate, PER_FILE_TIMEOUT_MS);
        });
        return;
      }

      // 大文件按 chunkBytes 切片，单片独立请求，避免代理 100s 超时（如 Cloudflare 524）
      const sizeLabel = (chunkBytes / 1024 / 1024).toFixed(2).replace(/\.?0+$/, "");
      console.log(
        `[交付] 上传 ${index + 1}/${files.length} ${name}（${megabytes} MB，分 ${chunkTotal} 片，每片 ${sizeLabel} MB）`,
      );
      for (let part = 1; part <= chunkTotal; part++) {
        const start = (part - 1) * chunkBytes;
        const slice = content.subarray(
          start,
          Math.min(start + chunkBytes, content.byteLength),
        );
        const blob = new Blob([new Uint8Array(slice)], {
          type: "application/octet-stream",
        });
        await withRetry(`上传 ${name} 分片 ${part}/${chunkTotal}`, async () => {
          const form = new FormData();
          form.append("snapshot_date", snapshotDate);
          form.append("batch_id", batchId);
          form.append("chunk_of", name);
          form.append("chunk_index", String(part));
          form.append("chunk_total", String(chunkTotal));
          form.append("chunk", blob, `${name}.p${part}`);
          await uploadRequest(config, form, snapshotDate, PER_FILE_TIMEOUT_MS);
        });
      }
    };

    const sendBatch = async (): Promise<void> => {
      const batchId = randomUUID();
      for (const [index, name] of files.entries()) {
        await uploadFile(batchId, index, name);
      }
      // 收尾失败不缩小分片重传（数据可能已发布），只按原样重试
      await withRetry("提交全量包", async () => {
        const form = new FormData();
        form.append("snapshot_date", snapshotDate);
        form.append("batch_id", batchId);
        form.append("file_total", String(files.length));
        form.append("finalize", "1");
        await postForm(config, form, snapshotDate, FINALIZE_TIMEOUT_MS);
      });
    };

    // 网关超时且分片已到下限时放弃；否则分片减半、换新 batch_id 重传
    for (;;) {
      try {
        await sendBatch();
        break;
      } catch (error) {
        if (!isSlowGateway(error) || chunkBytes <= MIN_CHUNK_BYTES) throw error;
        chunkBytes = Math.max(MIN_CHUNK_BYTES, Math.floor(chunkBytes / 2));
        const sizeLabel = (chunkBytes / 1024 / 1024)
          .toFixed(2)
          .replace(/\.?0+$/, "");
        console.log(
          `[交付] 网关超时，分片缩小到 ${sizeLabel} MB，用新批次重传`,
        );
      }
    }

    console.log(
      `[交付] 全量包上传成功（${files.length} 个文件，${(totalBytes / 1024 / 1024).toFixed(2)} MB，分片 ${(chunkBytes / 1024 / 1024).toFixed(2).replace(/\.?0+$/, "")} MB，耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s）`,
    );
    return;
  }

  await withRetry("整包上传", async () => {
    // 每次重试重建表单，避免上一次超时后 body 已被消费
    const form = new FormData();
    form.append("snapshot_date", snapshotDate);
    for (const name of files) {
      const content = fs.readFileSync(path.join(distDir, name));
      form.append(
        "files",
        new Blob([new Uint8Array(content)], { type: "application/json" }),
        name,
      );
    }
    await postForm(config, form, snapshotDate, SINGLE_TIMEOUT_MS);
  });

  console.log(
    `[交付] 全量包上传成功（${files.length} 个文件，${(totalBytes / 1024 / 1024).toFixed(2)} MB）`,
  );
};
