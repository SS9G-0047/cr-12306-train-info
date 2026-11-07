import crypto from "crypto";
import fs from "fs";
import path from "path";

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
};

const CONFIG_REPO = process.env.CONFIG_REPO ?? "";
const CONFIG_PATH = process.env.CONFIG_PATH ?? "upload.json";
const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const APP_ID = process.env.GH_APP_ID ?? "";
// 兼容 secret 中以字面量 \n 存放的 PEM
const APP_PRIVATE_KEY = (process.env.GH_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const INSTALLATION_ID = process.env.GH_APP_INSTALLATION_ID ?? "";
const USER_AGENT = "cr-12306-train-info-delivery";
const UPLOAD_MAX_ATTEMPTS = 3;

/** 过程增量文件，不属于全量包 */
const PROCESS_ONLY_JSON = new Set([
  "new.json",
  "new_detail.json",
  "stop_temp.json",
  "stop_temp_detail.json",
]);

let cachedConfig: DeliveryConfig | null = null;
let pendingConfig: Promise<DeliveryConfig> | null = null;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

const ghHeaders = (
  bearer: string,
  accept = "application/vnd.github+json",
): Record<string, string> => ({
  Accept: accept,
  Authorization: `Bearer ${bearer}`,
  "User-Agent": USER_AGENT,
  "X-GitHub-Api-Version": "2022-11-28",
});

/** 在 Actions 中把运行时凭据登记为掩码，避免出现在日志里 */
const maskIfActions = (value: string): void => {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
};

export const hasDeliveryCredentials = (): boolean =>
  Boolean(APP_ID && APP_PRIVATE_KEY && CONFIG_REPO);

/** 用 GitHub App 私钥签 RS256 JWT（Node 内置 crypto，无额外依赖） */
const createAppJwt = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: APP_ID }),
  );
  const data = `${header}.${payload}`;
  const signature = base64url(
    crypto.sign("sha256", Buffer.from(data), APP_PRIVATE_KEY),
  );
  return `${data}.${signature}`;
};

/** GitHub App JWT 换取 1 小时有效的 installation token */
const createInstallationToken = async (): Promise<string> => {
  const jwt = createAppJwt();
  let installationId = INSTALLATION_ID;

  if (!installationId) {
    const rsp = await fetch(`${GITHUB_API}/app/installations?per_page=100`, {
      headers: ghHeaders(jwt),
      signal: AbortSignal.timeout(30_000),
    });
    if (!rsp.ok) {
      throw new Error(`[交付] 查询 GitHub App 安装失败 HTTP ${rsp.status}`);
    }
    const list: unknown = await rsp.json();
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("[交付] GitHub App 没有任何安装实例");
    }
    const first = list[0] as { id?: unknown };
    if (typeof first?.id !== "number") {
      throw new Error("[交付] GitHub App 安装实例缺少 id");
    }
    installationId = String(first.id);
    if (list.length > 1) {
      console.log(
        `[交付] GitHub App 有 ${list.length} 个安装实例，使用第一个；建议配置 GH_APP_INSTALLATION_ID`,
      );
    }
  }

  const rsp = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: ghHeaders(jwt), signal: AbortSignal.timeout(30_000) },
  );
  if (!rsp.ok) {
    throw new Error(`[交付] 申请 installation token 失败 HTTP ${rsp.status}`);
  }
  const body = (await rsp.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw new Error("[交付] installation token 响应格式无效");
  }
  maskIfActions(body.token);
  return body.token;
};

/** 读取私有仓中的 upload.json（只在内存中使用，不落盘、不打印内容） */
const loadConfig = async (): Promise<DeliveryConfig> => {
  if (!hasDeliveryCredentials()) {
    throw new Error(
      "[交付] 缺少 GH_APP_ID / GH_APP_PRIVATE_KEY / CONFIG_REPO，无法读取私有仓配置",
    );
  }
  const token = await createInstallationToken();
  const encodedPath = CONFIG_PATH.split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const rsp = await fetch(
    `${GITHUB_API}/repos/${CONFIG_REPO}/contents/${encodedPath}`,
    {
      headers: ghHeaders(token, "application/vnd.github.raw+json"),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!rsp.ok) {
    throw new Error(`[交付] 读取私有仓配置失败 HTTP ${rsp.status}`);
  }
  const text = await rsp.text();

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
  console.log(
    `[交付] 已读取私有仓配置：upload_url 已配置，latest_url ${latestUrl ? "已配置" : "未配置"}`,
  );
  return {
    uploadUrl: config.upload_url,
    uploadToken: config.upload_token,
    latestUrl,
    latestToken,
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

/** 本次全量包只包含全量 JSON，排除 new / stop_temp 等过程产物 */
const selectFullPackageFiles = (distDir: string): string[] =>
  fs
    .readdirSync(distDir)
    .filter((name) => name.endsWith(".json") && !PROCESS_ONLY_JSON.has(name))
    .sort();

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把本次全量 JSON 以 multipart/form-data POST 到交付服务端。
 * 表单字段：snapshot_date、files（同名重复，filename 为文件名）。
 */
export const uploadFullPackage = async (
  distDir: string,
  snapshotDate: string,
): Promise<void> => {
  const config = await getConfig();
  const files = selectFullPackageFiles(distDir);
  if (
    !files.includes(`train_list_${snapshotDate}.json`) ||
    !files.includes(`train_detail_${snapshotDate}.json`)
  ) {
    throw new Error("[交付] dist 中缺少本次全量车次列表或车次详情 JSON");
  }

  const totalBytes = files.reduce(
    (sum, name) => sum + fs.statSync(path.join(distDir, name)).size,
    0,
  );
  console.log(
    `[交付] 准备上传 ${files.length} 个全量 JSON（${(totalBytes / 1024 / 1024).toFixed(2)} MB）`,
  );

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
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
    try {
      const rsp = await fetch(config.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.uploadToken}`,
          "User-Agent": USER_AGENT,
          "X-Snapshot-Date": snapshotDate,
        },
        body: form,
        signal: AbortSignal.timeout(600_000),
      });
      if (!rsp.ok) {
        throw new Error(`HTTP ${rsp.status}`);
      }
      console.log(
        `[交付] 全量包上传成功（${files.length} 个文件，${(totalBytes / 1024 / 1024).toFixed(2)} MB）`,
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === UPLOAD_MAX_ATTEMPTS) {
        throw new Error(
          `[交付] 全量包上传失败（已尝试 ${UPLOAD_MAX_ATTEMPTS} 次）：${message}`,
        );
      }
      const delay = 2 ** attempt * 1000;
      console.log(
        `[交付] 第 ${attempt} 次上传失败：${message}，${delay / 1000}s 后重试`,
      );
      await wait(delay);
    }
  }
};
