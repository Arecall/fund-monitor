# 全球基金与股票监控终端 (Fund & Stock Monitor)

[![Version](https://img.shields.io/badge/version-1.4.8-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)
[![React](https://img.shields.io/badge/react-19.2.7-61dafb.svg)](package.json)
[![Ant%20Design](https://img.shields.io/badge/antd-6.6.0-1890ff.svg)](package.json)

一款轻量级、高颜值、支持多用户数据隔离的**全球资产轻量监控终端**。支持国内公募场外基金、A股/港股/美股股票及 ETF、QDII 跨国基金以及全球大盘指数与贵金属黄金行情的实时追踪、持仓盈亏自动计算及邮箱预警提醒。

---

## 目录

- [一、项目简介与核心亮点](#一项目简介与核心亮点)
- [二、系统架构与技术栈](#二系统架构与技术栈)
  - [1. 前后端技术栈](#1-前后端技术栈)
  - [2. 实时行情与图表流式架构 (SSE Streaming Architecture)](#2-实时行情与图表流式架构-sse-streaming-architecture)
  - [3. 多源跨国行情路由与降级策略](#3-多源跨国行情路由与降级策略)
- [三、核心功能模块](#三核心功能模块)
- [四、部署环境要求](#四部署环境要求)
- [五、快速部署方式指南](#五快速部署方式指南)
  - [方式一：Docker Compose 一键部署（推荐）](#方式一docker-compose-一键部署推荐)
  - [方式二：Docker 单容器部署](#方式二docker-单容器部署)
  - [方式三：PM2 / Node.js 源码部署](#方式三pm2--nodejs-源码部署)
  - [方式四：本地开发环境运行](#方式四本地开发环境运行)
- [六、环境变量说明](#六环境变量说明)
- [七、Nginx 反向代理与 SSE 配置](#七nginx-反向代理与-sse-配置)
- [八、数据持久化与运维维护](#八数据持久化与运维维护)

---

## 一、项目简介与核心亮点

传统的理财与证券 APP 操作相对繁琐且不适合办公环境下的轻量“摸鱼式”盯盘，同时第三方理财软件存在个人资产数据上传的隐私隐患。**全球基金与股票监控终端**旨在提供一个现代化、隐私安全、视觉优雅的监控工作台：

1. **全球市场全覆盖**：
   - **国内公募场外基金**：官方净值与交易日内实时估值算速。
   - **场内股票与 ETF**：支持 A股、港股、美股（含 QDII 跨国基金）秒级实时行情跳动。
   - **全球大盘指数**：实时监控上证指数、深证成指、创业板指、恒生指数、标普500、纳斯达克等。
   - **黄金行情专区**：实时追踪伦敦金、国际金价、国内纸黄金/实物金价格及跨国交易时段识别。
2. **现代金融终端视觉（Ant Design 6.x & Apple Design）**：
   - 全面引入 **Ant Design 6.x** 组件库（`Statistic` 极简数字排版、`Tag` 市场标识、`BorderBeam` 流光边框、`Spin` 加载动画）。
   - **金融终端级横向通栏卡片**：精致的指标归纳与对齐，媲美 Wind / Choice / 雪球 终端。
   - **PC 端全屏 Dashboard 模式**：支持右侧 Drawer 详情抽屉（`640px`）与 `100vw` 全屏大屏走势图自由切换。
3. **SSE 实时推流与优雅降级**：
   - 采用 **Server-Sent Events (SSE)** 管道推送价格变更，同一帧合并渲染，避免无谓全树刷新。
   - 休市自动暂停轮询、上游故障自动降级与代理标的兜底算法。
4. **持仓与盈亏自动统计**：
   - 支持买入/补仓、减仓卖出、直接重置持仓。
   - 美币/港币/人民币汇率自动换算，精确计算今日估算盈亏与累计持仓收益率。
5. **隐私安全与多用户隔离**：
   - 基于 SQLite3 本地持久化，支持多用户免密/密码登录与隔离，数据完全归属于个人服务器。
6. **截图**
   <img width="3828" height="1878" alt="image" src="https://github.com/user-attachments/assets/5b0d21f3-2693-4802-bdfc-6bce2cf81da3" />
   <img width="3840" height="1878" alt="image" src="https://github.com/user-attachments/assets/3222b494-8687-4e97-a784-1765b179a0c5" />
   <img width="3828" height="1878" alt="image" src="https://github.com/user-attachments/assets/d847134c-bec2-4e0d-88f9-6e3cae9cec31" />

---

## 二、系统架构与技术栈

### 1. 前后端技术栈

#### 前端技术栈 (Frontend)
- **框架**：React 19.2 + TypeScript 5.8 + Vite 8
- **UI 组件库**：Ant Design 6.6 (`antd`) + `@ant-design/icons`
- **样式与动画**：TailwindCSS 3 + Motion (Framer Motion 12) + Lucide React 图标
- **构建工具**：Vite 8 (整合 React SWC / Oxc 极速打包)

#### 后端技术栈 (Backend)
- **运行时**：Node.js (CommonJS / ES Module 混合构建)
- **Web 框架**：Express 5 + Compression (Gzip 压缩) + CORS
- **数据库**：SQLite 3 (better-sqlite3 / sqlite3 持久化落盘)
- **实时通信**：SSE (Server-Sent Events) 实时数据代理与消息广播
- **邮件服务**：Nodemailer 邮件发送引擎

---

### 2. 实时行情与图表流式架构 (SSE Streaming Architecture)

系统在 1.4.3 版本中全面升级为**双通道 SSE 流式推流 + 共享 Broker 订阅模型**，彻底摒弃了传统前端高频轮询的粗暴模式：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           前端渲染层 (React 19)                              │
│                                                                             │
│  ┌────────────────────────┐                   ┌──────────────────────────┐  │
│  │ 自选看板 (Watchlist)   │                   │ 详情面板 (FundDetail)    │  │
│  │ - 列表价格实时跳动     │                   │ - 1次 REST 基线快照      │  │
│  │ - Sparkline 趋势缩略图 │                   │ - 60s 桶增量平滑合并     │  │
│  │ - 盈亏实时动态计算     │                   │ - 最后一根 K 线实时扩张  │  │
│  └───────────▲────────────┘                   └────────────▲─────────────┘  │
└──────────────┼─────────────────────────────────────────────┼────────────────┘
               │ SSE: /api/stream/valuations                 │ SSE: /api/stream/detail-chart
               │ (全局多标的批量推流)                        │ (单标的高频分时增量)
┌──────────────┴─────────────────────────────────────────────┴────────────────┐
│                           后端服务层 (Express 5)                             │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                   共享订阅总线 (ValuationBroker)                      │  │
│  │  - 引用计数管理：多订阅者共享同一上游轮询循环，零冗余开销             │  │
│  │  - 智能休市感知：根据市场交易时段（A/港/美）动态休眠与唤醒           │  │
│  │  - 报价归一化与去重：基于 (时间戳 + 价格 + 涨跌) 过滤无效 Tick        │  │
│  └───────────────────────────────────▲───────────────────────────────────┘  │
└──────────────────────────────────────┼──────────────────────────────────────┘
                                       │ 异步聚合与多源容灾拉取
┌──────────────────────────────────────┴──────────────────────────────────────┐
│                           上游数据源与行情路由                               │
│                                                                             │
│  - A股行情：新浪财经 / 腾讯高频快照 (10s 级)                                │
│  - 港股行情：腾讯 Qt 高频直连 (主通道) / 新浪港股 (备用通道)                │
│  - 美股/QDII：Yahoo Finance 官方 / 代理标的折算 / 离岸备用通道              │
│  - 公募基金：天天基金实时估值 / 官方净值同步 (60s 级)                       │
│  - 黄金贵金属：伦敦金现货 / 国内金价多源聚合                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 核心设计机制：

1. **共享订阅总线 (ValuationBroker)**：
   - 采用引用计数机制，当自选列表与详情抽屉同时关注某标的时，后端仅维持一个上游抓取任务，通过 `EventEmitter` 并发广播给所有连接客户端。
   - 客户端连接断开或关闭详情时，自动递减引用计数；计数归零后自动释放上游轮询资源。

2. **分时走势图「REST 基线 + SSE Patch 增量」**：
   - **首次加载**：通过 `/api/market/fund/:code/minute` 一次性拉取权威分时快照；
   - **盘中推流**：通过 `/api/stream/detail-chart` 接收单点 `minute-patch`，前端以 60 秒为时间桶进行同分钟更新或跨分钟追加；
   - **断线恢复**：内置指数退避重连机制（1.5s ~ 30s），重连或页面失焦恢复时自动触发 800ms 去抖基线回补，杜绝丢点。

3. **K 线「REST 权威快照 + 内存末根蜡烛动态扩张」**：
   - 历史 K 线（日/周/月/季/年）完全由 REST 接口提供权威 OHLCV 数据；
   - 实时行情仅在前端内存中无损更新最后一根已存在蜡烛的 `close`，并动态向外扩张 `high` 与 `low`，绝不在客户端伪造单分钟成交量或跨周期开盘价。

---

### 3. 多源跨国行情路由与降级策略

系统内置对全球不同交易时区与数据源特性的适配层：

| 市场/资产 | 主数据源 | 备用降级源 | 刷新间隔 | 交易时段 (北京时间) |
| :--- | :--- | :--- | :--- | :--- |
| **A股 股票/ETF** | 新浪财经实时行情 | 腾讯财经快照 | 10 秒 | 09:30-11:30, 13:00-15:00 |
| **港股 股票/ETF** | 腾讯 Qt 高频接口 | 新浪港股接口 | 10 秒 | 09:30-12:00, 13:00-16:00 |
| **美股 股票/ETF** | Yahoo Finance 实时 | 离岸备用行情源 | 10 秒 | 21:30-04:00 (夏令) / 22:30-05:00 (冬令) |
| **国内公募基金** | 天天基金实时估值 | 东方财富官方净值 | 60 秒 | 09:30-15:00 (估值) / 盘后更新净值 |
| **QDII 跨国基金** | 标的资产实时折算 | 官方披露净值 | 60 秒 | 追踪对应美股/港股/欧股时段 |
| **黄金/贵金属** | 伦敦现货金 (XAU) | 国内纸黄金/实物金 | 10 秒 | 24 小时连续交易 (周末休市) |

---

## 三、核心功能模块

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         全球基金与股票监控终端 (v1.4.8)                          │
├──────────────────┬──────────────────────────┬──────────────────┬─────────────────┤
│ 1. 顶部全球大盘   │ 2. 自选看板 (Watchlist)  │ 3. 黄金行情专区  │ 7. AI 智能选股  │
│  - A股/港股/美股 │  - 场内股票/场外基金分Tab │  - 伦敦金/国际金 │  - 管理员统一配置 AI 凭证 │
│  - 实时涨跌与指数 │  - 支持拖拽自由排序      │  - 国内金价时段  │  - 用户独立保存股票偏好 │
├──────────────────┴──────────────────────────┴──────────────────┴─────────────────┤
│ 4. 详情 Drawer / PC 全屏面板 (FundDetailPanel)                                   │
│  - 实时行情 4 大核心指标 (当前净值/实时涨跌/今日涨跌幅/昨收)                     │
│  - 基本信息与持仓收益 (更新时间/规模/持有金额/估算收益)                         │
│  - 盘中实时 BorderBeam 流光边框                                                  │
│  - 60 日历史走势图 & 股票 1 分钟/5 分钟分时 K 线                                 │
│  - 基金持仓 Top 10 股票 & 行业资产配置饼图                                      │
├─────────────────────────────────────────────┬────────────────────────────────────┤
│ 5. 持仓管理与算力计算                       │ 6. 邮件预警与日志中心              │
│  - 补仓/减仓/重置持仓                      │  - 涨跌幅与水位线触发              │
│  - 多币种自动折算 & 今日/累计盈亏统计        │  - 订阅中心/推送日志               │
│  - 未读红点 Badge 徽标与一键标记已读         │  - 严格多用户数据隔离              │
└─────────────────────────────────────────────┴────────────────────────────────────┘
```

---

## 四、部署环境要求

### 硬件建议配置
- **CPU**：1 核及以上 (ARM64 / x86_64 均可)
- **内存**：512 MB 及以上 (推荐 1 GB)
- **磁盘**：至少 200 MB 可用空间

### 软件环境依赖
| 组件 | 推荐版本 | 说明 |
| :--- | :--- | :--- |
| **操作系统** | Linux (Ubuntu 20.04+, Debian 11+, CentOS 8+) / macOS / Windows | 跨平台兼容 |
| **Node.js** | `>= 18.0.0` (推荐 LTS `v20.x` 或 `v22.x`) | 裸机/PM2 部署必需 |
| **Docker** | `>= 24.0.0` | 容器化部署必需 |
| **Docker Compose** | `>= 2.20.0` | Compose 一键编排必需 |

---

## 五、快速部署方式指南

### 方式一：Docker Compose 一键部署（推荐）

这是最推荐的生产部署方式，包含了健康检查、自动重启以及持久化卷挂载。

1. **获取源码并新建 `docker-compose.yml`**：

```yaml
services:
  fund-monitor:
    build:
      context: .
    image: fund-monitor:1.4.8
    container_name: fund-monitor
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - PORT=3001
      - DATA_DIR=/app/data
    volumes:
      - fund-monitor-data:/app/data

volumes:
  fund-monitor-data:
    name: fund-monitor-data
```

2. **构建并启动服务**：

```bash
# 构建镜像并后台启动
docker compose up -d --build

# 查看运行日志
docker compose logs -f
```

3. **访问服务**：浏览器打开 `http://<服务器IP>:3001` 即可进入监控终端。

---

### 方式二：Docker 单容器部署

如果您不需要 Docker Compose，可以直接通过 Docker CLI 进行镜像构建与运行：

```bash
# 1. 构建 Docker 镜像
docker build -t fund-monitor:latest .

# 2. 创建数据持久化目录
mkdir -p /var/lib/fund-monitor-data

# 3. 运行容器
docker run -d \
  --name fund-monitor \
  --restart unless-stopped \
  -p 3001:3001 \
  -e NODE_ENV=production \
  -e PORT=3001 \
  -e DATA_DIR=/app/data \
  -v /var/lib/fund-monitor-data:/app/data \
  fund-monitor:latest
```

---

### 方式三：PM2 / Node.js 源码部署

如果您希望直接部署在已有的 Node.js 服务器环境上：

1. **安装依赖与前端编译**：

```bash
# 1. 安装项目依赖
npm ci

# 2. 编译前端应用 (生成 dist 静态资源)
npm run build
```

2. **使用 PM2 管理进程**：

```bash
# 安装 PM2 (如未安装)
npm install -g pm2

# 启动后端 Express 服务
pm2 start server/index.cjs --name "fund-monitor" --env production

# 设置 PM2 开机自启
pm2 save
pm2 startup
```

3. **查看与维护**：

```bash
pm2 status
pm2 logs fund-monitor
```

---

### 方式四：本地开发环境运行

如果您希望进行二次开发或本地调试：

```bash
# 1. 安装依赖
npm install

# 2. 启动前端 Vite 调试服务器 (默认端口 5173)
npm run dev

# 3. 另开终端启动后端 Express 服务 (默认端口 3001)
npm run server
```

---

## 六、环境变量说明

容器和后台服务支持通过以下环境变量进行配置：

| 环境变量 | 默认值 | 类型 | 说明 |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | `production` | String | 运行模式 (`production` / `development`) |
| `PORT` | `3001` | Number | 后端 Node.js 服务监听端口 |
| `DATA_DIR` | `/app/data` | String | SQLite 数据库文件的存放路径（注意需挂载持久化目录） |

---

## 七、Nginx 反向代理与 SSE 配置

在生产环境中，推荐使用 Nginx 作为反向代理并配置 HTTPS。**特别注意**：由于系统使用了 **SSE (Server-Sent Events)** 实时流式传输推流，Nginx 必须关闭响应缓冲（`proxy_buffering off;`），防止推送消息滞留。

### Nginx 推荐配置示例：

```nginx
server {
    listen 80;
    server_name fund.yourdomain.com;

    # 强制重定向至 HTTPS (可选)
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name fund.yourdomain.com;

    ssl_certificate     /etc/nginx/certs/fund.crt;
    ssl_certificate_key /etc/nginx/certs/fund.key;

    # 静态前端与常规 API 代理
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 关键：针对 SSE 实时行情长连接流式响应取消缓冲
    location /api/stream/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 禁用 Nginx 响应缓冲，确保 SSE 秒级推送直达前端
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        
        # 保持连接不超时
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

---

## 八、数据持久化与运维维护

### 1. 数据落盘机制
所有的用户持仓配置、自选列表、预警水线及密码哈希均保存在 `DATA_DIR` 目录下的 `db.sqlite3` 中。
- 在 Docker 环境中，已自动挂载至名为 `fund-monitor-data` 的持久化 Volume。
- 容器升级或重启不会丢失任何用户数据。

### 2. 数据库备份与恢复
如果您需要备份数据，只需备份挂载目录下的 `db.sqlite3` 即可：

```bash
# 备份命令示例
cp /var/lib/fund-monitor-data/db.sqlite3 /backup/db.sqlite3.$(date +%Y%m%m)

# 恢复命令示例
cp /backup/db.sqlite3.20260817 /var/lib/fund-monitor-data/db.sqlite3
```

### 3. 健康检查 (Health Check)
后端服务内置了健康检查接口 `/api/health`。在 Docker 容器运行期间，Docker Engine 会每 30s 自动检查一次服务健康状态。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。
