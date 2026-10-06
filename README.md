# cr-12306-train-info

从国铁 12306 搜索接口拉取车次列表与车次详情，并落盘为 JSON / Markdown。

## 功能

- **车次列表抓取**：按车次等级（G/D/C/K/Z/T/Y/S）与数字前缀递归查询覆盖所有车次，单次返回少于 200 条视为该前缀已完整并立即持久化
- **并发控制**：车次详情查询通过任务调度器 `TaskScheduler` 自适应调整并发（范围 2 ~ 6），成功率高自动提速，失败率高自动降速，任务启动随机延迟降低被识别概率
- **失败重试**：请求失败会进入失败队列，在主抓取结束后按轮重试，最多 5 轮
- **车次详情增量更新**：先读取当前仓库最近的 `data-YYYYMMDD` Release，比较前后 `station_train_code` 集合；变化（新增与移除代码数之和）达到上一 Release 代码总数的 10% 时全量重抓，低于 10% 时仅重新查询变化车次。运行日志会输出变化数、比例和抓取模式；没有历史数据时全量抓取
- **停运车次保留**：从本次列表消失的车次会从活动详情 JSON 移除，车次信息写入 `stopped.json`、详情写入 `stopped_detail.json`；两周内重新出现时直接复用已保存详情，连续两周未出现则从停运文件永久删除
- **车次详情最终失败补偿**：当车次详情接口在重试结束后仍失败，会尝试从 HerbertHe 仓库前一日 Release 的 `train_detail_YYYYMMDD.json` 拉取数据，按 `train_no` 相同进行补偿回填（补偿日口径为「当前日期 + 13 天」的前一日，即 `targetDate - 1 day`）
- **代理池优化**：动态淘汰连接失败/超时的代理，只移除真正失效的代理，保持代理池质量；不同请求使用随机浏览器 User-Agent 降低被拦截概率
- **空结果重试**：空响应会重试确认，避免因临时限流导致的数据丢失
- **车次列表输出**（去重后按车号聚合、按车次类型排序）：
  - 车次列表 JSON：`dist/train_list_YYYYMMDD.json`
  - 车次列表 Markdown：`dist/train_list_YYYYMMDD.md`
  - 相较最近 Release 新增的车次：`dist/new.json`（按 `train_no` 比较，包含该车号对应的站点车次记录）
  - 新增车次详情：`dist/new_detail.json`
- **车次详情抓取与输出**（按去重后的车号逐个请求、站点名自动去空格）：
  - 车次详情 JSON：`dist/train_detail_YYYYMMDD.json`
  - 车次详情 Markdown：`dist/train_detail_YYYYMMDD.md`
- **停运车次输出**：`dist/stopped.json`（停运车次及停运时间）、`dist/stopped_detail.json`（对应详情）
- **运行报告**：
  - GitHub Pages：`dist/README.md`
  - 统计摘要：`dist/summary.json`（用于 GitHub Action 写入 release 描述）

## 环境与运行

- Node.js + TypeScript（使用 `tsx` 直接运行 TS）
- 安装依赖：`npm install`
- 运行爬虫：`npm run dev`

## 说明

- **查询日期**：默认为「当前日期 + 13 天」，格式为 `YYYYMMDD`
  - 日期用于调用 12306 接口
  - 同时会拼接到输出文件名中（如 `train_list_20260318.json`）
- **并发与任务调度**：
  - **车次详情查询**：通过 `TaskScheduler` 统一调度，默认并发范围为 2 ~ 6，自适应调整：成功率 > 95% 增加并发，< 80% 减少并发
  - 每个任务启动随机延迟 200 ~ 800ms，降低被识别为爬虫概率
  - 如需调整并发范围可修改 `src/index.ts` 中的 `new TaskScheduler(6, 2)`
- **代理与网络**：
  - 支持通过 `HttpsProxyAgent` 使用代理，代理池逻辑在 `src/utils/request.ts` 中
  - 需可访问 12306 搜索接口；在受限网络环境下建议配置可用的 HTTP 代理
- **容错保证**：请求异常时仍会生成 `dist` 目录和采集报告；若车次列表请求经过重试后仍失败，程序会停止数据处理，避免将不完整列表误判为停运车次

## 统计口径（summary.json / Pages / Release）

`dist/summary.json` 的关键字段说明：

- **`trainList`**：车次列表接口统计（按 HTTP 请求次数统计）
  - `requested`：请求次数（包含重试过程中每一次实际发起的请求）
  - `success`：HTTP 响应成功次数
  - `failed`：最终进入“永久失败队列”的条目数
- **`trainDetail`**：车次详情接口统计 + 补偿统计
  - `requested / success / failed`：同上（按 HTTP 请求次数统计）
  - `compensated`：从前一日 Release 的 `train_detail_YYYYMMDD.json` 里按 `train_no` 命中并回填的条数（按车号条目统计）
  - `reusedFromPreviousRelease`：未变化、直接复用最近 Release 详情的条数
  - `plannedDistinctTrainNumbers`：本次计划获取的去重后车号数（即当日列表去重后的 `train_no` 数）
  - `distinctTrainsFilledByApi`：车次详情接口成功返回并落盘的条目数（按车号条目统计）
  - `distinctTrainsStillMissingAfterCompensation`：补偿后仍缺失详情的车号数

## 技能

本项目提供了 `fetch-daily-train-info` 技能用于从 GitHub Release **获取指定日期** 的车次数据，详细使用方法请参考：`skills/fetch-daily-train-info/SKILL.md`

主要特性：

- 必须由客户提供具体日期（YYYYMMDD 格式），不支持自动获取
- 下载后检查文件是否为空，为空则立即提示错误并不再执行后续步骤
- 过滤结果输出后，在回答末尾告知客户获取到的车次总数

## 免责声明

本项目仅供学习交流使用，请勿用于任何商业或非法用途。  
使用本项目时须遵守国家及地区的相关法律法规以及 12306 等网站的使用条款，由此产生的一切后果由使用者自行承担。
