import { PLAN_KIND, PLAN_SCHEMA_VERSION, assertPlanModel } from "../plan-model.js";

const fixture = {
  schemaVersion: PLAN_SCHEMA_VERSION,
  kind: PLAN_KIND,
  id: "doris-tde-demo",
  title: "Apache Doris：透明数据加密（TDE）设计评审",
  status: "in_review",
  createdAt: "2026-07-17T00:00:00.000Z",
  project: {
    name: "Apache Doris",
    repository: "https://github.com/apache/doris",
    baseRef: "main (illustrative fixture)"
  },
  goal: "在不改变查询和写入接口的前提下，对落盘数据进行透明加密，并把密钥生命周期与存储生命周期解耦。",
  summary: "新增统一密钥与加密抽象，元数据只保存加密后的数据密钥；写入、读取、Compaction 和备份路径复用同一套透明加解密能力。",
  modules: [
    {
      id: "key-management",
      name: "密钥与加密模块",
      order: 1,
      status: "added",
      layer: "Security",
      summary: "新增 AES-256-GCM 数据加密、信封加密和 KMS 接口；业务模块只拿短生命周期的 DataKey，不直接接触主密钥。",
      entryPoints: [
        {
          signature: "KeyManager::create_data_key(tablet_id)",
          file: "be/src/security/key_manager.h"
        },
        {
          signature: "AesGcmCryptoProvider::create_stream(key, nonce)",
          file: "be/src/security/aes_gcm_crypto_provider.h"
        }
      ],
      diagram: {
        nodes: [
          {
            id: "key-manager",
            label: "KeyManager",
            type: "class",
            status: "added",
            description: "缓存和轮换 DataKey"
          },
          {
            id: "kms-client",
            label: "KmsClient",
            type: "interface",
            status: "added",
            description: "包装/解包数据密钥"
          },
          {
            id: "crypto-provider",
            label: "CryptoProvider",
            type: "interface",
            status: "added",
            description: "算法无关的流式加解密接口"
          },
          {
            id: "aes-gcm",
            label: "AES-256-GCM",
            type: "class",
            status: "added",
            description: "首个认证加密实现"
          }
        ],
        edges: [
          { from: "key-manager", to: "kms-client", label: "wrap / unwrap", status: "added" },
          { from: "key-manager", to: "crypto-provider", label: "returns DataKey", status: "added" },
          { from: "aes-gcm", to: "crypto-provider", label: "implements", status: "added" }
        ]
      },
      changes: [
        {
          id: "introduce-envelope-encryption",
          title: "引入信封加密和 AES-256-GCM",
          status: "added",
          location: {
            file: "be/src/security/key_manager.cpp",
            symbol: "KeyManager::create_data_key"
          },
          rationale: "主密钥只留在 KMS；每个数据对象使用独立 DataKey，并通过认证标签发现密文篡改。",
          callPath: [
            { label: "KeyManager::create_data_key()", status: "added" },
            { label: "KmsClient::wrap_key()", status: "added" },
            { label: "AesGcmCryptoProvider::create_stream()", status: "added" }
          ],
          pseudocode: {
            language: "cpp",
            before: "// 没有统一的加密密钥和算法抽象",
            after: "auto key = kms.generate_data_key();\nauto wrapped = kms.wrap_key(key);\nauto stream = crypto.create_encrypt_stream(key, AES_256_GCM);\nreturn {stream, wrapped, key.version()};"
          },
          dependencies: [
            {
              kind: "include",
              from: "be/src/security/key_manager.cpp",
              to: "be/src/security/aes_gcm_crypto_provider.h",
              status: "added"
            }
          ]
        }
      ],
      approval: { decision: "pending", comment: "", updatedAt: null }
    },
    {
      id: "fe-metadata",
      name: "FE 元数据与策略",
      order: 2,
      status: "modified",
      layer: "Metadata",
      summary: "表级属性决定是否启用 TDE；元数据只记录算法、密钥版本和 Wrapped DataKey，不保存明文密钥。",
      entryPoints: [
        {
          signature: "CreateTableStmt::analyze()",
          file: "fe/fe-core/src/main/java/org/apache/doris/analysis/CreateTableStmt.java"
        }
      ],
      diagram: {
        nodes: [
          { id: "create-table", label: "CreateTableStmt", type: "class", status: "modified" },
          { id: "tde-policy", label: "TdePolicy", type: "data", status: "added" },
          { id: "tablet-meta", label: "TabletMeta", type: "data", status: "modified" }
        ],
        edges: [
          { from: "create-table", to: "tde-policy", label: "validates", status: "added" },
          { from: "tde-policy", to: "tablet-meta", label: "persists policy id", status: "added" }
        ]
      },
      changes: [
        {
          id: "persist-tde-policy",
          title: "解析并持久化 TDE 策略",
          status: "modified",
          location: {
            file: "fe/fe-core/src/main/java/org/apache/doris/catalog/OlapTable.java",
            symbol: "OlapTable::write"
          },
          rationale: "将是否加密和使用哪个策略变成可审计的元数据，而不是散落在写入路径中的开关。",
          callPath: [
            { label: "CreateTableStmt::analyze()", status: "modified" },
            { label: "折叠 2 个元数据转换函数", status: "unchanged", collapsedCount: 2 },
            { label: "TabletMeta::set_tde_policy()", status: "added" }
          ],
          pseudocode: {
            language: "java",
            before: "tabletMeta.setStoragePolicy(storagePolicy);",
            after: "tabletMeta.setStoragePolicy(storagePolicy);\nif (properties.tdeEnabled()) {\n  tabletMeta.setTdePolicy(validateTdePolicy(properties));\n}"
          }
        }
      ],
      approval: { decision: "pending", comment: "", updatedAt: null }
    },
    {
      id: "write-path",
      name: "存储写入路径",
      order: 3,
      status: "modified",
      layer: "Storage",
      summary: "在 RowsetWriter 创建文件系统流时注入加密包装层，DeltaWriter 不获取密钥，SegmentWriter 的编码逻辑保持不变。",
      entryPoints: [
        {
          signature: "DeltaWriterV2::init()",
          file: "be/src/vec/sink/writer/vtablet_writer_v2.cpp"
        },
        {
          signature: "RowsetWriterContext::fs()",
          file: "be/src/olap/rowset/rowset_writer_context.h"
        }
      ],
      diagram: {
        nodes: [
          { id: "delta-writer", label: "DeltaWriterV2", type: "class", status: "unchanged" },
          { id: "rowset-context", label: "RowsetWriterContext", type: "data", status: "modified" },
          { id: "encrypted-fs", label: "EncryptedFileSystem", type: "class", status: "added" },
          { id: "segment-writer", label: "SegmentWriter", type: "class", status: "unchanged" }
        ],
        edges: [
          { from: "delta-writer", to: "rowset-context", label: "build context", status: "modified" },
          { from: "rowset-context", to: "encrypted-fs", label: "decorates fs", status: "added" },
          { from: "rowset-context", to: "segment-writer", label: "same writer API", status: "unchanged" }
        ]
      },
      changes: [
        {
          id: "wrap-rowset-output",
          title: "在 RowsetWriterContext 注入透明加密文件系统",
          status: "modified",
          location: {
            file: "be/src/olap/rowset/beta_rowset_writer.cpp",
            symbol: "BetaRowsetWriter::init"
          },
          rationale: "把加密边界放在文件 I/O 层，可避免列编码和上层写入协议感知密钥。",
          callPath: [
            { label: "DeltaWriterV2::init()", status: "unchanged" },
            { label: "折叠 3 个 writer 初始化函数", status: "unchanged", collapsedCount: 3 },
            { label: "RowsetWriterContext::fs()", status: "modified" },
            { label: "EncryptedFileSystem::create_file()", status: "added" }
          ],
          pseudocode: {
            language: "cpp",
            before: "context.fs = storage_engine.get_file_system();\nRETURN_IF_ERROR(segment_writer.init(context.fs));",
            after: "auto fs = storage_engine.get_file_system();\nif (tablet_meta.tde_enabled()) {\n  fs = encrypted_fs.wrap(fs, key_manager, tablet_meta.key_info());\n}\ncontext.fs = fs;\nRETURN_IF_ERROR(segment_writer.init(context.fs));"
          },
          dependencies: [
            {
              kind: "include",
              from: "be/src/olap/rowset/beta_rowset_writer.cpp",
              to: "be/src/io/fs/encrypted_file_system.h",
              status: "added"
            }
          ]
        }
      ],
      approval: { decision: "pending", comment: "", updatedAt: null }
    },
    {
      id: "read-path",
      name: "存储读取路径",
      order: 4,
      status: "modified",
      layer: "Storage",
      summary: "Segment 打开文件时根据文件头中的密钥版本创建解密流；查询执行器和向量化 Scanner 无需修改。",
      entryPoints: [
        {
          signature: "Segment::open()",
          file: "be/src/olap/rowset/segment_v2/segment.cpp"
        }
      ],
      diagram: {
        nodes: [
          { id: "scanner", label: "VOlapScanNode", type: "class", status: "unchanged" },
          { id: "segment-open", label: "Segment::open", type: "function", status: "modified" },
          { id: "encrypted-reader", label: "EncryptedFileReader", type: "class", status: "added" },
          { id: "key-cache", label: "KeyManager cache", type: "service", status: "added" }
        ],
        edges: [
          { from: "scanner", to: "segment-open", label: "read segment", status: "unchanged" },
          { from: "segment-open", to: "encrypted-reader", label: "detect encrypted header", status: "added" },
          { from: "encrypted-reader", to: "key-cache", label: "unwrap by version", status: "added" }
        ]
      },
      changes: [
        {
          id: "decrypt-segment-input",
          title: "Segment 打开时按需包装解密流",
          status: "modified",
          location: {
            file: "be/src/olap/rowset/segment_v2/segment.cpp",
            symbol: "Segment::open"
          },
          rationale: "只有底层 FileReader 感知加密格式，缓存层以上继续读取明文页。",
          callPath: [
            { label: "VOlapScanNode::open()", status: "unchanged" },
            { label: "折叠 4 个 scanner/rowset 函数", status: "unchanged", collapsedCount: 4 },
            { label: "Segment::open()", status: "modified" },
            { label: "EncryptedFileReader::open()", status: "added" }
          ],
          pseudocode: {
            language: "cpp",
            before: "auto reader = fs->open_file(path);\nreturn Segment::load(reader);",
            after: "auto reader = fs->open_file(path);\nauto header = EncryptionHeader::try_read(reader);\nif (header) {\n  reader = encrypted_reader.wrap(reader, key_manager.unwrap(header.key));\n}\nreturn Segment::load(reader);"
          }
        }
      ],
      approval: { decision: "pending", comment: "", updatedAt: null }
    },
    {
      id: "maintenance-paths",
      name: "Compaction、快照与备份",
      order: 5,
      status: "modified",
      layer: "Operations",
      summary: "Compaction 通过正常读写流自动完成解密和重加密；快照复制密文及密钥元数据，导出明文必须显式授权。",
      entryPoints: [
        {
          signature: "BaseCompaction::execute_compact()",
          file: "be/src/olap/base_compaction.cpp"
        },
        {
          signature: "SnapshotManager::make_snapshot()",
          file: "be/src/olap/snapshot_manager.cpp"
        }
      ],
      diagram: {
        nodes: [
          { id: "compaction", label: "Compaction", type: "service", status: "modified" },
          { id: "normal-read", label: "Encrypted read path", type: "service", status: "added" },
          { id: "normal-write", label: "Encrypted write path", type: "service", status: "added" },
          { id: "snapshot", label: "SnapshotManager", type: "class", status: "modified" }
        ],
        edges: [
          { from: "compaction", to: "normal-read", label: "decrypt", status: "added" },
          { from: "compaction", to: "normal-write", label: "encrypt with current key", status: "added" },
          { from: "snapshot", to: "normal-write", label: "copy ciphertext + metadata", status: "modified" }
        ]
      },
      changes: [
        {
          id: "preserve-encryption-across-maintenance",
          title: "维护路径复用透明 I/O 并保留密钥元数据",
          status: "modified",
          location: {
            file: "be/src/olap/snapshot_manager.cpp",
            symbol: "SnapshotManager::make_snapshot"
          },
          rationale: "避免 Compaction、Clone 或 Snapshot 绕过正常 I/O 后意外产生明文文件。",
          callPath: [
            { label: "BaseCompaction::execute_compact()", status: "modified" },
            { label: "折叠 5 个 rowset merge 函数", status: "unchanged", collapsedCount: 5 },
            { label: "EncryptedFileReader / EncryptedFileSystem", status: "added" }
          ],
          pseudocode: {
            language: "cpp",
            before: "copy_file(source_path, snapshot_path);",
            after: "copy_ciphertext(source_path, snapshot_path);\ncopy_encryption_metadata(source_rowset, snapshot_manifest);\nCHECK(snapshot_manifest.has_wrapped_key());"
          }
        }
      ],
      approval: { decision: "pending", comment: "", updatedAt: null }
    }
  ],
  relationships: [
    {
      from: "fe-metadata",
      to: "key-management",
      label: "引用策略，不传明文密钥",
      status: "added",
      summary: "FE 持久化策略标识；BE 的 KeyManager 负责解析密钥材料。"
    },
    {
      from: "write-path",
      to: "key-management",
      label: "获取写入 DataKey",
      status: "added",
      summary: "只有加密文件系统包装层调用 KeyManager。"
    },
    {
      from: "read-path",
      to: "key-management",
      label: "按版本解包 DataKey",
      status: "added",
      summary: "读取文件头后按需解包并短暂缓存密钥。"
    },
    {
      from: "maintenance-paths",
      to: "write-path",
      label: "复用加密写入",
      status: "modified",
      summary: "Compaction 不实现第二套加密逻辑。"
    },
    {
      from: "maintenance-paths",
      to: "read-path",
      label: "复用透明读取",
      status: "modified",
      summary: "Compaction 不直接解密文件格式。"
    }
  ],
  risks: [
    {
      id: "nonce-reuse",
      level: "critical",
      title: "AES-GCM nonce 重复会破坏机密性",
      mitigation: "以文件唯一 ID 和块序号派生 nonce，并增加重复检测和故障注入测试。",
      moduleIds: ["key-management", "write-path"]
    },
    {
      id: "key-unavailable",
      level: "high",
      title: "KMS 暂时不可用可能阻塞读写",
      mitigation: "使用有界 TTL 缓存、熔断和清晰的可重试错误；绝不回退为明文写入。",
      moduleIds: ["key-management", "read-path", "write-path"]
    },
    {
      id: "maintenance-bypass",
      level: "high",
      title: "边缘维护路径可能绕开加密层",
      mitigation: "为 Compaction、Clone、Snapshot、Restore 和冷存储迁移增加端到端密文检查。",
      moduleIds: ["maintenance-paths"]
    }
  ],
  verification: [
    {
      id: "be-unit-tests",
      type: "unit",
      command: "ninja -C be/build test && ctest --test-dir be/build -R 'crypto|encrypted_file'",
      expected: "算法向量、篡改检测、密钥缓存和错误路径全部通过。",
      moduleIds: ["key-management", "write-path", "read-path"]
    },
    {
      id: "tde-regression",
      type: "integration",
      command: "run-regression-test --suite tde",
      expected: "建表、导入、查询、Compaction、快照、恢复和密钥轮换均通过。",
      moduleIds: ["fe-metadata", "write-path", "read-path", "maintenance-paths"]
    },
    {
      id: "plaintext-scan",
      type: "security",
      command: "intentcanvas-check-no-plaintext --data-dir output/tde-cluster/storage",
      expected: "磁盘文件中找不到测试明文，篡改认证标签会稳定失败。",
      moduleIds: ["write-path", "maintenance-paths"]
    },
    {
      id: "performance-guardrail",
      type: "performance",
      command: "run-tpcds --compare baseline,tde --scale 100",
      expected: "吞吐和 P99 延迟退化处于批准的预算内。",
      moduleIds: ["write-path", "read-path"]
    }
  ]
};

assertPlanModel(fixture);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const tdePlanFixture = deepFreeze(fixture);

export function createTdePlanFixture() {
  return structuredClone(tdePlanFixture);
}
