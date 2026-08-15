# IDE Bridge — Remote Development

> Reflects `TASK.md` §25. Full design, not full implementation for MVP. Types are defined; complete support is deferred.

---

## 1. Architectural Principle

```text
The adapter, daemon, and agent should run in the same environment as the workspace when possible.
```

When this is not possible:

- Preserve the URIs from the source environment.
- Use an explicit URI/path mapper.
- Never guess a mapping.
- Announce the topology in the handshake.

---

## 2. Topology Types

### hostKind

```text
hostKind:
  local
  remote-workspace
  web
  gateway
```

| Value | Meaning |
|-------|---------|
| `local` | Daemon and workspace on the same machine |
| `remote-workspace` | Workspace is on a remote machine (SSH, WSL, dev-container) |
| `web` | IDE running in a browser (Codespaces, web IDE) |
| `gateway` | Daemon acts as a gateway between environments |

### environmentKind

```text
environmentKind:
  local
  ssh
  wsl
  dev-container
  codespace
  jetbrains-remote
  unknown
```

| Value | Meaning |
|-------|---------|
| `local` | Native local environment |
| `ssh` | VS Code SSH Remote or similar |
| `wsl` | Windows Subsystem for Linux |
| `dev-container` | VS Code Dev Containers |
| `codespace` | GitHub Codespaces |
| `jetbrains-remote` | JetBrains Remote Development |
| `unknown` | Environment not yet determined |

---

## 3. Supported Scenarios (MVP)

| Scenario | Status | Notes |
|----------|--------|-------|
| VS Code local | **Supported** | Primary target |
| IntelliJ Platform local | **Supported** | Primary target |
| Linux | **Supported** | Primary target |
| macOS | **Supported** | Primary target |

---

## 4. Designed Scenarios (Post-MVP)

Types and protocol fields are defined; full support is deferred.

### 4.1 VS Code SSH

- Workspace on remote machine via SSH.
- Adapter and daemon should run on the remote side (same environment as workspace).
- Agent (Serena) may run locally or remotely.
- If agent runs locally: it connects to the remote daemon via tunnel.
- URIs: `file://` on the remote side must be preserved; local agent must not convert to local paths.

### 4.2 VS Code WSL

- Workspace in WSL filesystem.
- Adapter and daemon run inside WSL.
- Agent on Windows host connects via WSL bridge or runs inside WSL.
- Path differences: Windows paths (`C:\...`) vs WSL paths (`/mnt/c/...`) require explicit mapper.

### 4.3 Dev Containers

- Workspace inside a container.
- Adapter and daemon run inside the container.
- Agent connects from host or runs inside container.
- URIs are container-local; host must not assume same filesystem.

### 4.4 Codespaces

- Workspace in the cloud.
- Adapter and daemon run in the Codespace.
- Agent connects via tunnel or runs in the Codespace.
- `hostKind: web`, `environmentKind: codespace`.

### 4.5 JetBrains Remote Development

- JetBrains IDE running on a remote server, thin client locally.
- Adapter and daemon run on the remote server.
- Agent connects from local or remote.
- `environmentKind: jetbrains-remote`.

---

## 5. Daemon Placement

### Local daemon

- Runs on the same machine as the workspace.
- Discovery file is local.
- No tunnel needed.

### Remote daemon

- Runs on the remote machine (SSH server, container, Codespace).
- Discovery file is on the remote machine.
- Local agent needs a tunnel to reach the remote daemon.
- Tunnel must authenticate; no unauthenticated remote access.
- Reconnection must reread discovery metadata in the daemon's environment; it must not reuse a
  pre-restart endpoint/token or infer a local path for a remote discovery file.

---

## 6. Agent Placement

### Local agent

- Runs on the developer's machine.
- Connects to daemon (local or via tunnel).
- Must preserve remote URIs; no path guessing.

### Remote agent

- Runs in the same environment as the workspace.
- Direct connection to daemon.
- Simplest topology; preferred when possible.

---

## 7. URI and Path Handling

- **Never** convert a URI to a local path without an explicit mapper.
- **Never** assume two processes see the same OS path.
- Remote URIs (e.g., `ssh://`, `vscode-remote://`) must be preserved.
- An explicit mapper translates between environments when needed.
- The mapper must be announced in the handshake topology.

---

## 8. Tunnels

- Used when agent and daemon are in different environments.
- Must authenticate (token-based, same as local).
- Must not expose the daemon publicly.
- Transport abstraction supports future tunnel implementations.

---

## 9. Handshake Topology Announcement

In the `bridge/handshake` request and response, the client and daemon announce their respective
topology:

```json
{
  "topology": {
    "hostKind": "remote-workspace",
    "environmentKind": "ssh",
    "uriSchemes": ["file"]
  }
}
```

This allows the daemon and adapters to route correctly and avoid path assumptions.
URI scheme values omit `://`. When environments need mapping, the announcing endpoint supplies
explicit `uriMappings` entries containing source/target URI prefixes and direction. An absent
mapping means that no conversion is authorised.

---

## 10. Security Considerations

- Remote daemon must not be publicly accessible. Use tunnels or SSH port forwarding.
- Token must not be transmitted over unencrypted public channels.
- Discovery file on a remote machine must still have restrictive permissions.
- Local agent connecting to remote daemon must store the token securely (not in plaintext config).
- See `docs/SECURITY.md` for the full threat model.
