import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface Config {
  token: string;
  serverId: string;
  roleIds: string[];
  targetChannelId: string;
  testMessage: string;
  timeout: number;
}

interface LeakerInfo {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  roles: string[];
}

interface SearchState {
  phase: "idle" | "running" | "found" | "not_found";
  currentStep: number;
  totalSteps: number;
  remainingUsers: number;
  logs: string[];
  leaker: LeakerInfo | null;
}

function App() {
  const [config, setConfig] = useState<Config>({
    token: "",
    serverId: "",
    roleIds: [],
    targetChannelId: "",
    testMessage: "TEST_MESSAGE_" + Date.now(),
    timeout: 10,
  });

  const [roleInput, setRoleInput] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({
    phase: "idle",
    currentStep: 0,
    totalSteps: 0,
    remainingUsers: 0,
    logs: [],
    leaker: null,
  });

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setSearchState((prev) => ({
      ...prev,
      logs: [...prev.logs, `[${timestamp}] ${message}`],
    }));
  }, []);

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
    if (!config.token || !config.serverId || config.roleIds.length === 0 || !config.targetChannelId) {
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
    });

    addLog("开始二分搜索...");

    try {
      await listen("search-progress", (event: any) => {
        const data = event.payload;
        setSearchState((prev) => ({
          ...prev,
          currentStep: data.step,
          totalSteps: data.total,
          remainingUsers: data.remaining,
        }));
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
            <input
              type="password"
              placeholder="输入你的Discord账号Token"
              value={config.token}
              onChange={(e) => setConfig((prev) => ({ ...prev, token: e.target.value }))}
            />
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
              {searchState.remainingUsers > 0 && (
                <div className="tree-node active">
                  <span>{searchState.remainingUsers}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="panel result-panel">
          <h2 className="panel-title">
            <span className="icon">🎯</span>
            追踪结果
          </h2>

          {searchState.leaker ? (
            <div className="leaker-card">
              <div className="leaker-avatar">
                {searchState.leaker.avatar ? (
                  <img src={searchState.leaker.avatar} alt="avatar" />
                ) : (
                  <div className="avatar-placeholder">?</div>
                )}
              </div>
              <div className="leaker-info">
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
          ) : (
            <div className="no-result">
              {searchState.phase === "not_found"
                ? "未在指定用户中找到泄露者"
                : "等待追踪完成..."}
            </div>
          )}
        </div>

        <div className="panel log-panel">
          <h2 className="panel-title">
            <span className="icon">📝</span>
            运行日志
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
