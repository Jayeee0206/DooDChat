# DooDChat

一个面向少量朋友的轻量、一次性聊天室。

DooDChat 不要求注册账号，也不保存长期聊天记录。房主在自己的电脑上启动服务，朋友通过浏览器加入；本轮房间结束后，聊天、图片、音频缓存、歌单和临时状态会由程序自动清理。

## 功能

- 文字聊天与临时图片
- 消息引用回复与 👍、❤️、😂、😮、😢、👀 六种回应
- 在线成员、多人正在输入提示和 `@` 提及
- 斜杠指令：`/roll [上限]` 掷骰子、`/coin` 抛硬币、`/pick A B C` 随机抉择、`/shrug` `/tableflip` `/unflip` 颜文字，`/help` 查看列表
- 断线自动重连并延续身份（默认 10 分钟内旧消息仍归属自己、仍可撤回）
- WebRTC 多人语音
- 网易云歌单共享（支持 `163cn.tv` 分享短链）、同步播放、黑胶效果与逐字歌词
- 雨夜、落雪、星空、樱花四种房间天气
- 多主题、桌面/手机响应式布局、键盘操作和减弱动态效果
- Windows 一键启动、局域网地址提示和安全关闭
- 空房超时、正常关闭和下次启动时的自动清理

## 适用范围

DooDChat 定位为朋友之间临时使用的小型单房间项目，而不是公共聊天平台。

它目前**没有**：

- 注册账号、数据库和长期聊天记录
- 多房间、管理员、禁言、踢人和举报系统
- 多服务器部署和正式运营后台
- 内置公网穿透服务

## 环境要求

- Node.js 20 或更高版本
- Windows 10/11 可直接使用一键启动器
- Chrome、Edge、Firefox 或 Safari 等现代浏览器

## Windows 快速开始

1. 下载并解压项目，保持目录结构不变。
2. 双击根目录中的 `启动DooDChat.cmd`。
3. 第一次运行如果缺少依赖，启动器会自动安装。
4. 等待窗口显示“DooDChat 已启动”，浏览器会自动打开。
5. 同一 Wi-Fi 或局域网中的朋友，使用启动窗口列出的局域网地址加入。
6. 使用结束后回到启动窗口按一次回车，等待“DooDChat 已安全关闭”。

Windows 首次弹出防火墙提示时，只建议允许“专用网络”，不要为普通局域网使用开放“公用网络”。

更完整的普通用户说明见 [`DooDChat使用说明.txt`](./DooDChat使用说明.txt)。

## 命令行启动

```bash
npm ci
npm start
```

默认地址：

```text
http://localhost:3000
```

开发模式：

```bash
npm run dev
```

## 设置房间密码

局域网内也建议设置密码；只要建立任何公网入口，就必须设置非空密码。

CMD：

```bat
cd /d 你解压DooDChat的目录
set "ROOM_PASSWORD=换成你自己的密码"
启动DooDChat.cmd
```

PowerShell：

```powershell
$env:ROOM_PASSWORD = "换成你自己的密码"
.\启动DooDChat.cmd
```

DooDChat 当前不会自动读取 `.env` 文件。请通过启动终端、系统服务或部署平台设置环境变量，不要把真实密码写进代码或提交到 GitHub。

## 可选：异地访问

默认一键启动只面向本机和私人局域网，不会自动开放公网。

如果朋友位于不同地点，可以在 DooDChat 前面临时加一层内网穿透，把本机 3000 端口映射成公网 HTTPS 地址。常见选择：

| 工具 | 特点 | 每次启动命令 |
|---|---|---|
| [cpolar](https://www.cpolar.com/) | 国内访问较稳；需注册并执行一次 `cpolar authtoken <token>`；免费版地址会变 | `cpolar http 3000` |
| Cloudflare Quick Tunnel | 免注册；地址每次都变，国内部分网络较慢 | `cloudflared tunnel --url http://localhost:3000` |
| [ngrok](https://ngrok.com/) | 需注册并执行一次 `ngrok config add-authtoken <token>`；首次访问有确认页 | `ngrok http 3000` |
| [Tailscale](https://tailscale.com/) | 不开公网，双方都装并登录同一网络后直接访问 `http://<Tailscale IP>:3000`；要语音需 `tailscale serve 3000` 获得 HTTPS | — |

无论哪种，流程都一样：**先设置强 `ROOM_PASSWORD` 启动 DooDChat → 再开穿透 → 把地址和密码分开发给朋友 → 用完先关穿透再关 DooDChat**。下面以 Cloudflare Quick Tunnel 为例（其他工具只是把第 2、4 步换成上表命令），仅适合临时和少量朋友使用；面向普通用户的分步说明见 `DooDChat使用说明.txt` 第八节。

1. 停止已运行的 DooDChat。
2. 安装 `cloudflared`：

   ```bat
   winget install --id Cloudflare.cloudflared
   ```

3. 在一个 CMD 窗口中设置强房间密码并启动 DooDChat：

   ```bat
   cd /d 你解压DooDChat的目录
   set "ROOM_PASSWORD=换成至少12位的密码"
   启动DooDChat.cmd
   ```

4. 在另一个窗口中启动 Tunnel：

   ```bat
   cloudflared tunnel --url http://localhost:3000
   ```

5. 把生成的 `https://....trycloudflare.com` 地址和房间密码分别发送给朋友。
6. 使用结束后先按 `Ctrl+C` 停止 Tunnel，再在 DooDChat 窗口按回车安全关闭。

不要为了异地访问直接把路由器的3000端口无保护地暴露到公网。HTTPS 可以满足浏览器麦克风权限的基本要求，但异地 WebRTC 语音仍受 NAT 和防火墙影响，不保证所有网络都能连通。

## 临时房间与自动清理

- 第一个认证用户进入后，本轮房间开始。
- 聊天、回复、回应、天气、typing、语音和音乐状态只保存在内存中。
- 图片和代理音频默认写入带 DooDChat 所有权标记的系统临时目录，也可通过环境变量指定位置。
- 最后一名用户离开后默认等待10分钟；期间重新进入会继续本轮房间。
- 10分钟无人返回后，程序清空本轮聊天、图片、音频、歌单和其他临时状态。
- 正常关闭时立即清理；意外关闭留下的带标记残留会在下次启动时清除。

DooDChat 只会自动清理带有效所有权标记的临时目录。升级前旧版本留下的无标记文件不会自动删除；若启动提示目录未归属，请先自行确认并备份其中内容，再单独处理，不要让程序猜测哪些文件可以删除。浏览器记录、系统备份和第三方穿透服务日志不在 DooDChat 的清理范围内。

## 常用环境变量

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `PORT` | `3000` | HTTP/WebSocket 端口 |
| `ROOM_PASSWORD` | 空 | 房间密码；公网入口必须设置 |
| `ROOM_EMPTY_GRACE_MS` | `600000` | 最后一人离开后的清理等待时间 |
| `RESUME_WINDOW_MS` | `600000` | 断线后可恢复原身份的时间窗 |
| `HISTORY_MEMORY_LIMIT` | `100` | 当前房间内存消息上限 |
| `MAX_AUTHENTICATED_USERS` | `50` | 最大认证用户数 |
| `MAX_VOICE_USERS` | `8` | 最大语音人数 |
| `RUNTIME_DIR` | 系统临时目录 | 临时图片和音频的根目录 |
| `ALLOWED_ORIGINS` | 空列表 | 额外允许的浏览器 Origin，逗号分隔 |
| `TRUST_PROXY` | `false` | 是否信任经过明确配置的代理 |

其余变量（连接与协议上限、上传限制、音频代理限制等）在 [`server/config.js`](./server/config.js) 中集中定义，每一项都有默认值。

## 质量说明

本仓库附带可重复运行的自动化测试，覆盖歌单短链解析和临时目录归属检查。安装依赖后运行：

```bash
npm ci
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
```

语音、跨设备同步和各浏览器界面效果仍需在实际网络与设备上试用；这里不以不可复现的测试数量或“零问题”作为发布保证。

## 安全说明

项目已包含同源 WebSocket、认证前隔离、协议校验、限流、真实图片识别、上传令牌、音频代理限制、安全响应头、临时目录所有权标记和自动清理等保护。

常见静态图片由浏览器重新编码后上传，以减少原图元数据泄露；GIF 为保留动画会原样上传，其他客户端调用上传接口也不会被服务端去除元数据。图片地址本身可直接访问，知道地址的人在文件清理前无需房间密码即可查看。WebRTC 语音采用用户间直连并使用 Google STUN 服务，参与者及 STUN 服务可能获知网络地址。音乐封面由浏览器直接从网易云加载，也会产生对网易云的请求。请勿把 DooDChat 当作匿名或端到端加密服务使用。

这些保护不等于适合无管理地公开运营。若发现安全问题，请不要在公开 Issue 中粘贴真实密码、Tunnel 地址、聊天内容、令牌或个人网络信息，参见 [`SECURITY.md`](./SECURITY.md)。

## 上传 GitHub 前

若通过 GitHub 网页手工上传，请逐项核对选中的文件；`.gitignore` 只影响 Git 提交，不会替网页上传过滤文件。不要上传 `node_modules/`、`.env`、运行缓存、聊天媒体、证书、令牌或个人测试记录。私有仓库也应按同样标准检查，并注意以后改为公开仓库时历史文件仍可能可见。

## 项目结构

```text
DooDChat/
├─ 启动DooDChat.cmd
├─ DooDChat使用说明.txt
├─ public/            浏览器页面、样式和前端脚本
├─ server/            HTTP、WebSocket、协议和生命周期
├─ scripts/           Windows 启动器
├─ test/              可重复运行的自动化测试
├─ package.json
├─ LICENSE
└─ SECURITY.md
```

## 许可证

本项目采用 [MIT License](./LICENSE)。
