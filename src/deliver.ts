import path from "path";
import { uploadFullPackage } from "./services/delivery";

/**
 * 只做交付、不抓取：从已存在的 dist（本地或 Release 下载）上传两个全量 JSON。
 * 用法：DELIVERY_DATE=20261120 npm run deliver
 */
const main = async (): Promise<void> => {
  const date = (process.env.DELIVERY_DATE ?? "").trim();
  if (!/^\d{8}$/.test(date)) {
    throw new Error("[交付] 缺少或非法的 DELIVERY_DATE（YYYYMMDD）");
  }
  await uploadFullPackage(path.join(process.cwd(), "dist"), date);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
