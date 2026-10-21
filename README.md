# figcraft-app-mcp

> figcraft 开源设计软件的 MCP 工具

一个本地 MCP Server（stdio / JSON-RPC 2.0 / MCP `2025-06-18`），通过 FigCraft 桌面版的**本地控制通道**驱动正在运行的 FigCraft 应用。

它同时暴露两套工具面：

- **FigCraft 原生工具**：与上游 `figcraft-mcp`（`crates/mcp`）同名同义，可直接替换上游实现。
- **Figma 兼容工具**：`get_metadata` / `get_design_context` / `get_screenshot` / `get_code_connect_map` / `get_variable_defs` / `get_code`，与 Figma 桌面版 MCP 同名，**已习惯 Figma MCP 的 agent 可以直接用同一套词汇驱动 FigCraft**。

## 架构

```text
MCP 客户端 (Claude Code / Cursor / MiniMax Code / Codex …)
        │  stdio, JSON-RPC 2.0
        ▼
figcraft-app-mcp (本项目, Node/TS)
        │  TCP 127.0.0.1:<port>, 换行分隔 JSON
        ▼
FigCraft 桌面应用 (--control <port>)
```

控制通道的报文格式（上游 `docs/control-protocol.md`）：

```text
请求: {"id": 1, "method": "engine.execute", "params": {"command": "node.create", "params": {...}}}
回复: {"id": 1, "ok": true, "result": ...}
      {"id": 1, "ok": false, "error": "message"}
```

请求排队后在 UI 线程的下一次帧处理，因此回复反映真实 UI 状态；应用 60 秒不答则返回超时错误。

## 前置条件

1. 装好 FigCraft 桌面版（本机为 `/Applications/FigCraft.app`）。
2. **用带控制通道的方式启动它**（见下）。

> ⚠️ 实例必须经由 LaunchServices 启动（`open`）。直接从 shell 里跑二进制虽然能绑定端口，但拿不到正常 GUI 会话，UI 线程不会处理请求，所有调用都会返回
> `timed out waiting for the UI: screenshots and input need the FigCraft window on screen`。

## 启动带控制通道的 FigCraft

两种方式，任选其一：

**A. 包装 App（推荐，已随项目提供）**

```sh
open -n /Users/wangpengfei/Documents/codozero/figcraft-mcp/tools/FigCraftControl.app
```

包装 App 会以 `--control <port>` 启动真正的 FigCraft，端口取自
`$FIGCRAFT_CONTROL_PORT` > `figcraft-mcp/.control-port` > 脚本内默认值 `7987`。
日志写在 `figcraft-mcp/figcraft-control.log`。

**B. 直接用 open 传参**

```sh
open -n /Applications/FigCraft.app --args --control 7987
```

部分 macOS 版本上 `open --args` 不会把参数交给应用（表现为端口没起来），此时用 A。

## 安装与构建

```sh
cd /Users/wangpengfei/Documents/codozero/figcraft-mcp
npm ci --cache ./.npm-cache      # 或 npm install --cache ./.npm-cache
npm run build
```

## 客户端配置

在项目的 `.mcp.json` 里：

```json
{
  "mcpServers": {
    "figcraft-app": {
      "command": "node",
      "args": ["/Users/wangpengfei/Documents/codozero/figcraft-mcp/dist/index.js"],
      "env": {
        "FIGCRAFT_CONTROL_PORT": "7987"
      }
    }
  }
}
```

MiniMax Code 也可以用 `mavis mcp create` 注册同名 server。

## 工具

### Figma 兼容面

| 工具 | 作用 | Figma 对应 |
|---|---|---|
| `get_metadata` | 层级树，形状为 `{id, name, type, children}` | `get_metadata` |
| `get_design_context` | 几何 / 自动布局 / 填充 / 描边 / 效果 / 字体 / 样式 / 变量 / 组件链接 | `get_design_context` |
| `get_screenshot` | 指定图层或整页 PNG；`window: true` 截应用窗口 | `get_screenshot` |
| `get_code_connect_map` | 组件与真实代码的 Code Connect 映射 | `get_code_connect_map` |
| `get_variable_defs` | 变量与画板样式定义 | `get_variable_defs` |
| `get_code` | 图层生成的代码（css/html/react/leptos/swiftui/compose） | `code` |

### FigCraft 原生面

`list_commands`、`run_command`、`batch`、`create_node`、`set_properties`、`inspect_document`、
`get_node`、`select`、`export`、`screenshot`、`open_file`、`save_file`、`undo`、`redo`、
`pointer`、`key`、`type_text`、`inspect_ui`。

`run_command` 可执行全部 **561 条**菜单级命令（`align.left`、`layout.add`、`component.create`、
`inspect.code`、`file.export` …），用 `list_commands` 查看。

### 约定（与上游一致）

- 坐标是 **page 单位**（100% 缩放下 1 单位 = 1px），x 向右、**y 向下**。
- `create_node` / `set_properties` 的 `x` / `y` 相对**父级 frame**（没有父级时相对页面）。
- 颜色 `"#RRGGBB"` 或 `"#RRGGBBAA"`；渐变可写 `{"type":"linearGradient","stops":["#7048E8","#1098AD"]}`。
- 每次改动是一个 undo 步；`batch` 合成一步且全有或全无。
- `batch` 的步骤参数里可用 `{"$step": n}` 引用前一步返回的 id。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FIGCRAFT_CONTROL_PORT` | `7987` | 控制通道端口 |
| `FIGCRAFT_CONTROL_HOST` | `127.0.0.1` | 控制通道地址（只应在 loopback 用） |
| `FIGCRAFT_REQUEST_TIMEOUT_MS` | `65000` | 单次请求超时（应用自身上限 60s） |
| `FIGCRAFT_MAX_LINE_BYTES` | `33554432` | 单行回复上限（对齐应用的 32 MiB） |
| `FIGCRAFT_READ_ROOTS` | `[]` | 允许读取的目录（JSON 数组），限制 `open_file` |
| `FIGCRAFT_WRITE_ROOTS` | `[]` | 允许写入的目录（JSON 数组），限制 `save_file` / `export` |
| `FIGCRAFT_MAX_IMAGE_BYTES` | `25000000` | 返回图片的体积上限 |

`FIGCRAFT_READ_ROOTS` / `FIGCRAFT_WRITE_ROOTS` 是**桥接侧**的兜底限制；应用侧还可以用
`--automation-read-root` / `--automation-write-root` 再限制一层。

## 与上游 `figcraft-cli mcp` 的关系

上游 Rust 项目自带 MCP Server（`crates/mcp`，`figcraft-cli mcp` / `figcraft-cli mcp --attach <port>`）。
本项目是**同协议的独立实现**，特点：

- 不需要编译 Rust（`cargo build --release -p figcraft-cli` 在本机很慢）。
- 直接驱动**已经装好的桌面应用**，用户在窗口里实时看到每一次改动。
- 额外提供 Figma 兼容工具名，便于复用 Figma 的工作流与提示词。

两者可以并存：上游负责 headless / 批处理，本项目负责交互式编辑。

## 测试

```sh
npm test          # 用假的控制通道做单元与集成测试（无需启动 FigCraft）
npm run typecheck
```

## 已知限制

- 应用同一时刻只接受 8 个控制连接、队列各 8 条请求，超出会返回 `control request queue is full`。
- `ui.screenshot`（应用窗口截图）要求窗口在屏幕上；窗口最小化/被遮挡时 `ui.render` 仍可用。
- 控制通道请求在 60 秒内没被 UI 线程处理就会被丢弃，**不会自动重放**——请先检查文档再重试。

## 许可

[GPL-3.0](LICENSE)。FigCraft 本身是 MIT OR Apache-2.0（上游 `storytold/figcraft`），本项目是独立的第三方桥接实现。
