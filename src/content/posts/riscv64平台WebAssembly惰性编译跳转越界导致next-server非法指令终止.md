---
title: "riscv64 平台 WebAssembly 惰性编译跳转越界导致 next-server 非法指令终止"
published: 2026-09-18
description: "riscv64 平台上 Next.js 回退到 wasm 版 SWC，其惰性编译跳转槽用 JAL 跳到惰性编译入口；在约 3 万函数的模块上跳转距离超出 JAL 的 ±1 MiB 射程，偏移在 release 构建中被静默截断，执行流落入全零代码页触发 SIGILL。本报告记录现场证据、根因定位、最小复现与运行时缓解。"
tags: ["RISC-V", "WebAssembly", "SIGILL", "V8", "Node.js", "Next.js"]
category: "笔记"
draft: false
language: "zh_CN"
---

# riscv64 平台 WebAssembly 惰性编译跳转越界导致 next-server 非法指令终止

## 技术报告

| 项 | 内容 |
|---|---|
| 版本 | v1.3（2026-09-16，含合成模块阈值验证、QEMU 对照、复现资产、数据与证据强度校订） |
| 作者 / 身份 | （苦芽科技实习生） |
| 单位 | 苦芽科技（KUBUDS Tech） |
| 被测平台 | Sipeed Lichee Pi 3A（SpacemiT K1，riscv64），Bianbu 1.0.15，内核 6.1.15 |
| 被测软件 | Node.js v26.0.0（unofficial-builds riscv64）＋ `@agegr/pi-web@0.8.11`（Next.js 16.3.1） |
| 证据分级 | A：本机实测或已由公开上游来源核实；B：由源码推导或由多条 A 级证据支持；C：未验证 / 未解释 |
| 一句话结论 | Next.js 在 riscv64 上回退到 wasm 版 SWC，其惰性编译跳转槽用 `JAL` 跳到"惰性编译入口"；在约 3 万个函数的模块上该跳转距离超出 `JAL` 的 ±1 MiB 射程，偏移在 release 构建中被静默截断，执行流落入全零代码页 → 非法指令异常（`SIGILL`）。上游 V8 已修复该缺陷；Node.js 尚未包含该修复。 |

---

## 摘要

本报告记录并分析一起在 RISC-V 平台上 100% 复现的进程异常终止事件：基于 Next.js 16.3.1 的 Web 应用 `pi-web` 启动后约 3.9 s（就绪日志之后约 2.3 s），其 `next-server` 子进程被 `SIGILL` 终止，内核记录异常原因码 `cause=2`（非法指令），与客户端请求无关。

定位采用"分层假设 + 单变量排除"，依次排除了应用层缺陷、请求触发、OpenSSL 向量汇编、第三方原生扩展模块、CPU 指令集扩展缺失、内存回收竞态、编译后端差异、Node 版本回归与构建口味等九类假设。通过在内核停止点直接扫描可执行代码空间，本报告取得以下直接证据：

- 定位到 27566 号函数的惰性编译跳转槽（`0x3fa85cc768`），其 12 字节为 `lui t0,7 / addi t0,t0,-1106 / jal x0,+0xff2b8`，与 V8 修复前实现逐条一致；
- 该跳转的**真实距离为 −1,051,976 字节**，超出 `JAL` 的 −1 MiB 射程 **3,400 字节**；真实目标（`0x3fa84cba28`）处为 far jump table 槽位的标准形态（`auipc t6,0 / ld t6,16(t6) / jr t6`）；
- 偏移被按 `0x200000` 取模后编码为 `+0xff2b8`，据此算得的落点 `0x3fa86cba28` 与 gdb 实测 `$pc`、内核 `epc` **逐位一致**，落点内容为全零——**判别性证据是 gdb 在 `$pc` 处的 32 字节全零内存转储**；内核 `badaddr=0` 与之相容，但因 RISC-V 规范允许非法指令陷阱的 `stval` 为 0，该字段本身不构成独立判据。

修复层面：运行时标志 `--no-wasm-lazy-compilation` 可 100% 消除故障（补丁前 20/20 崩溃 → 补丁后持续运行、`GET /` 返回 200、内核 `SIGILL` 计数为 0），代价是启动阶段全量编译（常驻内存实测约 323 MB）。为剥离第三方应用，本报告另以自建 wasm 模块验证了触发条件：7 组预测 7/7 命中距离模型 `24N + 12d + K` 的二元判定（另 1 组为关闭惰性编译的对照），其中包含"同一模块仅改变首次调用下标即由崩溃转为正常"的判别性实验，从而把复现成本降至"一个 0.24 MB 的 wasm 文件"。此外，同一合成模块在 QEMU 客户机（内核 7.2.0-rc7、ISA 扩展齐全）内同样崩溃，说明该缺陷并非真机特有，早前"QEMU 不复现"的应用级负结果**最可能**源于其首次惰性调用下标落在射程内（该次运行未采集下标，属推断）。

根治手段为 V8 上游修复（提交 `def38dd3f8`，已将 `JAL` 换为 `AUIPC`+`JALR` 并把 `DCHECK` 提升为 release 生效的 `CHECK`），但截至 2026-09-16，**Node.js 尚无任何分支包含该修复**（V8 main 已含；Node v26.0.0、v26.8.2 与 main 均仍为修复前实现），且 riscv64 无官方/非官方二进制，故版本级分发与"修复版回归验证"均需等待 V8 更新。本课题的现场证据、最小复现与协作记录已提交至上游（`nodejs/node#65724` 等，见 §7.5）。**本报告不主张发现该 V8 缺陷**：上游修复早于本课题的定位；本报告的独立贡献限于真实应用的触发面、现场判据、真机几何实测、最小复现与经实测验收的运行时缓解。

**关键词**：RISC-V；WebAssembly；惰性编译；跳转越界；SIGILL；V8；Node.js；Next.js

---

## Abstract

About 3.9 s after startup (≈2.3 s after the "Ready" log line), the `next-server` child process of a Next.js 16.3.1 web application (`pi-web`) is killed by `SIGILL` on a RISC-V board, with the kernel reporting `cause=2` (illegal instruction) and independently of any client request. The event reproduces 100 % of the time. Localisation proceeded by layered hypothesis and single-variable elimination, ruling out nine candidate classes (application defect, request-triggered path, OpenSSL vector assembly, third-party native addons, missing ISA extensions, GC race, compiler-backend difference, Node version regression, build flavour). By scanning the executable code space at the kernel stop point, the investigation obtains direct evidence: the lazy-compilation jump slot of function 27566 at `0x3fa85cc768` holds `lui t0,7 / addi t0,t0,-1106 / jal x0,+0xff2b8`, byte-for-byte the pre-fix V8 implementation; the true displacement is −1,051,976 bytes, 3,400 bytes beyond the ±1 MiB reach of `JAL`; the offset is silently truncated modulo `0x200000`, so the decoded landing address `0x3fa86cba28` matches the gdb-observed `$pc` and the kernel `epc` exactly and lies in an all-zero region — the discriminating evidence being the 32-byte all-zero dump at `$pc`, while the kernel's `badaddr=0` is merely consistent with, and not probative of, this account. The runtime flag `--no-wasm-lazy-compilation` removes the failure completely (20/20 crashes before the workaround versus sustained execution and `GET /` returning 200 after it), at the cost of eager compilation (≈323 MB resident). A self-built 0.24 MB synthetic module reproduces the trigger without the application and validates the displacement model `24N + 12d + K` (7 of 7 binary predictions), including a discriminating experiment in which changing only the first lazily-called index turns a crash into a clean run. The same module also crashes inside a QEMU guest with a complete ISA, showing that the defect is not board-specific. The root cause is fixed upstream in V8 (commit `def38dd3f8`, replacing `JAL` with `AUIPC`+`JALR` and promoting a `DCHECK` to a release-effective `CHECK`); as of 2026-09-16, however, no Node.js branch contains that fix and no riscv64 binary exists, so distribution and fixed-build regression verification must wait for the V8 update.

**Keywords**: RISC-V; WebAssembly; lazy compilation; jump out of range; `SIGILL`; V8; Node.js; Next.js

---

## 1 背景、目标与约定

### 1.1 背景

RISC-V 的运行时生态仍在演进：Node.js 官方未提供 riscv64 发行产物，实际可用的是社区维护的实验性构建（unofficial-builds）。同时，现代 Web 框架普遍保留"原生加速产物不可用时的降级路径"——Next.js 使用 Rust 编写的编译器 SWC，并在缺少原生绑定（native binding）时加载其 WebAssembly（wasm）版本。两者相遇的结果是：**一个平台适配缺口会把大规模 wasm 负载送进覆盖薄弱的执行路径。**

### 1.2 问题

2026-09-01，在一块 SpacemiT K1 开发板（Bianbu 1.0.15，内核 6.1.15）上安装 Node.js v26.0.0（unofficial-builds，riscv64）后启动 `@agegr/pi-web@0.8.11`，出现稳定可复现的崩溃：

```
▲ Next.js 16.3.1
- Local:         http://127.0.0.1:30141
✓ Ready in 1632ms
⚠ next-swc does not have native bindings support for target triple [object Object]. ...
[pi-web] Next.js exited unexpectedly (signal SIGILL)
```

### 1.3 本报告的目标与范围

**目标**：给出该故障的完整现象记录、定位过程、根因机制与修复方案，并提供可复现的验证方法。

**范围与边界**：本报告不主张发现该引擎缺陷。缺陷位于 V8，其修复已由上游合入（见 §5.5）；本报告的独立工作是：在真实应用中复现其触发面、给出可复述的现场判据、在真机上直接测量其几何量并复算落点、验证可用的缓解措施，以及明确仍未解决的问题（§7.6）。

### 1.4 证据分级约定

| 等级 | 含义 | 本报告中的表述 |
|---|---|---|
| **A** | 本机实测（有日志/输出留证），或已由公开上游来源核实 | "实测表明"/"上游提交为" |
| **B** | 由源码推导，或由多条 A 级证据共同支持，但未直接观测 | "据源码推导"/"强烈提示" |
| **C** | 尚未验证、无法验证或原因未解释 | "未解释"/"列为后续工作" |

---

## 2 环境与复现方法

### 2.1 环境基线

**表 1　实验环境（复现基线）**

| 项目 | 取值 |
|---|---|
| 硬件 | Sipeed Lichee Pi 3A（SpacemiT K1，8× T-Heng X60，16 GB RAM） |
| 操作系统 | Bianbu 1.0.15（Ubuntu mantic 底座），glibc 2.38 |
| 内核 | Linux 6.1.15（`#1.0.15.1 SMP PREEMPT`，riscv64）；**不提供 `riscv_hwprobe`**（该接口由 Linux 6.4 引入，出处见附录 E） |
| CPU ISA（`/proc/cpuinfo`） | `rv64imafdcv_sscofpmf_sstc_svpbmt_zicbom_zicboz_zicbop_zihintpause`；不含 `Zba/Zbb/Zbc/Zbs/Zcb/Zfa`；RVV 1.0 可用 |
| Node.js | v26.0.0，unofficial-builds `linux-riscv64`；sha256 `071bb81d19de45393b91412ec4f01ae85bfde2b7e78bb62c5fabfa72347b8ff8`（取自 https://unofficial-builds.nodejs.org/download/release/v26.0.0/ ，经 `sha256sum -c` 校验）。本报告中的 `~/.local/node` 是指向 `~/.local/node-v26.0.0-linux-riscv64/` 的符号链接 |
| V8 | 14.6.202.33-node.19（其 `deps/v8` 内 riscv64 惰性编译跳槽仍为修复前实现） |
| 其他组件 | libuv 1.52.1；OpenSSL 3.5.5 |
| 被测应用 | `@agegr/pi-web@0.8.11`，依赖 `next@16.3.1` |
| 触发模块 | `@next/swc-wasm-nodejs@16.3.1` 的 `wasm_bg.wasm`：**30,392,977 字节（28.99 MB）**，Code 段定义函数 **29,955** 个，导入 64，导出 22，sha256 `b6c1b1bd6f740278cb907e0114d814cd798d1ec29be9a6e619005b18adceb5f5` |
| 对照构建 | `linux-riscv64-pointer-compression`（同 v26.0.0 发布，`v8_enable_pointer_compression=1`）；Node v24.20.0 |

> 说明：`next/wasm/@next/swc-wasm-nodejs/` 目录在**首次运行时**才出现——由框架（Next.js）在运行期下载并缓存该 wasm 回退包，因此首次运行需要可访问 npm；其文件时间戳来自 tarball，不宜用 mtime 判断存在性。

### 2.2 复现步骤

```bash
npm i -g @agegr/pi-web@0.8.11
pi-web --port 30141                     # 预期：约 3.9 s 后被 SIGILL 终止（应用首次运行会安装 wasm 回退包）
journalctl -k --no-pager | grep -A20 "signal 4" | tail -24

# 对照（关闭 wasm 惰性编译）——标志必须加在真正执行 wasm 的 next 子进程上：
#   pi-web.js 只是父进程，其 V8 标志不会传给 spawn 出的子进程（见 §6.2 表 12）
node --no-wasm-lazy-compilation \
  "$(npm root -g)/@agegr/pi-web/node_modules/next/dist/bin/next" start -p 30142 -H 127.0.0.1
```

### 2.3 受控重复实验（复现率）

**表 2　受控重复实验结果（2026-09-16）**

| 组 | 次数 | 观测窗口 | 崩溃 | 存活 | 进程存活时间 |
|---|---|---|---|---|---|
| 默认（启用惰性编译） | 20 | 40 s | **20/20 = 100%**（`exit=132`） | 0/20 | 中位 ≈3.92 s（18 次落在 3.70–3.97 s，2 次 4.35 s） |
| 对照（关闭惰性编译） | 5 | 40 s | 0/5 | **5/5** | — |

就绪时刻实测：默认配置 1.58–1.90 s（20 样本，中位 1.66 s）；关闭惰性编译 1.51–1.76 s（5 样本，中位 1.56 s）。因此准确的描述是：**故障在进程启动后约 3.9 s 稳定发生，即就绪日志之后约 2.3 s**，与外部请求无关，连续 20 次无一例外。（早期粗采样曾记为"就绪后 5–8 s"，本节数据对其修正。）

### 2.4 全新安装复现（验证不依赖本地改动）

为避免"是否因为本地环境被改动才复现"的疑问，执行了一次完整的卸载—重装实验：

**表 3　重装实验过程与结果（2026-09-16）**

| 步骤 | 命令 | 结果 |
|---|---|---|
| 备份 | `cp -a` 包目录、launcher、重打脚本 | `~/pi-web-backup-0916-1445` |
| 卸载 | `npm uninstall -g @agegr/pi-web` | 移除 322 个包（11 s），包目录清空 |
| 全新安装 | `npm i -g @agegr/pi-web@0.8.11` | 安装 322 个包（**123 s**），得到 `next@16.3.1`；**补丁标记为 0（干净安装）** |
| 原生启动命令 | `pi-web --port 3130x`（未打任何补丁） | **3/3 被 `SIGILL` 终止**（4.64–5.80 s） |
| 直接启动 | `node next start`（未打补丁） | **2/2 被 `SIGILL` 终止**（3.72–3.73 s） |

结论：**该缺陷不依赖任何本地改动，从 npm 全新安装后即可稳定复现。**

### 2.5 实验隔离与注意事项

- **不要覆盖基线 Node**：新增构建解包到独立目录（`~/node-verify-*`），调用使用绝对路径；`~/.local/node` 保持不动，否则已采集的第一手证据无法再复现。
- **npm 全局命令是符号链接**：`~/.local/node/bin/pi-web` 指向包内 `bin/pi-web.js`。若以 `cat > shim` 覆盖它，写入会**穿透符号链接**、把包内 JS 覆盖成 shell 脚本（本次实验确实踩中，见附录 C 的工程提示）。
- **每轮实验后立即落盘内核日志**：崩溃会冲刷 ring buffer，历史现场可能被挤掉。

---

## 3 故障现象与证据

### 3.1 时序与退出码

1. 应用输出 Next.js 版本、监听地址与 `✓ Ready`；
2. 输出 wasm 回退告警（`next-swc does not have native bindings support for target triple [object Object]`）；
3. 无外部请求的情况下，进程启动后约 3.9 s（就绪后约 2.3 s）被 `SIGILL` 终止，退出码 132（=128+4）；
4. 存活窗口内主动发起 HTTP 请求不改变终止时刻。

### 3.2 内核记录与字段语义

**表 4　内核异常记录字段解读**

| 字段 | 观测 | 含义 |
|---|---|---|
| 信号 | `unhandled signal 4` | `SIGILL`；`unhandled` 表示进程未注册处理函数，按默认动作终止 |
| `code` | `0x1` | `SI_CODE = ILL_ILLOPC`（非法操作码），非地址类错误 |
| `epc` / `at 0x…` | 低 12 位恒为 `0xa28` | 用户态程序计数器，即**错误跳转的落点**（不是跳槽地址） |
| `badaddr` | `0` | 本内核把 `CSR_TVAL` 存入 `PT_BADADDR`。RISC-V 规范允许非法指令陷阱的 `stval` 为 0 **或**为出错指令码，故该值 0 **与"指令字为 0"相容，但不具判别力**（判别性证据是 gdb 在 `$pc` 处的 32 字节全零转储） |
| `cause` | `0x2` | 非法指令（1 = 取指访问错误，12 = 指令页错误） |
| `t0` | 恒为 `0x6bae` | 承载 wasm 函数编号 27566（见 §5.1） |
| `ra` | 例 `0x…e458` | 返回地址，指向 `Builtins_JSToWasmWrapperAsm+184`（JS→wasm 跳板） |

两条关键判据（A 级）：

- `cause=2` 而非取指类错误 ⇒ 落点所在页**可执行**（若不可执行应为 `cause=12` 或 `cause=1`，均映射为 `SIGSEGV`）；
- `cause=2` 表明取指成功而译码失败 ⇒ 落点所在页**可执行**；结合 gdb 在 `$pc` 处读到的 32 字节全零，可判定落点内容为全零。`badaddr=0` 与之相容，但仅作一致性检查（规范允许 `stval` 为 0）。

### 3.3 用户态现场（单次运行完整抓取）

```text
Thread 1 "next-server (v1" received signal SIGILL, Illegal instruction.
0x0000003fa86cba28 in ?? ()
(gdb) x/8i $pc
=> 0x3fa86cba28:  unimp
   0x3fa86cba2a:  unimp          （gdb 以 2 字节步长显示 8 条，跨 16 字节）
(gdb) x/8xw $pc-16
0x3fa86cba18:  0x00000000 0x00000000 0x00000000 0x00000000
0x3fa86cba28:  0x00000000 0x00000000 0x00000000 0x00000000
(gdb) info registers ra t0
ra  0x2aabf96458  <Builtins_JSToWasmWrapperAsm+184>
t0  0x6bae        27566
(gdb) info symbol $ra
Builtins_JSToWasmWrapperAsm + 184 in section .text of
  /home/acidmoon/.local/node-v26.0.0-linux-riscv64/bin/node
```

要点：落点为全零；`ra` 位于 Node 自带的 V8 内建（**责任划分证据**，B 级：`ra` 说明调用来源，不直接证明跳槽实现）；`t0` 与 `$pc` 在同一会话内一并取得。

### 3.4 确定性指纹

**表 5　崩溃记录的派生量统计（板载 14 次不同崩溃）**

| 派生量 | 观测 |
|---|---|
| 页内偏移（低 12 位） | `0xa28`，**板载 14/14**（合成模块场景为 `0xe48`/`0xc88`，见 §5.4.1） |
| `t0` | 凡保留寄存器块的板载记录均为 `0x6bae`（12 条）；合成模块场景另有 2 条，其值分别等于被调用下标 29999 与 0（§5.4.1） |
| 低 21 位 / `epc mod 0x200000` | **9 个不同取值**（`0x3fa28`、`0xc7a28`、`0x6fa28`、`0x14fa28`、`0xc5a28`、`0xc9a28`、`0x34a28` 等） |

来源构成：**8 次**来自 2026-09-01（按崩溃头部的时间 + PID 去重；其中 1 次仅见于 dmesg 格式输出），**6 次**来自 2026-09-16 的复测（其中 3 次为 pointer-compression 构建）。低 21 位变化与页内偏移恒定并不矛盾：落点 = **JAL 指令地址（槽位 + 8）** + 截断偏移，而跳槽随代码空间基址被 ASLR 平移（≥4 KB 粒度），故低 21 位变化、页内偏移由布局决定而恒定。**证据边界**：`epc` 与页内偏移对全部 14 次可核；`t0` 仅对归档中保留寄存器块的记录（板上 12 条）与合成模块的 2 条可核，其余记录只存有崩溃头部行。

**构建口味对照（A 级）**：pointer-compression 构建 3/3 崩溃，`epc` 页内偏移 `0xa28`、`t0=0x6bae`、`badaddr=0`、`cause=2` 与标准构建一致；仅 `ra` 的页内偏移不同（标准 `0x458`、pc `0x6f8`，源于两种构建的内建布局差异）。

---

## 4 定位过程

### 4.1 方法与纪律

单变量（每次只改一个开关）；判据前置（执行前明确判定标准）；证据分级（§1.4）；每轮实验落盘日志。

### 4.2 逐层排除

**（1）应用层与请求**：绕过父进程直接执行 `next start` 同样崩溃（退出码 132）→ 排除应用层；无请求条件下同样崩溃 → 排除请求触发；`--jitless` 下不再 `SIGILL`（改为 `WebAssembly is not defined`、退出码 1）→ 确认故障需要 JIT/wasm 参与，同时揭示框架回退到 wasm 版 SWC。

**（2）平台侧其他原生代码**：`OPENSSL_riscvcap=` 置空后仍崩溃 → 排除 OpenSSL 向量汇编；对 `sharp`/`clipboard`/libvips 的独立探针**未能成功加载**（`MODULE_NOT_FOUND`、`TypeError` 等自身报错），未观察到 `SIGILL`，且故障发生时这些模块未被使用 → 该假设证据不足而非被证实；64 MiB 缓冲区遍历、`Atomics`、`Worker` 压力测试全部正常 → 排除通用运行时缺陷。

**（3）指令集扩展缺失**：板载 ISA 不含 `Zba/Zbb/Zcb/Zfa`，而现代工具链常按 RVA22/RVA23 画像生成指令，故该假设优先级最高。实验：V8 的 `--riscv-b-extension` 在本构建中默认即为关闭，显式关闭后仍崩溃；调试现场显示落点为全零页而非任何合法扩展指令 → **假设被否定**。

平台特性探测机制（据 Node v26.0.0 内嵌 V8 源码 `deps/v8/src/base/cpu.cc`，A 级）：riscv64 的 Linux 分支在**编译期**按 `V8_GLIBC_PREREQ(2, 39)` 二选一——满足则调用 `syscall(__NR_riscv_hwprobe, …)`，否则解析 `/proc/cpuinfo` 的 `isa` 字段；**两条路径均不使用 `getauxval(AT_HWCAP)`**。（注：V8 main 已将 riscv64 探测代码移至 `src/base/cpu/cpu-riscv.cc` 并改为无条件使用 hwprobe；本报告以 v26.0.0 为准。）本二进制采用前者，而内核 6.1.15 无该系统调用（`ENOSYS`），故 V8 获得空特性集——这与实测现象一致：V8 判定本机不支持 wasm SIMD，含 SIMD 的模块（如 `llhttp.wasm`）在编译期即被拒绝。

**（4）内存回收竞态**：崩溃时后台存在 4 个 `node-V8Worker` 执行 `ConcurrentMarking`。实验：`--no-wasm-code-gc`、`--no-flush-code-based-on-time`、`--no-flush-code-based-on-tab-visibility`、`--no-flush-baseline-code`、`--no-flush-liftoff-code`、`--no-flush-bytecode` 全部关闭后仍崩溃，页内偏移不变 → 排除。该负结果同时表明：全零页**不是被回收清零的旧代码**，而是从未写入的预留区域（据源码，wasm 代码空间在 Linux 上整段以 RWX 映射，故落点为"可执行的零页"而非 `SIGSEGV`，B 级）。

**（5）编译后端、版本与构建口味**：`--no-liftoff`、`--no-wasm-tier-up` 均仍崩溃 → 排除单一后端缺陷；Node v24.20.0 同样复现 → 排除某次版本回归（未采集其签名）；pointer-compression 构建 3/3 同签名复现 → 排除"仅标准构建受影响"。

**（6）对照环境**：

**表 6　对照实验与负结果**

| 实验 | 设置 | 结果 |
|---|---|---|
| QEMU 短测 | 同一 Node 二进制与应用，`qemu-system-riscv64 -cpu max`，主线内核 7.2.0-rc7，glibc 2.38 镜像 | 运行至 300 s 超时（`EXIT=124`），未崩溃 |
| QEMU 长测 | 同上，每 60 s 请求一次 | 约 900 s 未崩溃；但至少 2 次请求失败（t=60 s、t=660 s），进程最终被超时终止 |
| 附注 | TCG 模式下 wasm-SWC 配置编译 | 耗时约 4.1 分钟，编译完成 |
| 手写小型模块 | 45 字节 `add` 模块调用 50 万次；5,000 个平凡导出函数的模块 | 均未复现 |
| `--trace-wasm-lazy-compilation` | 关闭/开启惰性编译各一组 | **两组均无任何 trace 输出** → 该探针在本构建中失效（负结果） |
| QEMU 客户机 + 自建合成模块 | `-cpu max`，内核 7.2.0-rc7，同一 node 二进制 | **N=30000/i=29999 与 N=45000/i=0 均 `SIGILL`**；对照组正常（§4.2） |

**QEMU 对照的结论（2026-09-16 更新，A 级）**：早期在 QEMU 客户机内运行**该应用** 900 s 未崩溃，曾被记为"不复现"。本轮改用自建合成模块在同一客户机（内核 7.2.0-rc7、ISA 扩展齐全、含 `riscv_hwprobe`）内复测：

| 客户机内实验 | 结果 |
|---|---|
| `llhttp.wasm`（含 SIMD）编译 | **成功**（真机上被拒绝为 `Wasm SIMD unsupported`）→ 印证两环境特性探测不同 |
| N=30,000，i=29,999 | **`SIGILL`（rc=132）**，与真机一致 |
| N=25,000，i=24,999 | 正常（与真机一致） |
| N=45,000，i=0 | **`SIGILL`（rc=132）**，与真机一致 |
| N=30,000 + 关闭惰性编译 | 正常（对照） |

因此可以判定：**该缺陷并非真机特有**——QEMU 客户机内同样可触发，且触发与否取决于 N 与 i（§5.4）。至于"跳转距离与特性探测无关"，其依据是源码结构（B 级推断）：本轮 QEMU 对照**并未控制特性探测这一变量**（未构造屏蔽 Zb*/Zfa 的客户机），故该点仅作推断记录。早前应用级"不复现"的**最可能原因**是那次运行中首次惰性编译调用的下标落在射程内（该次运行未采集 `t0`/下标，属未直接观测的归因）。客户机内崩溃记录同样显示 `t0` 等于被调用函数下标，与真机结论一致（该次记录未保存完整寄存器块，列 §5.1 作旁证）。

### 4.3 排除矩阵

**表 7　假设排除矩阵**

| # | 假设 | 结论 | 等级 |
|---|---|---|---|
| 1 | 应用层缺陷 | 排除（裸 `next start` 同样崩溃） | A |
| 2 | 请求触发 | 排除（无请求同样崩溃） | A |
| 3 | 与 JIT/wasm 无关 | 排除（`--jitless` 后不再 `SIGILL`） | A |
| 4 | OpenSSL 向量汇编 | 排除 | A |
| 5 | 第三方原生模块 | 证据不足（探针未成功加载）；故障时未被使用 | B |
| 6 | CPU 指令集扩展缺失 | 排除（开关默认关；现场为全零页） | A |
| 7 | 内存回收竞态 | 排除（六类开关全关仍复现） | A |
| 8 | 单一编译后端缺陷 | 排除（两种后端配置均复现） | A |
| 9 | 版本回归 | 排除（v24.20.0 同样复现） | A |
| 10 | 仅标准构建受影响 | 排除（pc 构建 3/3 同签名） | A |
| 11 | 真机硬件缺陷 | 证据不足（开关干预即可消除） | A |
| 12 | QEMU 与真机的差异 | 合成模块在 QEMU 内同样可触发 ⇒ 该缺陷非真机特有。早前应用级负结果的归因属**推断**：最可能是窗口内惰性调用下标未越界，但也可能源于特性探测差异导致的调用路径不同（客户机可编译 SIMD 模块，真机不能）或 TCG 时序下未触达 | B |
| 13 | wasm 惰性编译机制 | **确认**（关闭即 100% 消除） | A |
| 14 | `JAL` 越界截断 | **确认**（本机反汇编与几何实测，见 §5） | A（机制）／B（归因） |

---

## 5 根因分析

### 5.1 机制：wasm 惰性编译与跳转槽

V8 对 wasm 模块默认启用惰性编译（`--wasm-lazy-compilation`）：模块实例化时不编译函数体，只为每个函数在跳转表中放置一个"跳转槽"；函数首次被调用时经占位代码触发即时编译，随后跳转槽被改写为直接指向真实代码。

据 Node v26.0.0 内嵌 V8 源码（`src/wasm/jump-table-assembler.cc`），相关函数为 `JumpTableAssembler::EmitLazyCompileJumpSlot(uint32_t func_index, Address lazy_compile_target)`；riscv64 上修复前的跳槽为 3 条指令（12 字节）。**本机实测**（gdb 停止于 `SIGILL` 时扫描可执行代码空间）得到的 27566 号函数槽位为：

```text
slot = 0x3fa85cc768
   b7 72 00 00    lui  t0, 7
   93 82 e2 ba    addi t0, t0, -1106
   6f f0 8f 2b    jal  x0, +0xff2b8      ← rd = 0（不写 ra）
```

与 V8 的约定互相印证（`kWasmCompileLazyFuncIndexRegister = t0`；函数编号经 `lui/addi` 重建）：

```text
func_index = 27566 = 0x6bae
hi20 = (27566 + 0x800) >> 12 = 7        → t0 = 0x7000
lo12 = sign12(27566 & 0xfff) = −1106    → t0 = 0x7000 − 0x452 = 0x6bae  ✓
```

被测模块含 29,955 个函数，故 27566 为合法索引（A 级）。**函数编号语义的独立佐证**：在合成模块场景中，崩溃内核记录的 `t0` 分别等于被调用的函数下标（i = 29,999 → `t0 = 0x752f`；i = 0 → `t0 = 0`，见归档 `raw/board-2026-09-16/synth-slot-0916-1541.txt`）。跳转使用 `jal x0`（rd=0）**不写 `ra`**，因此 `ra` 保留 JS→wasm 跳板的返回地址——这与现场观测一致。该跳转的直接目标是 **far jump table 中 `WasmCompileLazy` 的槽位**，再由该槽位间接到内建实现（B 级：据源码结构）。值得对照的是，riscv64 主跳表的 `EmitJumpSlot` 本就实现了近/远两种形态（`jal` 与 `auipc+ld+jalr`），唯独惰性编译跳槽缺少远形态。

### 5.2 `JAL` 射程与静默截断

`JAL` 采用 21 位有符号立即数（最低位隐含为 0），射程为 **±1 MiB**。超过该距离的跳转必须改用 `AUIPC`+`JALR` 组合。据上游修复提交与源码：实现中存在断言 `DCHECK(is_int21(target_offset))`，但 `DCHECK` 仅在调试构建生效，**在 release 构建中被编译移除**；偏移越界时无任何告警，按 21 位字段截断（等价于对 `0x200000` 取模），生成"编码合法但目标错误"的跳转。

### 5.3 几何实测（2026-09-16，A 级）

**表 8　跳转几何的直接测量**

| 量 | 实测值 |
|---|---|
| 跳槽地址 | `0x3fa85cc768` |
| JAL 指令地址 | `0x3fa85cc770` |
| JAL 编码的（已截断）偏移 | `+0xff2b8` = +1,045,176 |
| 由编码偏移算得的落点 | `0x3fa86cba28`（页内 `0xa28`）＝ gdb 实测 `$pc` ＝ 内核 `epc` |
| 真实目标（far jump table 槽位） | `0x3fa84cba28`，其内容为 `auipc t6,0 / ld t6,16(t6) / jr t6`（far jump table 槽位标准形态；`ld` 的偏移 16 与 V8 的 `ld(rd, rd, 4*kInstrSize)` 一致） |
| **真实距离** | **−1,051,976 字节（−0x100d48）**，即**超出 −1 MiB 射程 3,400 字节**（1,051,976 − 1,048,576 = 3,400） |
| 其余候选（+1/+2/−2 MiB） | 均为内容全零的页 |

即：真实偏移因超出 21 位有符号范围而被取模为 `+0xff2b8`，执行流因此落到 `0x3fa86cba28` 的全零页。**这与上游提交正文所述"静默截断并重定向到非预期地址"完全一致，且为本机一手观测。**

### 5.4 触发条件与阈值

**模型**：据 Node v26.0.0 内嵌 V8 源码，riscv64 上主跳表槽与 far 表槽均为 24 字节（far 表每个声明函数一个），惰性表槽为 12 字节，三张表按此顺序在同一代码空间中分配；主跳表的 `24·N` 项在"惰性槽 → far 目标"这一距离中相消，故

```
|distance| ≈ 24·N + 12·d + K
```

其中 `N` 为模块声明函数数，`d` 为被调用函数的**声明下标**（跳槽写入 `t0` 的是 `d + 导入函数数`：pi-web 场景模块有 64 个导入，故 `t0 = 27,566` 对应 `d = 27,502`），`K` 为由构建与模块导入数决定的常数（同一构建、零导入模块约 3.0 KB）。要点：

1. 系数 24 与 12 有源码依据并获实验支持；`K` 由单个真机实测点反解，**其绝对值未经独立标定**——下方合成模块实验验证的是"越界／射程内"的**二元判定**，表中预测距离属模型值，不应视为独立测量；
2. 阈值条件为 `24N + 12d > 2^20 − K`。**N 与 d 的影响同阶**——`d` 从 0 变到 30,000 相当于 36 万字节，约可移动阈值 1.5 万个函数。因此"模块越大越危险"并不准确：`d = 0` 时阈值约 4.4 万函数，而 `d` 取大值时阈值可低至约 2.9 万函数；
3. 与实验一致：`d = 0` 时 N = 40,000 不触发、N = 45,000 触发；N = 30,000 且 `d = 29,999` 触发，而同一模块 `d = 0` 不触发；
4. **本机实测的真实距离 −1,051,976 字节仅超出射程 3,400 字节**，与"函数数刚过阈值即触发"的推断相符；
5. 被调用函数的声明下标（pi-web 场景 27,502）位于跳表远端，这一点已由实测距离（约 1.05 MB）间接印证；"其为 wasm-bindgen 置于末尾的 JS 入口"仍属推测（B 级）。

> 早期依据源码结构推导的含未知常量式（形如 `48N + 24B + …`）与实测不符——它推出的"N ≈ 2.1–2.2 万即整表越界"已被本节实验否定（N = 40,000 且 `d = 0` 并不触发），其 48 的系数把主跳表重复计入。**本报告以 `24N + 12d + K` 为准**；适用边界为同一 V8 版本与同一构建，且 `K` 与模块导入数有关。

#### 5.4.1 合成模块验证（最小复现，2026-09-16）

为剥离第三方应用、并直接检验"阈值由 N 与首次调用下标 i 共同决定"，本节使用自建 wasm 模块：模块含 N 个平凡函数并导出函数表，由 JS 驱动**精确指定首次惰性调用（即首次编译）的函数下标**。模型预测与实测对照如下（模型 `|distance| ≈ 24N + 12d + K`；下表预测距离按 pi-web 场景反解的常数计算，对零导入的合成模块常数约 3.0 KB，故绝对值仅为模型值，判定以"越界／射程内"的二元结论为准）：

**表 9　合成模块的阈值验证（真机，标准 v26.0.0）**

| N | 首次调用下标 i | 预测距离 | 预测 | 实测 |
|---|---|---|---|---|
| 5,000 | 4,999 | 182,252 | 射程内 | 正常（`CALL_OK`） |
| 15,000 | 14,999 | 542,252 | 射程内 | 正常 |
| 25,000 | 24,999 | 902,252 | 射程内 | 正常 |
| **30,000** | **29,999** | 1,082,252 | **越界** | **`SIGILL`（rc=132）** |
| **30,000** | **0** | 722,264 | 射程内 | 正常 |
| 40,000 | 0 | 962,264 | 射程内 | 正常 |
| **45,000** | **0** | 1,082,264 | **越界** | **`SIGILL`（rc=132）** |
| 30,000 | 29,999（关闭惰性编译） | — | 对照 | 正常 |

7/7 与预测一致（另 1 组为关闭惰性编译的对照），其中两项为判别性实验：**同一模块（N=30,000）仅改变首次调用下标即由崩溃变为正常**；**更大的模块（N=40,000）因下标为 0 反而不崩溃**。这同时说明：

1. **触发条件确实由 `24N + 12d` 共同决定**，而非"模块越大越危险"；
2. 该缺陷可在**不依赖任何第三方应用**的情况下复现（模块与驱动脚本见 `tools/`），复现成本从"安装一个 Web 应用"降为"一个 0.24 MB 的 wasm 文件（253,544 字节）+ 20 行 JS"；
3. 落点页内偏移随模块布局变化（本组为 `0xe48` / `0xc88`，与 pi-web 场景的 `0xa28` 不同），印证"页内偏移由布局决定、每个 (模块, 下标) 组合各自确定"。

**复现命令与判定**（真机、修复前 Node）：

```bash
python3 tools/gen_wasm.py 30000 m30000.wasm     # 253,544 B；sha256 c0756c0e1a524ad5…c7939
node              tools/slot_caller.js 29999 m30000.wasm ; echo rc=$?   # 预期 rc=132（触发）
node              tools/slot_caller.js     0 m30000.wasm                # 预期 CALL_OK result=0
node --no-wasm-lazy-compilation tools/slot_caller.js 29999 m30000.wasm  # 对照：CALL_OK result=0
```

**原始日志**：`raw/board-2026-09-16/synth-slot-0916-1541.txt`（7 组实验 + 1 组对照；文末补录了两次崩溃的完整寄存器块，含 `status/badaddr/cause` 与等于被调用下标的 `t0`）。资产说明见 §6.6，完整命令见附录 B.6。

### 5.5 与上游修复的对应关系（已核实）

**表 10　上游修复提交信息（A 级，经公开来源核实）**

| 项 | 内容 |
|---|---|
| 完整哈希 | `def38dd3f8726ed595932624ee5d681a3f02ed4a` |
| 标题 | `[riscv] Replace JAL with AUIPC/JALR in lazy compile jump slots` |
| 作者 / 日期 | LuYahan `<yahan@iscas.ac.cn>`（ISCAS）；作者日期 2026-08-27，合入 main 2026-08-31（`refs/heads/main@{#109580}`） |
| 评审链接 | https://chromium-review.googlesource.com/c/v8/v8/+/8301500 |
| 关联缺陷 | `Fixed: 539663717`（Chromium 安全问题编号） |
| 改动文件 | `src/wasm/jump-table-assembler.cc`（+25/−16）、`src/wasm/jump-table-assembler.h`（+2/−2）；**riscv32 一并修改** |
| 修复内容 | 跳槽由 3 条指令改为 4 条（12 B → 16 B）：`auipc t6` + `jalr x0, t6, lo12`；`DCHECK(is_int21)` → release 同样生效的 `CHECK(is_int32)` |
| 提交正文（节选） | "For large Wasm modules, the target offset can exceed the 21-bit signed range of JAL. In release builds, the existing DCHECK was omitted, causing the offset to be **silently truncated modulo 0x200000**. This could redirect execution to an unintended address, **skipping security checks and leading to memory corruption**." |

**归因边界（B 级）**：提交正文将后果描述为"可能跳过安全检查、导致内存损坏"，**未提及 `SIGILL` 或全零页**。因此"该提交即本次崩溃的根因修复"在**归因层面**仍属推断。可以确定的是**机制层面**已由本机直接观测确证（§5.3）：真实跳转距离确实越界、编码偏移确实被截断、截断后的落点确实与崩溃 `PC` 一致，且修复所针对的正是同一条指令路径。

**当前传导状态（2026-09-16 核实）**：

| 环节 | 状态 |
|---|---|
| V8 | 已修复并合入 main |
| Node.js | **所有分支均未包含**：检索该提交哈希命中 0；逐一核对源码（v26.0.0、v26.8.2、main 的 `deps/v8/src/wasm/jump-table-assembler.cc`）**三者均为修复前实现**（存在 `DCHECK(is_int21(target_offset))`、无 `CHECK(is_int32)`），而 V8 main 已含修复。相关 issue（#65724）仍 open，维护者意见为"等 V8 更新合入后再考虑回移，否则会被覆盖"（§7.4） |
| Next.js | 未适配 riscv64（平台三元组表缺项），故必然回退 wasm |
| 应用（pi-web） | 未注入缓解标志（issue #685 open） |

### 5.6 根因链

```
应用层：Next.js 无 riscv64 原生 SWC 绑定 → 加载 wasm 版 SWC（29,955 个函数）
   ↓
引擎层：V8 惰性编译为每个函数放置跳转槽（li t0, idx; j 惰性编译入口）
   ↓
数据层：该跳转的真实距离 −1,051,976 字节 > JAL 的 ±1 MiB 射程（超出 3,400 字节）
   ↓
缺陷层：偏移在 release 构建中被静默取模为 +0xff2b8
   ↓
结果层：落点 0x3fa86cba28 为从未写入的全零页 → CPU 取到 16 位全零编码（非法）
   ↓
内核层：cause=2（非法指令，判别性）、badaddr=0（一致性检查）、SIGILL → 进程终止
```

---

## 6 修复方案与验证

### 6.1 方案分级

**表 11　缓解与修复路径**

| 层级 | 措施 | 生效范围 | 状态 |
|---|---|---|---|
| ① 运行时绕过 | `--no-wasm-lazy-compilation` | 本机 / 本应用 | **已实测验收**（§6.3） |
| ② 版本分发 | Node.js 合入 V8 修复 | 全部 riscv64 用户 | 未实现：上游尚无该修复的 cherry-pick（§5.5） |
| ③ 上游与生态根治 | V8 修复（已落地）＋ Next.js 补齐 riscv64 三元组并提供原生 SWC | 全平台 | V8 侧已落地；下游为建议 |

层级 ① 属于**绕过缺陷代码路径**（关闭惰性编译后跳槽占位代码不再生成），并非修复缺陷；层级 ②③ 才是根治手段。

### 6.2 实现

被测应用的进程结构为"父进程派生子进程"，标志必须作用于子进程。三种传递途径比较如下（A 级）：

**表 12　V8 标志传递途径比较**

| 途径 | 结果 | 原因 |
|---|---|---|
| `NODE_OPTIONS=--no-wasm-lazy-compilation` | 被拒绝 | Node.js 对 `NODE_OPTIONS` 中的 V8 标志设有白名单 |
| `spawn(..., { execArgv: [...] })` | 无效 | `execArgv` 仅为 `child_process.fork()` 的文档化选项，`spawn()` 不支持；相关工单已由维护者以 `not_planned` 关闭 |
| 置于子进程 argv | **生效** | 等价于手工执行 `node <flags> script.js` |

补丁（仅对 riscv64 生效，其它平台行为不变）：

```diff
-const child = spawn(process.execPath, [nextBin, ...nextArgs], {
+const child = spawn(
+  process.execPath,
+  [
+    // riscv64 缓解：V8 wasm 惰性编译在 riscv64 上可能跳入未填充代码页。
+    ...(process.arch === "riscv64" ? ["--no-wasm-lazy-compilation"] : []),
+    nextBin,
+    ...nextArgs,
+  ],
+  {
     cwd: pkgDir,
     stdio: ["inherit", "pipe", "inherit"],
     env: { ...process.env, PI_WEB_HOSTNAME: hostname },
-});
+  }
+);
```

由于补丁位于依赖包内、依赖升级后会被覆盖，附录 C 提供幂等重打脚本。

### 6.3 验证结果

**验收协议**：① 启动后 15/45/75 s 各发起一次 `GET /`，均需 HTTP 200 且内容稳定；② 观测窗口内内核 `unhandled signal 4` 计数为 0；③ 服务日志出现 wasm-SWC 配置编译完成记录；④ 连续运行 90 s 以上无异常，且同环境下对照组必须复现崩溃。

**表 13　验收结果**

| 指标 | 结果 |
|---|---|
| `GET /`（15 / 45 / 75 s） | 三次均 HTTP 200，返回 9756 字节页面（标题 `Pi Web`） |
| 内核 `SIGILL` 计数 | 0 |
| 配置编译记录 | `✓ Running next.config.ts took 4.5s`（另一轮 3.4 s） |
| 连续运行 | 90 s 以上无异常 |
| 对照组 | 同环境必现终止（受控重复 20/20） |

### 6.4 代价

**表 14　运行时绕过路径的代价**

| 指标 | 实验组（关闭惰性编译） | 对照组（默认） | 说明 | 等级 |
|---|---|---|---|---|
| 就绪时间 | 1.51–1.76 s（5 样本，中位 1.56 s） | 1.58–1.90 s（20 样本，中位 1.66 s） | 两组分列，来源见 §2.3 | A |
| 配置编译耗时 | 3.3–5.3 s（两轮分别 3.4 / 4.5 s） | 未完成即终止 | 对照组无有效数据，仅给绝对值 | A |
| 常驻内存（RSS） | 稳态约 **323.3 MB**（30 次采样，进入平台期） | 崩溃前末次约 114.7 MB（t≈5 s，未进入稳态） | 两组状态不等价，故不作差值 | A |
| QEMU/TCG 下同类操作 | 约 4.1 分钟（可完成） | — | 仅作旁证 | A |
| 影响范围 | 仅 wasm 惰性编译 | — | JS 执行路径不受影响（据机制） | B |

**结论**：就绪时间基本不变；启动阶段全量编译使配置编译耗时可观测（弱算力环境显著更慢）；常驻内存进入约 323 MB 的平台期。由于对照组在约 5 s 即崩溃、从未进入等效稳态，本报告不给出"内存增量"的严格差值。

### 6.5 未完成的验证

- **根治方案的回归验证**：经逐项查证——① unofficial-builds 最新 riscv64 release 为 v26.0.0（2026-05-05），早于修复（2026-08-31），且无 v27 通道、nightly 亦无 riscv64；② 官方发布线 v26.8.2 的源码仍为修复前实现；③ Node **main** 分支的对应源码亦仍为修复前实现。故**当前不存在可用于回归的 Node 构建**，除非自行把 V8 修复点滚入 Node（超出本报告范围）。
- **阈值扫描与不依赖第三方应用的最小复现**：**已完成**（§5.4.1：7 组预测 7/7 命中距离模型，另 1 组为对照）。

---

### 6.6 复现资产

为让第三方**不依赖任何第三方应用**即可复核本报告的核心结论，本课题提供以下可独立执行的资产（均在 `tools/`）：

| 资产 | 作用 | 依赖 |
|---|---|---|
| `gen_wasm.py` | 生成含 N 个函数的 wasm 模块并导出函数表（确定性输出，同 N 的 sha256 跨机一致） | Python 3 |
| `slot_caller.js` | 实例化模块并把**首次惰性编译调用**精确指向指定下标 i | Node.js |
| `scan_slot.py` | 崩溃后（gdb 停止于 SIGILL 时）扫描代码空间，定位惰性跳槽并解码 JAL 立即数、复算落点 | Python 3 + gdb |
| `md2pdf.py` | 由 Markdown 重建本报告 PDF | reportlab + 中文字体 |

**三步复现（riscv64 + 修复前 Node v26.0.0 unofficial-builds）**：

1. 生成模块：`python3 tools/gen_wasm.py 30000 m30000.wasm` → 253,544 字节，sha256 `c0756c0e1a524ad52bf0ed1597d7a3449a4d2e96bdb4180ddcad989f216c7939`；
2. 触发：`node tools/slot_caller.js 29999 m30000.wasm` → 预期被 `SIGILL` 终止（`rc=132`），无 `CALL_OK`；
3. 对照：`node --no-wasm-lazy-compilation tools/slot_caller.js 29999 m30000.wasm` → 预期 `CALL_OK result=0`（`rc=0`）。

**判定标准（必须按此读，不能只看 rc）**：

- `rc=132` 且无 `CALL_OK` ⇒ **触发缺陷**；
- `rc=0` 且有 `CALL_OK result=0` ⇒ 正常调用；
- 出现 `ERR`（脚本以 `rc=3` 退出）⇒ 参数或下标越界等脚本级错误，**不是崩溃**；
- 内核侧核对：`cause=2`（判别性）、`badaddr=0`（一致性检查，非判别性）、`t0` 等于被调用的函数下标。

**三条已知陷阱（实测踩中，已修入脚本）**：

1. 在 `--no-wasm-lazy-compilation`（急切编译）下，`WebAssembly.instantiate` 需异步编译全部函数；**若事件循环先空，Node 会正常退出（`rc=0`）且无任何输出**——这会让人把"未完成"误读为"调用成功"。故驱动中显式保活（`setInterval`）。
2. 旧版驱动的越界下标只打印 `ERR` 却以 `rc=0` 退出；现已改为 `rc=3`。
3. `gen_wasm.py` 传入非正数或非整数时旧版会死循环/抛裸异常；现已改为明确报错退出。

**环境与边界**：必须在 riscv64 上运行（`JAL` 是 riscv64 专属代码路径）；**x86_64 上同一模块预期不崩溃**，属架构对照而非复现环境。`--no-wasm-lazy-compilation` 是**必需对照**——它是把"惰性编译跳槽"与其它 wasm 缺陷区分开的判别性实验。合成模块的实测资源占用：生成 45,000 函数模块约 0.2 s、写入 388,544 字节，Node 侧峰值内存约 55 MB。

**局限**：仅修复前的 Node 可触发，不能用于验证修复后行为；`wasm_bg.wasm` 属 Next.js 产物，需第三方自行获取，不随本报告分发。

---

## 7 结论与建议

### 7.1 结论

1. 故障直接原因是执行流跳入内容全零的可执行页，触发 RISC-V 非法指令异常（`cause=2`，`badaddr=0`），进程被 `SIGILL` 终止；在受控重复中 20/20 复现，且全新安装后同样复现。
2. 根因是 wasm 惰性编译跳槽跳向惰性编译入口的长跳转采用 `JAL`，±1 MiB 射程不足；越界偏移在 release 构建中因断言被移除而被静默截断。该机制已在本机直接测量（真实距离 −1,051,976 字节、截断落点与崩溃 `PC` 逐位一致），并与已核实的上游修复提交逐条吻合。
3. 触发条件是 riscv64、启用 wasm 惰性编译、且被调用函数的声明下标与模块函数数满足 `24N + 12d > 2^20 − K`（自建模块 7 组二元预测 7/7 命中，另 1 组对照）；与构建口味无关（两种构建均复现、关键签名一致）。
4. 缓解方面：`--no-wasm-lazy-compilation` 可 100% 消除故障并通过全部验收指标，代价为启动阶段全量编译与约 323 MB 的常驻内存；根治需依赖 V8 修复随 Node 版本分发。
5. 根因链的上游环节是 Next.js 平台三元组表缺少 riscv64，使框架必然回退到 wasm 实现；补齐映射并提供原生 SWC 预编译产物是生态级措施。

### 7.2 给使用者的建议

在 riscv64 上运行同类应用（Next.js + wasm 回退路径）时：

1. 优先使用 §6.2 的运行时标志；若应用不便修改，可用包装脚本以 argv 方式注入（**不要**依赖 `NODE_OPTIONS` 或 `spawn` 的 `execArgv`）；
2. 关注启动阶段耗时与内存是否可接受（本例约 3–5 s 配置编译、约 320 MB 常驻）；
3. 保留崩溃现场（`journalctl -k`），并按附录 B 的命令做一次对照验证。

### 7.3 给下游项目的建议

1. **应用侧**：在 riscv64 上自动注入该标志（可作为平台条件分支实现，不影响其它平台）；
2. **框架侧（Next.js）**：在平台三元组表中补齐 riscv64 映射；但需同时保证"原生绑定缺失时安全回退到 wasm"，否则补齐映射只会把失败点提前；
3. **引擎侧（V8/Node）**：见 §7.4。

### 7.4 上游现状与建议路径

- **V8**：缺陷已修复（表 10），无需再次修改；
- **Node.js**：尚未包含该修复。维护者在 `nodejs/node#65724` 的意见为：*"The fix literally landed upstream this week… We should wait for the V8 update to be merged before thinking about cherry-picking, otherwise it'll just be overwritten."* 即正规路径是等待 V8 更新（roll-up）合入，而非手动 cherry-pick；
- 该提交带安全问题编号（`Fixed: 539663717`），此类修复的版本回移通常由 Node 的安全发布流程处理。因此本报告**不建议**以公开 PR 形式提交 cherry-pick；建议以"补齐现场证据 + 提供真机验证能力"的方式参与（如在本报告所述环境下代跑含修复版本的对照实验）。
- **安全表述提示**：公开讨论时引用上游原话即可，不宜自行推断安全影响范围。

### 7.5 本课题的公开产出与协作记录

定位与验证完成后，本课题向上游提交了以下公开工单；它们是可点开核验的产出，并与报告各节证据一一对应：

- **`nodejs/node#65724`**（2026-09-01 提交，open，含 2 条评论）：主工单。内容包含本报告的现场证据链（内核记录字段、gdb 现场、排除矩阵、复现率）与最小复现方法。维护者（Renegade334）回复确认"该修复已于本周在上游落地"（指向 V8 评审 CL 8301500），并建议**等待 V8 更新合入后再考虑回移，否则会被覆盖**——这构成本报告 §5.5 与 §7.4 对上游状态判断的依据。本课题已于 2026-09-16 在该工单追加补充与更正评论（受控复现统计、最小复现与阈值验证、QEMU 对照、Node 各分支状态）：`https://github.com/nodejs/node/issues/65724#issuecomment-5693846442` 。
- **`nodejs/node#64538` 交叉说明**：在第三方并发讨论（riscv64 wasm 非法指令，涉 RVV/SIMD 路径）下提交交叉引用，说明本案例与其在现象上的差异（本构建在编译期即拒绝含 SIMD 的模块、崩溃记录 `badaddr=0`、pc 构建同签名），以免两条线索混淆。
- **`agegr/pi-web#685`**（2026-09-01 提交，open）：下游应用止血请求。说明该应用在 riscv64 上需要注入 `--no-wasm-lazy-compilation`，并附本报告 §6 的验证数据（补丁前后对照、验收指标）。
- **`nodejs/node#65725`**（2026-09-01 提交，2026-09-03 以 `not_planned` 关闭）：实现缓解措施过程中发现的旁支问题——`spawn()` 的 `execArgv` 选项未生效。**维护者指出该选项仅在 `fork()` 中定义**，属本课题早期对 API 边界的理解偏差；本报告 §6.2 与表 12 已按更正后的事实表述（`spawn()` 不支持该选项），该工单仅作为过程记录保留。

**边界声明**：上述工单均由本课题自行提交，属于**公开产出与协作记录，不作为根因结论的独立第三方证据**；本报告的证据基础是 §3–§5 的第一手实测，以及 §5.5 中已核实的上游提交。工单状态为 2026-09-16 的快照。

**快照说明**：`#65724` 的正文为提交时（2026-09-01）的快照，其中"就绪后 5–8 s"的时间窗与"V8 回退到 `AT_HWCAP`"的特性探测表述，已由本报告 §2.3、§4.2 依据后续实测修正；2026-09-16 的追加评论即为该更正与补充的公开记录。两者若有出入，以本报告为准。

### 7.6 未解决问题

**表 15　未解决问题清单**

| # | 问题 | 现状 | 等级 |
|---|---|---|---|
| 1 | 含该修复的 Node 版本上的回归验证 | 无可用构建：V8 main 已含修复，但 Node v26.0.0 / v26.8.2 / main 三者均为修复前实现，且 riscv64 无二进制（已逐项查证） | C |
| 2 | Node v24.20.0 的签名采集 | 仅确认复现，未采集 `epc`/`t0`/`badaddr` | C |
| 3 | 归因层面（该提交与本次崩溃的对应） | 机制已实测确证；归因需上游确认 | B |
| 4 | QEMU 侧未受控的变量 | 本轮 QEMU 对照未屏蔽 Zb*/Zfa 等扩展，若需严格隔离"特性探测→布局"这一变量，需 rv64gc 用户态 rootfs 或 6.1.15 内核客户机 | C |
| 5 | 对照组的等效稳态内存 | 无法测得（其在约 5 s 崩溃） | C |

---

## 附录 A　关键原始记录

**A.1 内核异常记录（单次完整，2026-09-01 15:30:55）**

```text
next-server (v1[5339]: unhandled signal 4 code 0x1 at 0x0000003f366c7a28
CPU: 3 PID: 5339 Comm: next-server (v1 Not tainted 6.1.15 #1.0.15.1
Hardware name: SiPEED LPi3A Board (DT)
epc : 0000003f366c7a28 ra : 0000002abf26e458 sp : 0000003ffc07cfc0
 gp : 0000002ac4300140 tp : 0000003f84cda0c0 t0 : 0000000000006bae
 t1 : 0000003f364b9250 t2 : 0000003ffc07d160 s0 : 0000003ffc07cfe8
 s1 : 0000003ffc07d160 a0 : 0000003f55ab82d1 a1 : 0000000000001610
 a2 : 0000003f54c53259 a3 : 0000003ffc07d148 a4 : 0000003f55130321
 a5 : 0000003f54cbe491 a6 : 483a5c3795cc2200 a7 : 0000003f548a8ff9
 s2 : 0000003ffc07d190 s3 : 0000000000000001 s4 : 0000000000000010
 s5 : 0000002ac430fdf8 s6 : 0000002ac441f100 s7 : 0000000000001810
 s8 : 0000000000000001 s9 : 0000000000000000 s10: 0000003f842c0011
 s11: 0000000000000003 t3 : 0000003f75ffc000 t4 : 0000002ac4415d58
 t5 : 0000002ac4422100 t6 : 0000003f365c8768
status: 8000000200006020 badaddr: 0000000000000000 cause: 0000000000000002
```

**A.2 用户态现场与槽位扫描（单次运行，2026-09-16）**

```text
Thread 1 "next-server (v1" received signal SIGILL, Illegal instruction.
0x0000003fa86cba28 in ?? ()
(gdb) x/8i $pc        → 0x3fa86cba28: unimp（8 条，跨 16 字节）
(gdb) x/8xw $pc-16    → 32 字节全为 0x00000000
(gdb) info registers ra t0
ra  0x2aabf96458  <Builtins_JSToWasmWrapperAsm+184>
t0  0x6bae        27566
(gdb) shell python3 scan_slot.py
SLOT=0x3fa85cc768  BYTES=b7 72 00 00 93 82 e2 ba 6f f0 8f 2b
JALWORD=0x2b8ff06f  RD=0  DECODED_OFF=+0xff2b8
LANDING=0x3fa86cba28  LANDING_PAGEOFF=0xa28
```

**A.3 服务日志（对照 / 实验组）**

```text
# 对照组（默认）
✓ Ready in 1632ms
⚠ next-swc does not have native bindings support for target triple [object Object]. ...
[pi-web] Next.js exited unexpectedly (signal SIGILL)

# 实验组（--no-wasm-lazy-compilation）
✓ Ready in 1667ms
✓ Running next.config.ts took 4.5s
（15/45/75 s 三次 GET / 均返回 200，内核 SIGILL 计数 0）
```

## 附录 B　复现与验收命令

```bash
# 变量约定
P="$(npm root -g)/@agegr/pi-web"
NEXTBIN="$P/node_modules/next/dist/bin/next"
# 权限提示：读取内核日志需 root 或 adm/systemd-journal 组成员；gdb attach 需未受 ptrace_scope 限制

# B.1 复现（riscv64 平台；实测内存占用：崩溃前约 115 MB、稳定运行约 323 MB、合成模块约 55 MB）
npm i -g @agegr/pi-web@0.8.11
pi-web --port 30141
journalctl -k --no-pager | grep -A22 "signal 4" | tail -26

# B.2 对照与实验组
node "$NEXTBIN" start -p 30200 -H 127.0.0.1                        # 预期约 3.9 s 后 SIGILL
node --no-wasm-lazy-compilation "$NEXTBIN" start -p 30174 -H 127.0.0.1

# B.3 验收
for s in 15 30 30; do sleep $s; wget -qO- http://127.0.0.1:30174/ | head -c 60; done
journalctl -k --no-pager --since "-95s" | grep -c "unhandled signal 4"      # 期望 0

# B.4 崩溃统计（页内偏移应恒为 0xa28）
journalctl -k --no-pager | grep "unhandled signal 4" \
 | sed -E 's/.* at (0x[0-9a-f]+).*/\1/' \
 | while read -r a; do printf "%s offset=0x%x low21=0x%x\n" "$a" "$((a & 0xfff))" "$((a & 0x1fffff))"; done | tail -20

# B.5 槽位与几何测量（gdb 停止于 SIGILL 后扫描；脚本见附录 E 归档）
gdb -p <PID> -batch -q -ex "handle SIGILL stop print pass" -ex continue \
    -ex "p/x \$pc" -ex "x/8i \$pc" -ex "x/8xw \$pc-16" \
    -ex "info registers ra t0" -ex "info symbol \$ra" \
    -ex "shell python3 /path/to/scan_slot.py"
```

**B.6 合成模块最小复现（riscv64；x86_64 上同命令预期不崩溃）**

```bash
# 变量约定
P="$(npm root -g)/@agegr/pi-web"
NEXTBIN="$P/node_modules/next/dist/bin/next"
# 权限提示：读取内核日志需 root 或 adm/systemd-journal 组成员；gdb attach 需未受 ptrace_scope 限制

# 1) 生成模块（确定性输出）
python3 tools/gen_wasm.py 30000 m30000.wasm        # → 253544 B, sha256 c0756c0e…c7939
python3 tools/gen_wasm.py 45000 m45000.wasm        # → 388544 B, sha256 ac741486…f22c

# 2) 触发（预期 rc=132，无 CALL_OK）
node tools/slot_caller.js 29999 m30000.wasm; echo "rc=$?"
node tools/slot_caller.js     0 m45000.wasm; echo "rc=$?"

# 3) 判别性对照（同一模块仅换下标）
node tools/slot_caller.js     0 m30000.wasm        # 预期 CALL_OK result=0
node tools/slot_caller.js 24999 m25000.wasm        # 预期 CALL_OK result=0

# 4) 惰性编译对照（预期 CALL_OK result=0）
node --no-wasm-lazy-compilation tools/slot_caller.js 29999 m30000.wasm

# 5) 内核侧核对（cause=2 / badaddr=0 / t0 等于下标）
journalctl -k --no-pager | grep -A6 "unhandled signal 4" | tail -8

# 6) 槽位与几何（可选：在 gdb 停止于 SIGILL 时扫描；函数编号按上一步 t0 的十进制值传入）
gdb -p <PID> -batch -q -ex "handle SIGILL stop print pass" -ex continue \
    -ex "p/x \$pc" -ex "info registers ra t0" \
    -ex "shell python3 tools/scan_slot.py 29999"
```

## 附录 C　运行时缓解补丁与幂等脚本

```bash
#!/bin/bash
# 用法: bash ~/pi-web-riscv-fix.sh   （安装/升级 @agegr/pi-web 后重跑一次；幂等）
set -e
NB="$HOME/.local/node/bin"
JS="$HOME/.local/node/lib/node_modules/@agegr/pi-web/bin/pi-web.js"
[ -f "$JS" ] || { echo "未找到 $JS，请先安装 @agegr/pi-web"; exit 1; }

# 0) 事故自愈：若 pi-web.js 曾被 launcher 写穿（见工程提示），从 .orig 恢复
if head -1 "$JS" | grep -q '^#!/bin/sh'; then
  [ -f "$JS.orig" ] || { echo "pi-web.js 被覆盖且无 .orig，请重装"; exit 1; }
  cp -a "$JS.orig" "$JS"; echo "已从 .orig 恢复 pi-web.js"
fi

# 1) 保存原始文件
[ -f "$JS.orig" ] || cp -a "$JS" "$JS.orig"

# 2) 打补丁（幂等）
python3 - "$JS" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = """const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: pkgDir,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env, PI_WEB_HOSTNAME: hostname },
});"""
new = """const child = spawn(
  process.execPath,
  [
    // riscv64-wasm-lazy-workaround
    ...(process.arch === "riscv64" ? ["--no-wasm-lazy-compilation"] : []),
    nextBin,
    ...nextArgs,
  ],
  {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PI_WEB_HOSTNAME: hostname },
  }
);"""
if old in s:
    open(p, "w").write(s.replace(old, new)); print("patched")
elif "riscv64-wasm-lazy-workaround" in s:
    print("already patched")
else:
    print("上游 spawn 结构已变化，需人工合补丁"); sys.exit(1)
PY

# 3) 写 launcher —— 必须先删除 npm 的符号链接，否则 cat 会写穿到 pi-web.js
rm -f "$NB/pi-web"
cat > "$NB/pi-web" <<'SH'
#!/bin/sh
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/node" "$DIR/../lib/node_modules/@agegr/pi-web/bin/pi-web.js" "$@"
SH
chmod +x "$NB/pi-web"

# 4) 校验
"$NB/node" --check "$JS" >/dev/null && echo "OK: 补丁与 launcher 就绪"
```

**工程提示（本次实测踩中并已修正）**：npm 安装的全局命令 `~/.local/node/bin/pi-web` 是**指向 `bin/pi-web.js` 的符号链接**。若以 `cat > shim` 覆盖它，写入会穿透符号链接、把包内 JS 覆盖成 shell 脚本（症状为 `node --check` 语法错误、补丁标记消失）。脚本已加入两处防护：写 launcher 前先 `rm -f` 符号链接；启动时若发现 `pi-web.js` 首行是 `#!/bin/sh`，则从 `.orig` 自愈。

## 附录 D　术语表

| 术语 | 说明 | 本报告中的作用 |
|---|---|---|
| WebAssembly（wasm） | 可移植的二进制指令格式，运行时编译为本地机器码 | 缺陷载体 |
| 即时编译（JIT） | 运行期生成机器码 | 故障代码来源 |
| Liftoff / TurboFan | wasm 的基线 / 优化编译器 | 均被实验排除 |
| 惰性编译 | 函数首次调用时才编译，之前以跳转槽占位 | 缺陷所在机制 |
| 跳转表 / 跳转槽 | 每函数一个槽位，存放占位代码或真实代码地址 | `t0` 中函数编号的来源 |
| `kWasmCompileLazyFuncIndexRegister` | V8 中承载惰性编译函数编号的寄存器（riscv64 为 `t0`） | 解释 `t0=0x6bae` |
| far jump table | 长跳转目标表，槽位为 `auipc/ld/jr` 形态 | 实测确证跳转目标身份 |
| `JAL` | RISC-V 跳转指令，立即数 21 位，射程 ±1 MiB | 射程不足并发生截断 |
| `AUIPC` + `JALR` | 长距离跳转的标准组合 | 上游修复方式 |
| `DCHECK` / `CHECK` | 调试断言 / 发布构建同样生效的断言 | 前者被移除导致静默失败 |
| `unimp` | 全零指令字对应的非法指令伪指令 | 落点内容 |
| `cause=2` | RISC-V 非法指令异常原因码 | 关键判据 |
| `epc` / `ra` | 出错地址（此处为落点） / 返回地址 | 定位"跳到哪、由谁发起" |
| `badaddr`（`stval`） | 非法指令陷阱时写入的出错指令码或 0（规范两者皆允许）；**不是地址** | 一致性检查：值为 0 与"指令字为 0"相容，但**不具判别力** |
| `riscv_hwprobe` | 内核提供的 ISA 扩展探测接口（Linux 6.4 引入） | 6.1.15 缺失导致 V8 获得空特性集 |
| 指针压缩构建 | 将 64 位指针压缩为 32 位的 V8 构建配置 | 实测同样复现，故与构建口味无关 |

## 附录 E　证据归档与出处

| 内容 | 出处 |
|---|---|
| 内核日志、gdb 现场、排除矩阵、验收、20/20 复现与时间分布、重装实验、槽位反汇编与几何实测、RSS 实测、pc 构建签名、合成模块阈值验证、QEMU 客户机对照、环境/模块哈希/Node 分支源码核查/工单状态 | 本课题第一手实测。**归档目录** `raw/board-2026-09-16/`：`single.out`、`s3geo.out`、`sig-pc-v26.txt`、`repro-stats-*.txt`、`reinstall-*.log`、`rss-*`、`tA/tB.*`、`vanilla*.log`、`direct*.log`、`synth-slot-0916-1541.txt`、`qemu-guest-2026-09-16.txt`、`session-checks-2026-09-16.txt`（环境、模块 sha256/函数数、Node 三分支源码核查、unofficial-builds 状态、工单快照、RSS 汇总）；**会话记录** `raw/session-a34a0bd8-*.md`（2026-09-01 现场与上游核实）；**工具** `tools/gen_wasm.py`、`tools/slot_caller.js`、`tools/scan_slot.py`、`tools/md2pdf.py` |
| 上游修复提交信息（哈希/标题/作者/日期/内容/安全编号） | 公开提交 `def38dd3f8`（V8） |
| Node 侧状态、维护者意见与公开工单 | `nodejs/node#65724`（本课题提交，open，含维护者评论）、`nodejs/node#65725`（本课题提交，closed / not_planned）、`nodejs/node#64538`（第三方提交，open）、`agegr/pi-web#685`（本课题提交，open）；协作记录见 §7.5 |
| `riscv_hwprobe` 由 Linux 6.4 引入 | glibc 邮件列表“Update syscall lists for Linux 6.4”（2023-06-28） |
| Next.js 平台三元组缺失的公开平行案例 | Bruno Verachten，*The One-Line Patch That Unlocked Next.js on RISC-V*（2025-11-15） |

## 附录 F　检核清单（复现他人排查用）

```
[ ] 板卡/内核/glibc/Node/V8 版本与环境基线一致（表 1）
[ ] 默认配置连续运行 ≥10 次，全部在约 3.9 s 被 SIGILL（exit=132）
[ ] 关闭惰性编译后连续运行 ≥5 次，全部存活（对照成立）
[ ] 内核日志 cause=2（判别性）、badaddr=0（与全零指令字相容，非判别性）、epc 低 12 位 = 0xa28
[ ] gdb 现场：$pc 处 16 字节全零；ra 指向 Builtins_JSToWasmWrapperAsm
[ ] 扫描代码空间命中槽位，读出 lui/addi/jal 三指令与 rd=0
[ ] 解码 JAL 偏移并复算落点，与 $pc / epc 一致
[ ] 真实目标槽位形态为 `auipc t6,0 / ld t6,16(t6) / jr t6`（确证目标身份）
[ ] 记录真实距离是否越界（本例 −1,051,976 字节，超出 3,400 字节）
[ ] 补丁后 15/45/75 s GET / 均 200，内核 SIGILL 计数 0，连续运行 ≥90 s
[ ] 依赖升级后重跑幂等脚本并复验（附录 C）
```
