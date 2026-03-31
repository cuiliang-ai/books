# Chapter 13: Multi-platform Sandbox - Security Isolation in Codex CLI

## Introduction

The Codex CLI implements a sophisticated multi-platform sandboxing system that provides security isolation for AI-generated code execution across macOS, Linux, and Windows platforms. This chapter explores the architectural design, implementation details, and security mechanisms of the sandbox system, examining how it leverages platform-specific security technologies while maintaining a unified interface.

## Sandbox Architecture Overview

The sandbox system in Codex CLI is built around a layered architecture that abstracts platform-specific security mechanisms behind a common interface. The core components include:

```
┌─────────────────────────────────────────────────────┐
│                 Sandbox Manager                     │
├─────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐ │
│  │   macOS     │ │   Linux     │ │    Windows      │ │
│  │  Seatbelt   │ │   Landlock  │ │ RestrictedToken │ │
│  └─────────────┘ └─────────────┘ └─────────────────┘ │
├─────────────────────────────────────────────────────┤
│              Policy Transformation                  │
├─────────────────────────────────────────────────────┤
│  ┌─────────────────┐ ┌─────────────────────────────┐ │
│  │ FileSystem      │ │     Network                 │ │
│  │ Policies        │ │     Policies                │ │
│  └─────────────────┘ └─────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Core Sandbox Types

The system defines four primary sandbox types, each targeting specific platforms and use cases:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxType {
    None,
    MacosSeatbelt,
    LinuxSeccomp,
    WindowsRestrictedToken,
}
```

Each sandbox type provides different levels of isolation:

- **None**: No sandboxing (for development or testing scenarios)
- **MacosSeatbelt**: Uses Apple's Seatbelt framework for fine-grained access control
- **LinuxSeccomp**: Leverages Linux's Landlock LSM and seccomp-bpf filters
- **WindowsRestrictedToken**: Employs Windows restricted tokens and job objects

## Sandbox Manager Implementation

The `SandboxManager` serves as the central orchestrator for sandbox operations, handling sandbox selection, policy transformation, and command preparation.

### Sandbox Selection Logic

The sandbox selection process follows a three-tier preference system:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxablePreference {
    Auto,      // Automatic selection based on policy requirements
    Require,   // Force sandbox usage regardless of policy
    Forbid,    // Disable sandboxing entirely
}
```

The selection algorithm considers multiple factors:

1. **User Preference**: Explicit user choice to require, forbid, or auto-select
2. **Policy Requirements**: Whether the execution policy demands sandboxing
3. **Platform Availability**: Native sandbox support on the current platform
4. **Network Requirements**: Managed network environments may force sandboxing

```rust
pub fn select_initial(
    &self,
    file_system_policy: &FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    pref: SandboxablePreference,
    windows_sandbox_level: WindowsSandboxLevel,
    has_managed_network_requirements: bool,
) -> SandboxType {
    match pref {
        SandboxablePreference::Forbid => SandboxType::None,
        SandboxablePreference::Require => {
            get_platform_sandbox(windows_sandbox_level != WindowsSandboxLevel::Disabled)
                .unwrap_or(SandboxType::None)
        }
        SandboxablePreference::Auto => {
            if should_require_platform_sandbox(
                file_system_policy,
                network_policy,
                has_managed_network_requirements,
            ) {
                get_platform_sandbox(windows_sandbox_level != WindowsSandboxLevel::Disabled)
                    .unwrap_or(SandboxType::None)
            } else {
                SandboxType::None
            }
        }
    }
}
```

### Command Transformation Pipeline

The sandbox system transforms user commands through a sophisticated pipeline that applies platform-specific wrappers while preserving the original execution semantics.

```rust
pub struct SandboxTransformRequest<'a> {
    pub command: SandboxCommand,
    pub policy: &'a SandboxPolicy,
    pub file_system_policy: &'a FileSystemSandboxPolicy,
    pub network_policy: NetworkSandboxPolicy,
    pub sandbox: SandboxType,
    pub enforce_managed_network: bool,
    pub network: Option<&'a NetworkProxy>,
    pub sandbox_policy_cwd: &'a Path,
    pub codex_linux_sandbox_exe: Option<&'a PathBuf>,
    pub use_legacy_landlock: bool,
    pub windows_sandbox_level: WindowsSandboxLevel,
    pub windows_sandbox_private_desktop: bool,
}
```

The transformation process involves several key steps:

1. **Policy Effective Calculation**: Merge base policies with additional permissions
2. **Platform-Specific Wrapping**: Apply the appropriate sandbox wrapper
3. **Argument Vector Construction**: Build the final command with sandbox parameters
4. **Environment Preparation**: Configure environment variables for sandboxed execution

## macOS Seatbelt Implementation

macOS uses Apple's Seatbelt framework, which provides a declarative policy language for defining security restrictions. The Codex implementation generates dynamic Seatbelt policies based on the execution context.

### Seatbelt Policy Generation

The Seatbelt implementation constructs policies from several components:

```rust
const MACOS_SEATBELT_BASE_POLICY: &str = include_str!("seatbelt_base_policy.sbpl");
const MACOS_SEATBELT_NETWORK_POLICY: &str = include_str!("seatbelt_network_policy.sbpl");
const MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS: &str =
    include_str!("restricted_read_only_platform_defaults.sbpl");
```

These base policies provide:

- **Base Policy**: Core system access restrictions and allowed operations
- **Network Policy**: Network access controls and proxy configurations
- **Platform Defaults**: Standard macOS system directory access patterns

### Dynamic Policy Construction

The system generates dynamic policies by combining static templates with runtime parameters:

```rust
pub fn create_seatbelt_command_args_for_policies(
    command: Vec<String>,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPolicy,
    sandbox_policy_cwd: &Path,
    enforce_managed_network: bool,
    network: Option<&NetworkProxy>,
) -> Vec<String>
```

The policy construction process involves:

1. **File System Access Rules**: Generate read/write permissions based on policy
2. **Network Access Rules**: Configure network restrictions and proxy allowances
3. **Parameter Substitution**: Replace policy parameters with actual paths
4. **Policy Assembly**: Combine all components into a complete Seatbelt policy

### File System Access Control

Seatbelt policies use path-based access control with support for exclusions:

```rust
fn build_seatbelt_access_policy(
    action: &str,
    param_prefix: &str,
    roots: Vec<SeatbeltAccessRoot>,
) -> (String, Vec<(String, PathBuf)>) {
    let mut policy_components = Vec::new();
    let mut params = Vec::new();

    for (index, access_root) in roots.into_iter().enumerate() {
        let root = normalize_path_for_sandbox(access_root.root.as_path())
            .unwrap_or(access_root.root);
        let root_param = format!("{param_prefix}_{index}");
        params.push((root_param.clone(), root.into_path_buf()));

        if access_root.excluded_subpaths.is_empty() {
            policy_components.push(format!("(subpath (param \"{root_param}\"))"));
            continue;
        }

        let mut require_parts = vec![format!("(subpath (param \"{root_param}\"))")];
        for (excluded_index, excluded_subpath) in
            access_root.excluded_subpaths.into_iter().enumerate()
        {
            let excluded_subpath = normalize_path_for_sandbox(excluded_subpath.as_path())
                .unwrap_or(excluded_subpath);
            let excluded_param = format!("{param_prefix}_{index}_EXCLUDED_{excluded_index}");
            params.push((excluded_param.clone(), excluded_subpath.into_path_buf()));

            require_parts.push(format!(
                "(require-not (literal (param \"{excluded_param}\")))"
            ));
            require_parts.push(format!(
                "(require-not (subpath (param \"{excluded_param}\")))"
            ));
        }
        policy_components.push(format!("(require-all {} )", require_parts.join(" ")));
    }

    if policy_components.is_empty() {
        (String::new(), Vec::new())
    } else {
        (
            format!("(allow {action}\n{}\n)", policy_components.join(" ")),
            params,
        )
    }
}
```

This approach allows for precise control over file system access, supporting both inclusive access grants and explicit exclusions for sensitive directories.

### Network Policy Management

The network policy system handles proxy configurations and network isolation:

```rust
fn dynamic_network_policy_for_network(
    network_policy: NetworkSandboxPolicy,
    enforce_managed_network: bool,
    proxy: &ProxyPolicyInputs,
) -> String {
    let should_use_restricted_network_policy =
        !proxy.ports.is_empty() || proxy.has_proxy_config || enforce_managed_network;

    if should_use_restricted_network_policy {
        let mut policy = String::new();
        if proxy.allow_local_binding {
            policy.push_str("; allow loopback local binding and loopback traffic\n");
            policy.push_str("(allow network-bind (local ip \"localhost:*\"))\n");
            policy.push_str("(allow network-inbound (local ip \"localhost:*\"))\n");
            policy.push_str("(allow network-outbound (remote ip \"localhost:*\"))\n");
        }
        for port in &proxy.ports {
            policy.push_str(&format!(
                "(allow network-outbound (remote ip \"localhost:{port}\"))\n"
            ));
        }
        let unix_socket_policy = unix_socket_policy(proxy);
        if !unix_socket_policy.is_empty() {
            policy.push_str("; allow unix domain sockets for local IPC\n");
            policy.push_str(&unix_socket_policy);
        }
        return format!("{policy}{MACOS_SEATBELT_NETWORK_POLICY}");
    }

    if proxy.has_proxy_config {
        return String::new(); // Fail closed for proxy configurations
    }

    if enforce_managed_network {
        return String::new(); // Fail closed for managed networks
    }

    if network_policy.is_enabled() {
        format!(
            "(allow network-outbound)\n(allow network-inbound)\n{MACOS_SEATBELT_NETWORK_POLICY}"
        )
    } else {
        String::new()
    }
}
```

The network policy follows a "fail-closed" approach, defaulting to restrictive policies when proxy or managed network configurations are detected but cannot be properly configured.

### Unix Domain Socket Support

For inter-process communication, the system provides controlled access to Unix domain sockets:

```rust
#[derive(Debug, Clone)]
enum UnixDomainSocketPolicy {
    AllowAll,
    Restricted { allowed: Vec<AbsolutePathBuf> },
}

fn unix_socket_policy(proxy: &ProxyPolicyInputs) -> String {
    let socket_params = unix_socket_path_params(proxy);
    let has_unix_socket_access = matches!(
        proxy.unix_domain_socket_policy,
        UnixDomainSocketPolicy::AllowAll
    ) || !socket_params.is_empty();

    if !has_unix_socket_access {
        return String::new();
    }

    let mut policy = String::new();
    policy.push_str("(allow system-socket (socket-domain AF_UNIX))\n");

    if matches!(proxy.unix_domain_socket_policy, UnixDomainSocketPolicy::AllowAll) {
        policy.push_str("(allow network-bind (local unix-socket))\n");
        policy.push_str("(allow network-outbound (remote unix-socket))\n");
        return policy;
    }

    for param in socket_params {
        let key = unix_socket_path_param_key(param.index);
        policy.push_str(&format!(
            "(allow network-bind (local unix-socket (subpath (param \"{key}\"))))\n"
        ));
        policy.push_str(&format!(
            "(allow network-outbound (remote unix-socket (subpath (param \"{key}\"))))\n"
        ));
    }
    policy
}
```

This allows controlled IPC while maintaining security boundaries.

## Linux Landlock Implementation

Linux uses the Landlock Linux Security Module (LSM) combined with seccomp-bpf filters to provide filesystem and system call restrictions. The implementation leverages the modern Landlock API for path-based access control.

### Landlock Architecture

The Linux sandbox implementation is built around several key components:

```
┌─────────────────────────────────────────────────────┐
│              Linux Sandbox Executive               │
├─────────────────────────────────────────────────────┤
│  ┌─────────────────┐ ┌─────────────────────────────┐ │
│  │    Landlock     │ │       Seccomp-BPF          │ │
│  │  Filesystem     │ │     System Calls           │ │
│  │   Restrictions  │ │     Filtering              │ │
│  └─────────────────┘ └─────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│               Bubblewrap Fallback                   │
├─────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐ │
│  │          Network Namespace Isolation           │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Landlock Integration

The Landlock implementation provides fine-grained filesystem access control:

```rust
use crate::landlock::CODEX_LINUX_SANDBOX_ARG0;
use crate::landlock::allow_network_for_proxy;
use crate::landlock::create_linux_sandbox_command_args_for_policies;
```

The system creates Landlock policies that specify allowed filesystem operations:

```rust
SandboxType::LinuxSeccomp => {
    let exe = codex_linux_sandbox_exe
        .ok_or(SandboxTransformError::MissingLinuxSandboxExecutable)?;
    let allow_proxy_network = allow_network_for_proxy(enforce_managed_network);
    let mut args = create_linux_sandbox_command_args_for_policies(
        os_argv_to_strings(argv),
        command.cwd.as_path(),
        &effective_policy,
        &effective_file_system_policy,
        effective_network_policy,
        sandbox_policy_cwd,
        use_legacy_landlock,
        allow_proxy_network,
    );
    let mut full_command = Vec::with_capacity(1 + args.len());
    full_command.push(os_string_to_command_component(exe.as_os_str().to_owned()));
    full_command.append(&mut args);
    (
        full_command,
        Some(linux_sandbox_arg0_override(exe.as_path())),
    )
}
```

### Network Isolation Strategy

Linux network isolation uses a combination of techniques:

1. **Network Namespaces**: Isolate network stack from host
2. **Proxy Configuration**: Allow controlled external access through proxies
3. **Loopback Restrictions**: Limit local service access
4. **Unix Socket Control**: Manage inter-process communication

The `allow_network_for_proxy` function determines when network access should be permitted based on proxy and managed network requirements.

### Executable Path Management

The Linux implementation handles executable path management carefully to prevent security bypasses:

```rust
fn linux_sandbox_arg0_override(exe: &Path) -> String {
    if exe.file_name().and_then(|name| name.to_str()) == Some(CODEX_LINUX_SANDBOX_ARG0) {
        os_string_to_command_component(exe.as_os_str().to_owned())
    } else {
        CODEX_LINUX_SANDBOX_ARG0.to_string()
    }
}
```

This ensures that the sandbox executable is properly identified and executed with the correct process name.

## Windows Restricted Token Implementation

Windows sandboxing uses restricted tokens and job objects to limit process capabilities. While the current implementation provides basic support, it represents a foundation for more comprehensive Windows security integration.

### Windows Sandbox Levels

The system supports different levels of Windows sandboxing:

```rust
use codex_protocol::config_types::WindowsSandboxLevel;

pub struct SandboxExecRequest {
    // ... other fields ...
    pub windows_sandbox_level: WindowsSandboxLevel,
    pub windows_sandbox_private_desktop: bool,
    // ... other fields ...
}
```

The sandbox levels provide graduated security restrictions:

- **Disabled**: No Windows-specific sandboxing
- **Basic**: Restricted token with limited privileges
- **Enhanced**: Additional job object restrictions
- **Strict**: Maximum security with private desktop

### Platform Detection

The system detects Windows platform availability and configures sandboxing accordingly:

```rust
pub fn get_platform_sandbox(windows_sandbox_enabled: bool) -> Option<SandboxType> {
    if cfg!(target_os = "macos") {
        Some(SandboxType::MacosSeatbelt)
    } else if cfg!(target_os = "linux") {
        Some(SandboxType::LinuxSeccomp)
    } else if cfg!(target_os = "windows") {
        if windows_sandbox_enabled {
            Some(SandboxType::WindowsRestrictedToken)
        } else {
            None
        }
    } else {
        None
    }
}
```

This allows the system to gracefully handle platforms without native sandbox support.

## Policy Transformation System

The policy transformation system bridges the gap between high-level security policies and platform-specific sandbox configurations. This abstraction layer enables consistent security enforcement across different platforms.

### Effective Policy Calculation

The system calculates effective policies by merging base policies with additional permissions:

```rust
use crate::policy_transforms::EffectiveSandboxPermissions;
use crate::policy_transforms::effective_file_system_sandbox_policy;
use crate::policy_transforms::effective_network_sandbox_policy;

let EffectiveSandboxPermissions {
    sandbox_policy: effective_policy,
} = EffectiveSandboxPermissions::new(policy, additional_permissions.as_ref());

let effective_file_system_policy = effective_file_system_sandbox_policy(
    file_system_policy,
    additional_permissions.as_ref(),
);

let effective_network_policy = effective_network_sandbox_policy(
    network_policy,
    additional_permissions.as_ref()
);
```

This approach allows for runtime policy customization while maintaining security boundaries.

### Platform Requirements Assessment

The system evaluates whether platform sandboxing is required based on multiple factors:

```rust
use crate::policy_transforms::should_require_platform_sandbox;

if should_require_platform_sandbox(
    file_system_policy,
    network_policy,
    has_managed_network_requirements,
) {
    // Enable platform sandbox
}
```

This assessment considers:

1. **File System Policy Scope**: Whether full disk access is requested
2. **Network Policy Restrictions**: Level of network isolation required
3. **Managed Network Requirements**: Enterprise policy enforcement needs
4. **Risk Assessment**: Overall security risk of the execution context

## Cross-Platform Compatibility

The sandbox system is designed to provide consistent security guarantees across platforms while leveraging platform-specific capabilities.

### Command Vector Handling

The system handles command vectors consistently across platforms:

```rust
fn os_argv_to_strings(argv: Vec<OsString>) -> Vec<String> {
    argv.into_iter()
        .map(os_string_to_command_component)
        .collect()
}

fn os_string_to_command_component(value: OsString) -> String {
    value
        .into_string()
        .unwrap_or_else(|value| value.to_string_lossy().into_owned())
}
```

This ensures that command arguments are properly converted regardless of the underlying platform's string handling.

### Error Handling Strategy

The sandbox system uses a comprehensive error handling strategy:

```rust
#[derive(Debug)]
pub enum SandboxTransformError {
    MissingLinuxSandboxExecutable,
    #[cfg(not(target_os = "macos"))]
    SeatbeltUnavailable,
}

impl std::fmt::Display for SandboxTransformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingLinuxSandboxExecutable => {
                write!(f, "missing codex-linux-sandbox executable path")
            }
            #[cfg(not(target_os = "macos"))]
            Self::SeatbeltUnavailable => write!(f, "seatbelt sandbox is only available on macOS"),
        }
    }
}
```

This provides clear error messages when sandbox requirements cannot be met.

## Security Considerations

The sandbox system implements several security principles to ensure robust isolation:

### Defense in Depth

The system employs multiple layers of security controls:

1. **Platform Native Security**: Leverages OS-provided security mechanisms
2. **Policy Enforcement**: Applies business logic security policies
3. **Network Isolation**: Controls external communication channels
4. **File System Restrictions**: Limits filesystem access scope
5. **Process Isolation**: Restricts process capabilities and resources

### Fail-Safe Defaults

When security controls cannot be properly configured, the system defaults to restrictive policies:

```rust
if proxy.has_proxy_config {
    // Proxy configuration is present but we could not infer any valid loopback endpoints.
    // Fail closed to avoid silently widening network access in proxy-enforced sessions.
    return String::new();
}

if enforce_managed_network {
    // Managed network requirements are active but no usable proxy endpoints
    // are available. Fail closed for network access.
    return String::new();
}
```

This prevents security bypasses when configuration errors occur.

### Path Normalization

The system carefully normalizes file paths to prevent directory traversal attacks:

```rust
fn normalize_path_for_sandbox(path: &Path) -> Option<AbsolutePathBuf> {
    // `AbsolutePathBuf::from_absolute_path()` normalizes relative paths against the current
    // working directory, so keep the explicit check to avoid silently accepting relative entries.
    if !path.is_absolute() {
        return None;
    }

    let absolute_path = AbsolutePathBuf::from_absolute_path(path).ok()?;
    let normalized_path = absolute_path
        .as_path()
        .canonicalize()
        .ok()
        .and_then(|canonical_path| AbsolutePathBuf::from_absolute_path(canonical_path).ok());
    normalized_path.or(Some(absolute_path))
}
```

This ensures that sandbox policies operate on canonical paths, preventing symlink-based attacks.

## Performance Optimization

The sandbox system is designed to minimize performance overhead while maintaining security:

### Lazy Policy Generation

Sandbox policies are generated on-demand to avoid unnecessary computation:

```rust
let should_use_restricted_network_policy =
    !proxy.ports.is_empty() || proxy.has_proxy_config || enforce_managed_network;

if should_use_restricted_network_policy {
    // Generate restricted policy
} else {
    // Use permissive default
}
```

### Efficient Path Handling

The system uses efficient path handling techniques:

1. **BTreeMap Deduplication**: Remove duplicate paths in policy generation
2. **Path Canonicalization**: Resolve symbolic links once during setup
3. **Parameter Substitution**: Use parameterized policies to reduce string operations

### Memory Management

The implementation minimizes memory allocations through careful use of:

- **String Interning**: Reuse common policy components
- **Vector Pre-allocation**: Size vectors appropriately for expected content
- **Move Semantics**: Transfer ownership to avoid unnecessary copying

## Testing and Validation

The sandbox system includes comprehensive testing infrastructure:

### Unit Tests

Individual components are tested in isolation:

```rust
#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
```

### Integration Tests

End-to-end sandbox functionality is validated across platforms through integration tests that verify:

1. **Policy Generation**: Correct sandbox policies are generated
2. **Command Transformation**: Commands are properly wrapped
3. **Security Enforcement**: Restrictions are actually enforced
4. **Error Handling**: Failure modes are handled gracefully

### Security Auditing

The sandbox system undergoes regular security reviews to ensure:

- **Policy Completeness**: All necessary restrictions are applied
- **Bypass Prevention**: No mechanism allows security circumvention
- **Configuration Validation**: Invalid configurations are rejected
- **Attack Surface Minimization**: Exposed interfaces are minimized

## Future Enhancements

Several areas present opportunities for future enhancement:

### Enhanced Windows Support

Expanding Windows sandbox capabilities through:

- **AppContainer Integration**: Leverage Windows 10+ AppContainer technology
- **Windows Defender Integration**: Coordinate with system security services
- **Registry Restrictions**: Control registry access patterns
- **COM Object Isolation**: Restrict COM interface access

### Advanced Network Controls

Improving network isolation through:

- **Application-Level Proxying**: Implement HTTP/HTTPS proxy support
- **DNS Filtering**: Control domain name resolution
- **Certificate Validation**: Enforce certificate policies
- **Traffic Analysis**: Monitor network communication patterns

### Dynamic Policy Adjustment

Adding runtime policy modification capabilities:

- **Permission Escalation Requests**: Allow controlled privilege requests
- **Adaptive Policies**: Adjust restrictions based on runtime behavior
- **Policy Templates**: Provide pre-configured policy sets
- **Policy Validation**: Verify policy correctness before application

### Performance Optimization

Further performance improvements through:

- **Policy Caching**: Cache generated policies for reuse
- **Parallel Policy Generation**: Generate multiple policy components concurrently
- **Lazy Evaluation**: Defer policy generation until actually needed
- **Profile-Guided Optimization**: Optimize common execution patterns

## Conclusion

The Codex CLI multi-platform sandbox system represents a sophisticated approach to security isolation that balances strong security guarantees with cross-platform compatibility and performance. Through its layered architecture, platform-specific implementations, and comprehensive policy system, it provides robust protection against malicious code execution while maintaining the flexibility needed for legitimate AI-assisted development workflows.

The system's design principles of defense in depth, fail-safe defaults, and careful resource management create a security foundation that can evolve with changing threat landscapes and platform capabilities. As AI-generated code becomes more prevalent in development workflows, such comprehensive sandboxing systems will become increasingly critical for maintaining security in automated development environments.

The modular architecture and clear abstraction boundaries make the system maintainable and extensible, allowing for future enhancements while preserving the core security guarantees that make safe AI-assisted development possible.