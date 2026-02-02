import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

const STORAGE_KEY_CONFIG = "discord_tracker_config";
const STORAGE_KEY_LOGS = "discord_tracker_logs";

interface Config {
  token: string;
  serverId: string;
  roleIds: string[];
  targetChannelId: string;
  testMessage: string;
  timeout: number;
  webhookUrl: string;
  sendChannelId: string;
  proxyEnabled: boolean;
  proxyHost: string;
  proxyPort: number;
}

interface LeakerInfo {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  roles: string[];
  confirmed?: boolean;
}

interface TreeNode {
  step: number;
  names: string[];
  direction?: "left" | "right";
}

interface SearchState {
  phase: "idle" | "running" | "found" | "not_found";
  currentStep: number;
  totalSteps: number;
  remainingUsers: number;
  logs: string[];
  leaker: LeakerInfo | null;
  treeHistory: TreeNode[];
}

interface ConnectionState {
  status: "disconnected" | "connecting" | "connected";
  username: string;
}

function App() {
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const [config, setConfig] = useState<Config>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_CONFIG);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return {
          token: "",
          serverId: "",
          roleIds: [],
          targetChannelId: "",
          testMessage: "TEST_MESSAGE_" + Date.now(),
          timeout: 10,
          webhookUrl: "",
          sendChannelId: "",
          proxyEnabled: false,
          proxyHost: "127.0.0.1",
          proxyPort: 7897,
        };
      }
    }
    return {
      token: "",
      serverId: "",
      roleIds: [],
      targetChannelId: "",
      testMessage: "TEST_MESSAGE_" + Date.now(),
      timeout: 10,
      webhookUrl: "",
      sendChannelId: "",
    };
  });

  const [roleInput, setRoleInput] = useState("");
  const [connection, setConnection] = useState<ConnectionState>({
    status: "disconnected",
    username: "",
  });
  const [searchState, setSearchState] = useState<SearchState>(() => {
    const savedLogs = localStorage.getItem(STORAGE_KEY_LOGS);
    return {
      phase: "idle" as const,
      currentStep: 0,
      totalSteps: 0,
      remainingUsers: 0,
      logs: savedLogs ? JSON.parse(savedLogs) : [],
      leaker: null,
      treeHistory: [],
    };
  });

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setSearchState((prev) => ({
      ...prev,
      logs: [...prev.logs, `[${timestamp}] ${message}`],
    }));
  }, []);

  // 组件卸载时清理监听器
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  // 保存配置到localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
  }, [config]);

  // 保存日志到localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_LOGS, JSON.stringify(searchState.logs));
  }, [searchState.logs]);

  const connectAccount = async () => {
    if (!config.token) {
      addLog("错误: 请输入Token");
      return;
    }
    setConnection({ status: "connecting", username: "" });
    addLog("正在连接Discord...");

    try {
      const result = await invoke<string>("test_connection", {
        token: config.token,
        proxyEnabled: config.proxyEnabled,
        proxyHost: config.proxyHost,
        proxyPort: config.proxyPort,
      });
      setConnection({ status: "connected", username: result });
      addLog(`已连接: ${result}`);
    } catch (error) {
      setConnection({ status: "disconnected", username: "" });
      addLog(`连接失败: ${error}`);
    }
  };

  const disconnectAccount = () => {
    setConnection({ status: "disconnected", username: "" });
    addLog("已断开连接");
  };

  const addRole = () => {
    if (roleInput.trim() && !config.roleIds.includes(roleInput.trim())) {
      setConfig((prev) => ({
        ...prev,
        roleIds: [...prev.roleIds, roleInput.trim()],
      }));
      setRoleInput("");
    }
  };

  const removeRole = (roleId: string) => {
    setConfig((prev) => ({
      ...prev,
      roleIds: prev.roleIds.filter((id) => id !== roleId),
    }));
  };

  const startSearch = async () => {
    if (connection.status !== "connected") {
      addLog("错误: 请先连接账号");
      return;
    }
    if (!config.serverId || config.roleIds.length === 0 || !config.targetChannelId) {
      addLog("错误: 请填写所有必填字段");
      return;
    }

    setSearchState({
      phase: "running",
      currentStep: 0,
      totalSteps: 0,
      remainingUsers: 0,
      logs: [],
      leaker: null,
      treeHistory: [],
    });

    addLog("开始二分搜索...");

    try {
      // 清理之前的监听器
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      // 设置新的监听器
      unlistenRef.current = await listen("search-progress", (event: any) => {
        const data = event.payload;
        setSearchState((prev) => {
          // 更新树状历史
          let newTreeHistory = [...prev.treeHistory];
          if (data.names && data.names.length > 0 && data.step > 0) {
            const existingIndex = newTreeHistory.findIndex(n => n.step === data.step);
            if (existingIndex === -1) {
              newTreeHistory.push({
                step: data.step,
                names: data.names,
                direction: data.message.includes("后半部分") ? "right" :
                          data.message.includes("前半部分") ? "left" : undefined
              });
            }
          }
          return {
            ...prev,
            currentStep: data.step,
            totalSteps: data.total,
            remainingUsers: data.remaining,
            treeHistory: newTreeHistory,
          };
        });
        addLog(data.message);
      });

      const result = await invoke<LeakerInfo | null>("start_binary_search", {
        config: config,
      });

      if (result) {
        setSearchState((prev) => ({
          ...prev,
          phase: "found",
          leaker: result,
        }));
        addLog(`找到泄露者: ${result.username} (${result.id})`);
      } else {
        setSearchState((prev) => ({ ...prev, phase: "not_found" }));
        addLog("未找到泄露者");
      }
    } catch (error) {
      addLog(`错误: ${error}`);
      setSearchState((prev) => ({ ...prev, phase: "idle" }));
    }
  };

  const stopSearch = async () => {
    try {
      await invoke("stop_search");
      addLog("搜索已停止");
      setSearchState((prev) => ({ ...prev, phase: "idle" }));
    } catch (error) {
      addLog(`停止失败: ${error}`);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <h1>Discord盗转查询</h1>
        </div>
        <p className="subtitle">二分法精准定位信息泄露者</p>
      </header>

      <main className="main">
        <div className="panel config-panel">
          <h2 className="panel-title">
            <span className="icon">⚙</span>
            配置设置
          </h2>

          <div className="form-group">
            <label>Discord Token</label>
            <div className="token-input-group">
              <input
                type="password"
                placeholder="输入你的Discord账号Token"
                value={config.token}
                onChange={(e) => setConfig((prev) => ({ ...prev, token: e.target.value }))}
                disabled={connection.status === "connected"}
              />
              {connection.status === "disconnected" ? (
                <button className="btn-connect" onClick={connectAccount}>连接</button>
              ) : connection.status === "connecting" ? (
                <button className="btn-connect" disabled>连接中...</button>
              ) : (
                <button className="btn-disconnect" onClick={disconnectAccount}>断开</button>
              )}
            </div>
            {connection.status === "connected" && (
              <div className="connection-status">已连接: {connection.username}</div>
            )}
          </div>

          <div className="form-group">
            <label>服务器 ID</label>
            <input
              type="text"
              placeholder="输入你的服务器ID"
              value={config.serverId}
              onChange={(e) => setConfig((prev) => ({ ...prev, serverId: e.target.value }))}
            />
          </div>

          <div className="form-group">
            <label>会员身份组 ID</label>
            <div className="role-input-group">
              <input
                type="text"
                placeholder="输入身份组ID (月度/年度/永久会员)"
                value={roleInput}
                onChange={(e) => setRoleInput(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && addRole()}
              />
              <button className="btn-add" onClick={addRole}>添加</button>
            </div>
            <div className="role-tags">
              {config.roleIds.map((roleId) => (
                <span key={roleId} className="role-tag">
                  {roleId}
                  <button onClick={() => removeRole(roleId)}>×</button>
                </span>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>监听频道 ID</label>
            <input
              type="text"
              placeholder="输入盗转群的频道ID"
              value={config.targetChannelId}
              onChange={(e) => setConfig((prev) => ({ ...prev, targetChannelId: e.target.value }))}
            />
          </div>

          <div className="form-group">
            <label>发送消息频道 ID</label>
            <input
              type="text"
              placeholder="输入你服务器中发送测试消息的频道ID"
              value={config.sendChannelId}
              onChange={(e) => setConfig((prev) => ({ ...prev, sendChannelId: e.target.value }))}
            />
          </div>

          <div className="form-group">
            <label>Webhook URL (可选)</label>
            <input
              type="text"
              placeholder="留空则使用账号发送消息"
              value={config.webhookUrl}
              onChange={(e) => setConfig((prev) => ({ ...prev, webhookUrl: e.target.value }))}
            />
          </div>

          <div className="form-group">
            <label>测试消息内容</label>
            <input
              type="text"
              placeholder="输入测试消息"
              value={config.testMessage}
              onChange={(e) => setConfig((prev) => ({ ...prev, testMessage: e.target.value }))}
            />
          </div>

          <div className="form-group">
            <label>检测超时时间 (秒)</label>
            <input
              type="number"
              placeholder="输入等待时间"
              value={config.timeout}
              min={1}
              max={120}
              onChange={(e) => setConfig((prev) => ({ ...prev, timeout: parseInt(e.target.value) || 10 }))}
            />
          </div>

          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={config.proxyEnabled}
                onChange={(e) => setConfig((prev) => ({ ...prev, proxyEnabled: e.target.checked }))}
              />
              {" "}启用代理
            </label>
            {config.proxyEnabled && (
              <div className="proxy-inputs">
                <input
                  type="text"
                  placeholder="代理地址"
                  value={config.proxyHost}
                  onChange={(e) => setConfig((prev) => ({ ...prev, proxyHost: e.target.value }))}
                />
                <input
                  type="number"
                  placeholder="端口"
                  value={config.proxyPort}
                  onChange={(e) => setConfig((prev) => ({ ...prev, proxyPort: parseInt(e.target.value) || 7897 }))}
                />
              </div>
            )}
          </div>

          <div className="button-group">
            {searchState.phase === "idle" || searchState.phase === "found" || searchState.phase === "not_found" ? (
              <button className="btn-primary" onClick={startSearch}>
                <span className="btn-icon">▶</span>
                开始追踪
              </button>
            ) : (
              <button className="btn-danger" onClick={stopSearch}>
                <span className="btn-icon">■</span>
                停止追踪
              </button>
            )}
          </div>
        </div>

        <div className="panel status-panel">
          <h2 className="panel-title">
            <span className="icon">📊</span>
            追踪状态
          </h2>

          <div className="status-grid">
            <div className="status-card">
              <div className="status-label">当前阶段</div>
              <div className={`status-value phase-${searchState.phase}`}>
                {searchState.phase === "idle" && "等待开始"}
                {searchState.phase === "running" && "搜索中..."}
                {searchState.phase === "found" && "已找到"}
                {searchState.phase === "not_found" && "未找到"}
              </div>
            </div>
            <div className="status-card">
              <div className="status-label">搜索进度</div>
              <div className="status-value">
                {searchState.currentStep} / {searchState.totalSteps || "?"}
              </div>
            </div>
            <div className="status-card">
              <div className="status-label">剩余用户</div>
              <div className="status-value">{searchState.remainingUsers}</div>
            </div>
          </div>

          {searchState.phase === "running" && (
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: searchState.totalSteps
                    ? `${(searchState.currentStep / searchState.totalSteps) * 100}%`
                    : "0%",
                }}
              />
            </div>
          )}

          <div className="binary-visual">
            <h3>二分搜索可视化</h3>
            <div className="binary-tree">
              {searchState.treeHistory.map((node, index) => (
                <div key={index} className="tree-level">
                  <div className="tree-level-label">第 {node.step} 轮</div>
                  <div className="tree-level-nodes">
                    {node.names.map((name, i) => (
                      <div
                        key={i}
                        className={`tree-node ${index === searchState.treeHistory.length - 1 ? 'active' : ''}`}
                      >
                        {name}
                      </div>
                    ))}
                  </div>
                  {index < searchState.treeHistory.length - 1 && (
                    <div className="tree-arrow">↓</div>
                  )}
                </div>
              ))}
              {searchState.leaker && (
                <div className="tree-level final">
                  <div className="tree-level-label">最终结果</div>
                  <div className="tree-level-nodes">
                    <div className={`tree-node final ${searchState.leaker.confirmed ? 'confirmed' : 'unconfirmed'}`}>
                      {searchState.leaker.displayName}
                      <span className="confirm-badge">
                        {searchState.leaker.confirmed ? '✓ 已确认' : '? 未确认'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {searchState.treeHistory.length === 0 && !searchState.leaker && (
                <div className="tree-empty">等待搜索开始...</div>
              )}
            </div>
          </div>

          {/* 追踪结果整合到状态面板 */}
          {searchState.leaker && (
            <div className={`leaker-card ${searchState.leaker.confirmed ? 'confirmed' : 'unconfirmed'}`}>
              <div className="leaker-avatar">
                {searchState.leaker.avatar ? (
                  <img src={searchState.leaker.avatar} alt="avatar" />
                ) : (
                  <div className="avatar-placeholder">?</div>
                )}
              </div>
              <div className="leaker-info">
                <div className="leaker-status">
                  {searchState.leaker.confirmed
                    ? <span className="status-confirmed">已确认是泄露者</span>
                    : <span className="status-unconfirmed">可能被冤枉</span>
                  }
                </div>
                <div className="leaker-name">{searchState.leaker.displayName}</div>
                <div className="leaker-username">@{searchState.leaker.username}</div>
                <div className="leaker-id">ID: {searchState.leaker.id}</div>
                <div className="leaker-roles">
                  <span className="roles-label">身份组:</span>
                  {searchState.leaker.roles.map((role, i) => (
                    <span key={i} className="role-badge">{role}</span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="panel log-panel">
          <h2 className="panel-title">
            <span className="icon">📝</span>
            运行日志
            <button className="btn-clear-log" onClick={() => setSearchState(prev => ({ ...prev, logs: [] }))}>
              清除日志
            </button>
          </h2>
          <div className="log-container">
            {searchState.logs.length === 0 ? (
              <div className="log-empty">暂无日志</div>
            ) : (
              searchState.logs.map((log, i) => (
                <div key={i} className="log-entry">{log}</div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
