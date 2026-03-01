# 加密体系：metadata 由谁解密、密钥如何交换

## 1. 谁负责加密 / 解密 metadata

### 会话 metadata（Session）

| 角色 | 加密 | 解密 |
|------|------|------|
| **创建会话的一方（通常是 CLI）** | 用**会话 data key**加密 metadata（及 agentState），和可选的 **dataEncryptionKey** 一起发给服务器 | 创建请求的响应里服务器回传密文；创建方用自己持有的同一 data key **当场解密**，得到明文 metadata，用于本地会话对象 |
| **App（或其他需要读会话列表的客户端）** | 不加密会话 metadata（App 只发 GET，不写） | 拉取会话列表后，用**用户 content 私钥**解密每条会话的 `dataEncryptionKey`，得到该会话的 data key，再用该 key **解密 metadata**（及 agentState） |
| **服务器** | 不加密、不解密 | 只存储和转发：`metadata`（密文）、`dataEncryptionKey`（密文，dataKey 模式下才有） |

因此：**加密由创建会话的客户端做，解密由「需要读该会话」的客户端做**；服务器不参与加解密，只存密文和加密后的 key。

### 机器 metadata（Machine）

逻辑同会话：daemon/CLI 用机器密钥加密后发给服务器；需要读的一方（如 App）用自己持有的密钥解密。服务器只存密文。

---

## 2. 密钥层次与「交换」方式

### 2.1 两种模式

- **Legacy**  
  - 会话 data key = 账户的 **secret**（与 masterSecret 或同一 secret 一致）。  
  - 不单独传「加密的 data key」；谁有 secret 谁就能加解密 metadata。  
  - 「交换」= 无：同一 secret 在创建会话的 CLI 与 App 之间通过账户登录/同步已有，服务器不参与密钥传递。

- **DataKey**  
  - 每个会话有独立的 **会话 data key**（32 字节随机，由创建会话的 CLI 生成）。  
  - metadata（和 agentState）用该 **会话 data key** 对称加密。  
  - 该 data key 再被「包一层」后发给服务器，供其他客户端取用；服务器不持有明文 key。

### 2.2 DataKey 下的「密钥交换」（实为密钥封装，无在线协商）

- **创建会话时（CLI）**  
  1. CLI 生成随机 **encryptionKey**（会话 data key）。  
  2. 用该 key 加密 metadata（及 agentState），把密文发给服务器。  
  3. 用**用户 content 公钥**（`credential.encryption.publicKey`）对 encryptionKey 做 **libsodium box** 加密（ephemeral keypair + nonce），得到 **dataEncryptionKey**。  
  4. 把 `dataEncryptionKey`（版本字节 + 密文）一并发给服务器。  
  - 服务器只存：metadata 密文 + dataEncryptionKey 密文；**从不接触**明文 data key 或明文 metadata。

- **谁能解密 dataEncryptionKey**  
  - 只有拥有**用户 content 私钥**的一方才能解密 dataEncryptionKey，得到会话 data key，再解密 metadata。  
  - App：在登录/同步时用 **masterSecret** 派生 **content keypair**（`deriveKey(masterSecret, 'Happy EnCoder', ['content'])` → `crypto_box_seed_keypair`），私钥只存在于 App 端，用于 `decryptEncryptionKey`。  
  - CLI：在 dataKey 模式下只存 **publicKey**（及 machineKey），用于「加密给用户」；**不存** content 私钥，因此 CLI/daemon **不能**解密其他会话的 dataEncryptionKey，只能解密自己刚创建的那条（因为 encryptionKey 还在内存里）。

- **总结「交换」**  
  - 没有传统意义上的「密钥交换」或在线协商。  
  - 创建方生成会话 data key，用**用户公钥**封装后交给服务器；**能解密的是仅持有用户 content 私钥的一方**（当前设计下即 App）。  
  - 服务器只做存储和按权限返回密文，不参与解密或密钥派生。

### 2.3 密钥层次简图（DataKey）

```
masterSecret (仅 App / 账户端)
    └─ deriveKey(..., 'content') → contentDataKey
           └─ crypto_box_seed_keypair → contentKeyPair (publicKey + privateKey)
                  ├─ publicKey  → 存于 credential，CLI 用其加密「会话 data key」→ dataEncryptionKey
                  └─ privateKey → 仅 App，用于解密 dataEncryptionKey → 得到会话 data key

会话 data key (32 bytes random，由创建会话的 CLI 生成)
    ├─ 加密 metadata / agentState（创建时与后续更新）
    └─ 经 content 公钥封装后以 dataEncryptionKey 形式存服务器；仅 content 私钥持有者可解开
```

---

## 3. 谁有什么密钥（会话 metadata 相关）

| 主体 | Legacy | DataKey |
|------|--------|---------|
| **创建该会话的 CLI** | 账户 secret，可直接加解密 | 该会话的 data key（内存），可直接加解密；另有用户 publicKey，用于封装 data key 后上传 |
| **App** | 同一 secret（masterSecret/secret），可解密所有该账户的会话 | content 私钥（由 masterSecret 派生），可解密所有 dataEncryptionKey，得到各会话 data key，再解密 metadata |
| **其他 CLI / daemon** | 若共享同一 secret，则可解密 | 只有 publicKey，**不能**解密 dataEncryptionKey，因此不能从服务器拉会话列表并解密 metadata |
| **服务器** | 无密钥 | 无密钥，只存密文与加密后的 dataEncryptionKey |

---

## 4. 有哪些非加密信息可以利用？

以下字段在 API / 存储中**不以密文语义存在**，服务器和客户端均可直接使用，无需解密。

### 会话（Session）

| 字段 | 含义 | 典型用途 |
|------|------|----------|
| **id** | 会话唯一 id | 路由、RPC 方法前缀、列表展示、stop-session |
| **seq** | 消息序序号 | 同步消息、判重 |
| **createdAt** | 创建时间（ms） | 排序、筛选、展示 |
| **updatedAt** | 更新时间（ms） | 排序、缓存失效 |
| **active** | 是否在线 | 列表区分在线/归档、筛选 |
| **activeAt** / **lastActiveAt** | 最近活跃时间（ms） | 排序、超时判定、展示 |
| **metadataVersion** / **agentStateVersion** | 版本号（整数） | 乐观锁、更新冲突检测 |

- **tag**：在 DB 中存在且为明文，当前 GET /v1/sessions 未返回；若在 API 中返回，也可作为明文利用。
- **metadata / agentState / dataEncryptionKey**：为密文或加密封装，要得到 hostPid、host、machineId 等必须解密 metadata。

### 连接与路由（无解密）

- **Socket auth**：会话进程连接时在 auth 里带 `sessionId`；服务器可直接用「连接 ↔ session id」做路由（如转发 RPC），无需解密。
- **RPC method 名**：格式为 `sessionId:methodName`，sessionId 为明文。

### 能做什么、不能做什么

- **能做的**：按 session id 列表、在线状态、时间排序/筛选；把 RPC 转发到对应 session 的连接；超时与缓存策略。
- **不能做的**：仅靠非加密信息**无法**得到某会话的 **hostPid、host、machineId**（在加密的 metadata 里）。Daemon 若要从服务器还原「session id ↔ PID」映射，必须能解密会话的 metadata。

---

## 5. 小结

- **加密 metadata**：由**创建/更新该资源的一方**（会话 = 通常是 CLI，机器 = daemon/CLI）用对应的 data key 或 legacy secret 加密。  
- **解密 metadata**：由**需要读该资源的一方**负责——会话 = 创建该会话的 CLI（当场解密）或 App（拉列表后用 content 私钥解 dataEncryptionKey 再解 metadata）；服务器不解密。  
- **密钥「交换」**：无在线协商；DataKey 下是「创建方用用户公钥封装会话 data key → 服务器存密文 → 仅持 content 私钥的一方（App）可解开」。服务器只存、只传密文，不参与解密或密钥派生。
