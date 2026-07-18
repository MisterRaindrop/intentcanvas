import {
  normalizeDecisionResponse,
  normalizeReview,
  reviewIdFromSearch
} from "./review-model.js";

(() => {
  "use strict";

  const REVIEW_ID = reviewIdFromSearch(window.location.search);
  const HANDOFF_PARAM = "handoff";
  const SESSION_STORAGE_KEY = `intentcanvas-session:${REVIEW_ID}`;

  function handoffFromSearch() {
    const parameters = new URLSearchParams(window.location.search);
    const supplied = parameters.get(HANDOFF_PARAM);
    return supplied && /^[A-Za-z0-9_-]{43}$/u.test(supplied) ? supplied : null;
  }

  function sessionFromStorage() {
    try {
      const session = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      return session && /^[A-Za-z0-9_-]{43}$/u.test(session) ? session : null;
    } catch {
      return null;
    }
  }

  const REVIEW_ENDPOINT = `/api/reviews/${encodeURIComponent(REVIEW_ID)}`;
  const DECISIONS_ENDPOINT = `${REVIEW_ENDPOINT}/decisions`;
  const REVISIONS_ENDPOINT = `${REVIEW_ENDPOINT}/revisions`;

  const CHANGE_LABELS = {
    added: "新增",
    modified: "修改",
    removed: "删除",
    unchanged: "不变"
  };

  const DECISION_LABELS = {
    pending: "待审核",
    approved: "已批准",
    changes_requested: "需要调整"
  };

  const state = {
    review: null,
    selectedModuleId: null,
    flowExpanded: false,
    pseudocodeChangeId: null,
    graphPositions: new Map(),
    savingDecision: false,
    revision: null,
    revisionsLoaded: false,
    staleReview: false,
    handoff: handoffFromSearch(),
    sessionToken: sessionFromStorage()
  };

  const elements = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      "loading-view", "error-view", "overview-view", "module-view", "error-message",
      "retry-button", "connection-status", "review-id", "overview-title", "review-summary",
      "review-revision", "refresh-review-button", "revision-history", "revision-list",
      "revision-message",
      "review-progress", "start-review-button", "architecture-graph", "architecture-lines",
      "architecture-nodes", "mobile-relationships", "module-summaries", "breadcrumb-overview",
      "risks-list", "verification-list",
      "breadcrumb-module", "module-position", "module-title", "module-summary", "module-decision",
      "module-flow", "flow-expanded", "change-groups", "pseudocode-grid", "decision-comment",
      "decision-message", "request-changes-button", "approve-button", "previous-module",
      "back-overview", "next-module", "module-node-template"
    ].forEach((id) => {
      elements[id] = byId(id);
    });
  }

  function text(value, fallback = "") {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
  }

  function removeHandoffFromAddress() {
    const parameters = new URLSearchParams(window.location.search);
    parameters.delete(HANDOFF_PARAM);
    const query = parameters.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    );
  }

  function rememberSession(session) {
    state.sessionToken = session;
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, session);
    } catch {
      // The current page can still use the in-memory review-scoped session.
    }
  }

  function forgetSession() {
    state.sessionToken = null;
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Nothing else is required when storage is unavailable.
    }
  }

  function reviewHeaders({ json = false } = {}) {
    const headers = { Accept: "application/json" };
    if (state.sessionToken) headers.Authorization = `Bearer ${state.sessionToken}`;
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function exchangeBrowserHandoff() {
    if (!state.handoff) return;
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ handoff: state.handoff })
    });
    if (!response.ok) {
      throw new Error(response.status === 401
        ? "打开链接已经过期或使用过，请回到终端重新生成计划链接"
        : `无法建立浏览器会话（服务返回 ${response.status}）`);
    }
    const payload = await response.json();
    if (!payload || payload.ok !== true || payload.reviewId !== REVIEW_ID ||
        typeof payload.session !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(payload.session)) {
      throw new Error("打开链接与当前计划不匹配，请回到终端重新生成");
    }
    rememberSession(payload.session);
    state.handoff = null;
    removeHandoffFromAddress();
  }

  async function fetchReview() {
    showView("loading");
    setConnection("正在载入计划", "loading");
    try {
      await exchangeBrowserHandoff();
      const response = await fetch(REVIEW_ENDPOINT, {
        headers: reviewHeaders()
      });
      if (response.status === 401) {
        forgetSession();
        throw new Error("浏览器会话已失效，请从终端重新点击最新的计划链接");
      }
      if (!response.ok) throw new Error(`服务返回 ${response.status}`);
      const payload = await response.json();
      state.review = normalizeReview(payload.review || payload);
      const revision = Number(response.headers.get("X-IntentCanvas-Revision"));
      state.revision = Number.isInteger(revision) && revision > 0 ? revision : null;
      state.revisionsLoaded = false;
      state.staleReview = state.revision === null;
      elements["review-id"].textContent = state.review.id;
      elements["review-revision"].textContent = state.revision === null
        ? "版本 --"
        : `版本 ${state.revision}`;
      setConnection("计划已连接", "ready");
      renderOverview();
      routeFromHash();
    } catch (error) {
      showError(error instanceof Error ? error.message : "无法连接计划服务");
    }
  }

  function setConnection(label, status) {
    const element = elements["connection-status"];
    element.textContent = label;
    element.className = `connection-status is-${status}`;
  }

  function showError(message) {
    elements["error-message"].textContent = `${message}。请确认 IntentCanvas Runtime 已启动后重试。`;
    setConnection("计划未连接", "error");
    showView("error");
  }

  function showView(name) {
    elements["loading-view"].hidden = name !== "loading";
    elements["error-view"].hidden = name !== "error";
    elements["overview-view"].hidden = name !== "overview";
    elements["module-view"].hidden = name !== "module";
  }

  function createChangeBadge(status) {
    const badge = document.createElement("span");
    badge.className = `change-badge is-${status}`;
    badge.textContent = CHANGE_LABELS[status] || CHANGE_LABELS.modified;
    return badge;
  }

  function moduleById(moduleId) {
    return state.review?.modules.find((module) => module.id === moduleId) || null;
  }

  function openOverview({ updateHash = true } = {}) {
    state.selectedModuleId = null;
    showView("overview");
    if (updateHash && window.location.hash !== "#overview") window.location.hash = "overview";
    window.scrollTo({ top: 0, behavior: "smooth" });
    window.requestAnimationFrame(layoutArchitectureGraph);
  }

  function openModule(moduleId, { updateHash = true } = {}) {
    const module = moduleById(moduleId);
    if (!module) {
      openOverview({ updateHash });
      return;
    }
    state.selectedModuleId = module.id;
    state.flowExpanded = false;
    state.pseudocodeChangeId = null;
    renderModule(module);
    showView("module");
    if (updateHash && window.location.hash !== `#module/${encodeURIComponent(module.id)}`) {
      window.location.hash = `module/${encodeURIComponent(module.id)}`;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function routeFromHash() {
    if (!state.review) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (hash.startsWith("module/")) {
      openModule(decodeURIComponent(hash.slice("module/".length)), { updateHash: false });
    } else {
      openOverview({ updateHash: hash !== "overview" });
    }
  }

  function renderOverview() {
    const review = state.review;
    elements["overview-title"].textContent = review.title;
    elements["review-summary"].textContent = review.summary;
    renderProgress();
    renderArchitecture();
    renderModuleSummaries();
    renderRisks();
    renderVerification();
  }

  async function fetchRevisions() {
    if (state.revisionsLoaded) return;
    elements["revision-message"].textContent = "正在读取版本历史……";
    try {
      const response = await fetch(REVISIONS_ENDPOINT, {
        headers: reviewHeaders()
      });
      if (!response.ok) throw new Error(`服务返回 ${response.status}`);
      const payload = await response.json();
      if (!payload || payload.reviewId !== state.review.id ||
          !Number.isInteger(payload.currentRevision) || !Array.isArray(payload.revisions)) {
        throw new Error("版本历史格式不正确");
      }
      state.revision = payload.currentRevision;
      elements["review-revision"].textContent = `版本 ${state.revision}`;
      renderRevisionHistory(payload.revisions);
      state.revisionsLoaded = true;
    } catch (error) {
      elements["revision-message"].textContent = `版本历史读取失败：${error instanceof Error ? error.message : "请稍后重试"}`;
    }
  }

  function renderRevisionHistory(revisions) {
    const list = elements["revision-list"];
    list.replaceChildren();
    const operationLabels = {
      created: "创建计划",
      replaced: "替换整份计划",
      module_replaced: "调整单个模块",
      decision_updated: "记录模块审批"
    };
    [...revisions].reverse().forEach((revision) => {
      if (!Number.isInteger(revision.revision) || revision.revision < 1 ||
          typeof revision.operation !== "string" || typeof revision.createdAt !== "string") {
        throw new Error("版本记录格式不正确");
      }
      const item = document.createElement("li");
      item.className = "revision-item";
      const label = document.createElement("strong");
      label.textContent = `版本 ${revision.revision} · ${operationLabels[revision.operation] || revision.operation}`;
      const time = document.createElement("time");
      time.dateTime = revision.createdAt;
      time.textContent = new Date(revision.createdAt).toLocaleString();
      item.append(label, time);
      if (revision.moduleId) appendModuleLinks(item, [revision.moduleId]);
      list.appendChild(item);
    });
    elements["revision-message"].textContent = revisions.length === 0
      ? "当前还没有版本记录。"
      : `共 ${revisions.length} 个版本；计划修改和模块审批都会生成不可重放的新版本。`;
  }

  function renderProgress() {
    const modules = state.review.modules;
    const reviewed = modules.filter((module) => module.approval.decision !== "pending").length;
    elements["review-progress"].textContent = `${reviewed} / ${modules.length} 个模块已审核`;
    elements["start-review-button"].textContent = reviewed === 0 ? "开始逐模块审核" : "继续逐模块审核";
  }

  function renderArchitecture() {
    const nodesContainer = elements["architecture-nodes"];
    nodesContainer.replaceChildren();
    state.review.modules.forEach((module) => {
      const fragment = elements["module-node-template"].content.cloneNode(true);
      const button = fragment.querySelector(".module-node");
      button.dataset.moduleId = module.id;
      button.dataset.status = module.status;
      button.setAttribute("aria-label", `${module.name}，${CHANGE_LABELS[module.status]}，查看修改`);
      fragment.querySelector(".module-node-status").textContent = CHANGE_LABELS[module.status];
      fragment.querySelector(".module-node-name").textContent = module.name;
      fragment.querySelector(".module-node-summary").textContent = module.summary;
      button.addEventListener("click", () => openModule(module.id));
      nodesContainer.appendChild(fragment);
    });
    renderMobileRelationships();
    window.requestAnimationFrame(layoutArchitectureGraph);
  }

  function calculateGraphLevels(modules, relationships) {
    const ids = new Set(modules.map((module) => module.id));
    const incoming = new Map(modules.map((module) => [module.id, []]));
    const outgoing = new Map(modules.map((module) => [module.id, []]));

    relationships.forEach((relationship) => {
      if (!ids.has(relationship.from) || !ids.has(relationship.to)) return;
      outgoing.get(relationship.from).push(relationship.to);
      incoming.get(relationship.to).push(relationship.from);
    });

    const levels = new Map();
    const queue = modules.filter((module) => incoming.get(module.id).length === 0).map((module) => module.id);
    queue.forEach((id) => levels.set(id, 0));
    let visited = 0;

    while (queue.length) {
      const id = queue.shift();
      visited += 1;
      outgoing.get(id).forEach((nextId) => {
        const proposed = (levels.get(id) || 0) + 1;
        levels.set(nextId, Math.max(levels.get(nextId) || 0, proposed));
        const allParentsPlaced = incoming.get(nextId).every((parentId) => levels.has(parentId));
        if (allParentsPlaced && !queue.includes(nextId)) queue.push(nextId);
      });
      if (visited > modules.length * 3) break;
    }

    modules.forEach((module, index) => {
      if (!levels.has(module.id)) levels.set(module.id, index);
    });
    return levels;
  }

  function layoutArchitectureGraph() {
    const graph = elements["architecture-graph"];
    if (!graph || graph.hidden || graph.offsetParent === null || !state.review) return;

    const width = graph.clientWidth;
    const height = graph.clientHeight;
    const modules = state.review.modules;
    const levels = calculateGraphLevels(modules, state.review.relationships);
    const maxLevel = Math.max(0, ...levels.values());
    const groups = new Map();

    modules.forEach((module) => {
      const level = levels.get(module.id) || 0;
      if (!groups.has(level)) groups.set(level, []);
      groups.get(level).push(module);
    });

    state.graphPositions.clear();
    groups.forEach((group, level) => {
      group.sort((a, b) => a.order - b.order);
      group.forEach((module, index) => {
        const x = maxLevel === 0
          ? width / 2
          : 118 + (level / maxLevel) * Math.max(0, width - 236);
        const y = (height / (group.length + 1)) * (index + 1);
        state.graphPositions.set(module.id, { x, y });
        const node = elements["architecture-nodes"].querySelector(`[data-module-id="${CSS.escape(module.id)}"]`);
        if (node) {
          node.style.left = `${x}px`;
          node.style.top = `${y}px`;
        }
      });
    });
    drawArchitectureEdges();
  }

  function edgeEndpoints(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const direction = Math.sign(dx) || 1;
      return {
        start: { x: from.x + direction * 104, y: from.y },
        end: { x: to.x - direction * 112, y: to.y }
      };
    }
    const direction = Math.sign(dy) || 1;
    return {
      start: { x: from.x, y: from.y + direction * 66 },
      end: { x: to.x, y: to.y - direction * 72 }
    };
  }

  function drawArchitectureEdges() {
    const svg = elements["architecture-lines"];
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${svg.clientWidth || 1} ${svg.clientHeight || 1}`);

    const namespace = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(namespace, "defs");
    const marker = document.createElementNS(namespace, "marker");
    marker.setAttribute("id", "architecture-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS(namespace, "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "#7c899d");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);

    state.review.relationships.forEach((relationship) => {
      const from = state.graphPositions.get(relationship.from);
      const to = state.graphPositions.get(relationship.to);
      if (!from || !to) return;
      const points = edgeEndpoints(from, to);
      const distance = Math.max(36, Math.abs(points.end.x - points.start.x) * 0.42);
      const path = document.createElementNS(namespace, "path");
      path.setAttribute(
        "d",
        `M ${points.start.x} ${points.start.y} C ${points.start.x + distance} ${points.start.y}, ${points.end.x - distance} ${points.end.y}, ${points.end.x} ${points.end.y}`
      );
      path.setAttribute("marker-end", "url(#architecture-arrow)");
      svg.appendChild(path);
    });
  }

  function renderMobileRelationships() {
    const list = elements["mobile-relationships"];
    list.replaceChildren();
    state.review.relationships.forEach((relationship) => {
      const from = moduleById(relationship.from);
      const to = moduleById(relationship.to);
      if (!from || !to) return;
      const item = document.createElement("li");
      item.className = "mobile-relationship";
      const fromButton = document.createElement("button");
      fromButton.type = "button";
      fromButton.textContent = from.name;
      fromButton.addEventListener("click", () => openModule(from.id));
      const arrow = document.createElement("span");
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");
      const toButton = document.createElement("button");
      toButton.type = "button";
      toButton.textContent = to.name;
      toButton.addEventListener("click", () => openModule(to.id));
      item.append(fromButton, arrow, toButton);
      list.appendChild(item);
    });
  }

  function renderModuleSummaries() {
    const list = elements["module-summaries"];
    list.replaceChildren();
    state.review.modules.forEach((module, index) => {
      const item = document.createElement("li");
      item.className = "module-summary-row";

      const number = document.createElement("span");
      number.className = "summary-index";
      number.textContent = String(index + 1).padStart(2, "0");

      const name = document.createElement("div");
      name.className = "summary-module";
      const strong = document.createElement("strong");
      strong.textContent = module.name;
      name.append(strong, createChangeBadge(module.status));

      const summary = document.createElement("p");
      summary.className = "summary-copy";
      summary.textContent = module.summary;

      const open = document.createElement("button");
      open.type = "button";
      open.className = "summary-open";
      open.textContent = "查看细节 →";
      open.setAttribute("aria-label", `查看 ${module.name} 的修改细节`);
      open.addEventListener("click", () => openModule(module.id));

      item.append(number, name, summary, open);
      list.appendChild(item);
    });
  }

  function appendModuleLinks(container, moduleIds) {
    const links = document.createElement("div");
    links.className = "evidence-modules";
    moduleIds.forEach((moduleId) => {
      const module = moduleById(moduleId);
      if (!module) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "evidence-module-link";
      button.textContent = module.name;
      button.addEventListener("click", () => openModule(module.id));
      links.appendChild(button);
    });
    if (links.childElementCount > 0) container.appendChild(links);
  }

  function renderRisks() {
    const list = elements["risks-list"];
    list.replaceChildren();
    if (state.review.risks.length === 0) {
      const empty = document.createElement("li");
      empty.className = "evidence-empty";
      empty.textContent = "当前计划没有登记核心风险。";
      list.appendChild(empty);
      return;
    }

    state.review.risks.forEach((risk) => {
      const item = document.createElement("li");
      item.className = `evidence-item risk-item is-${risk.level}`;
      const heading = document.createElement("div");
      heading.className = "evidence-item-heading";
      const title = document.createElement("strong");
      title.textContent = risk.title;
      const level = document.createElement("span");
      level.className = "risk-level";
      level.textContent = risk.level.toUpperCase();
      heading.append(title, level);
      const mitigation = document.createElement("p");
      mitigation.textContent = risk.mitigation;
      item.append(heading, mitigation);
      appendModuleLinks(item, risk.moduleIds);
      list.appendChild(item);
    });
  }

  function renderVerification() {
    const list = elements["verification-list"];
    list.replaceChildren();
    state.review.verification.forEach((check) => {
      const item = document.createElement("li");
      item.className = "evidence-item verification-item";
      const heading = document.createElement("div");
      heading.className = "evidence-item-heading";
      const type = document.createElement("span");
      type.className = "verification-type";
      type.textContent = check.type;
      const expected = document.createElement("strong");
      expected.textContent = check.expected;
      heading.append(type, expected);
      const command = document.createElement("code");
      command.className = "verification-command";
      command.textContent = check.command;
      item.append(heading, command);
      appendModuleLinks(item, check.moduleIds);
      list.appendChild(item);
    });
  }

  function renderModule(module) {
    const modules = state.review.modules;
    const index = modules.findIndex((item) => item.id === module.id);
    elements["breadcrumb-module"].textContent = module.name;
    elements["module-position"].textContent = `模块 ${index + 1} / ${modules.length} · ${CHANGE_LABELS[module.status]}`;
    elements["module-title"].textContent = module.name;
    elements["module-summary"].textContent = module.summary;
    elements["decision-comment"].value = module.approval.comment;
    elements["decision-message"].textContent = "";
    setDecisionControlsDisabled(state.staleReview || state.savingDecision);
    updateDecisionStatus(module);
    renderModuleFlow(module);
    renderChangeGroups(module);
    renderPseudocode(module);
    updateModuleNavigation(index);
  }

  function updateDecisionStatus(module) {
    const decision = module.approval.decision;
    elements["module-decision"].className = `decision-status is-${decision.replaceAll("_", "-")}`;
    elements["module-decision"].textContent = DECISION_LABELS[decision] || DECISION_LABELS.pending;
  }

  function flowItemsFor(module) {
    const changeWithPath = module.changes.find((change) => change.callPath.length > 0);
    if (changeWithPath) {
      return changeWithPath.callPath.map((step, index) => ({
        id: String(step.id || `step-${index}`),
        label: text(step.label || step.signature, `步骤 ${index + 1}`),
        description: text(step.description),
        status: step.status,
        collapsedCount: Math.max(0, Number(step.collapsedCount) || 0),
        collapsedSteps: Array.isArray(step.collapsedSteps) ? step.collapsedSteps : []
      }));
    }

    const diagramNodes = module.diagram.nodes;
    if (diagramNodes.length) {
      return diagramNodes.map((node, index) => ({
        id: String(node.id || `node-${index}`),
        label: text(node.label, `节点 ${index + 1}`),
        description: text(node.description || node.type),
        status: node.status,
        collapsedCount: Math.max(0, Number(node.collapsedCount) || 0),
        collapsedSteps: Array.isArray(node.collapsedSteps) ? node.collapsedSteps : []
      }));
    }

    const entry = module.entryPoints[0];
    return [
      {
        id: "entry",
        label: entry?.signature || module.name,
        description: entry?.file || "关键入口",
        status: module.status,
        collapsedCount: 0,
        collapsedSteps: []
      },
      {
        id: "implementation",
        label: module.changes[0]?.title || "按计划实现",
        description: "本模块关键修改",
        status: module.changes[0]?.status || module.status,
        collapsedCount: 0,
        collapsedSteps: []
      }
    ];
  }

  function renderModuleFlow(module) {
    const container = elements["module-flow"];
    const expanded = elements["flow-expanded"];
    container.replaceChildren();
    expanded.replaceChildren();
    expanded.hidden = true;
    state.flowExpanded = false;

    const items = flowItemsFor(module);
    items.forEach((item, index) => {
      if (index > 0) {
        const arrow = document.createElement("span");
        arrow.className = "flow-arrow";
        arrow.textContent = "→";
        arrow.setAttribute("aria-hidden", "true");
        container.appendChild(arrow);
      }

      if (item.collapsedCount > 0) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "flow-collapse";
        button.textContent = `折叠 ${item.collapsedCount} 个普通步骤`;
        button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", () => toggleCollapsedFlow(button, item));
        container.appendChild(button);
        return;
      }

      const node = document.createElement("div");
      node.className = "flow-node";
      node.dataset.status = item.status;
      const signature = document.createElement("code");
      signature.textContent = item.label;
      const description = document.createElement("small");
      description.textContent = item.description || CHANGE_LABELS[item.status];
      node.append(signature, description);
      container.appendChild(node);
    });
  }

  function toggleCollapsedFlow(button, item) {
    const expanded = elements["flow-expanded"];
    state.flowExpanded = !state.flowExpanded;
    button.setAttribute("aria-expanded", String(state.flowExpanded));
    button.textContent = state.flowExpanded
      ? "收起普通步骤"
      : `折叠 ${item.collapsedCount} 个普通步骤`;
    expanded.hidden = !state.flowExpanded;
    expanded.replaceChildren();
    if (!state.flowExpanded) return;

    const intro = document.createElement("p");
    intro.textContent = "这些函数只负责转发或准备参数，不影响本次设计判断：";
    const list = document.createElement("ol");
    const labels = item.collapsedSteps.length
      ? item.collapsedSteps.map((step) => text(step.label || step.signature, "普通步骤"))
      : Array.from({ length: item.collapsedCount }, (_, index) => `普通内部步骤 ${index + 1}`);
    labels.forEach((label) => {
      const listItem = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = label;
      listItem.appendChild(code);
      list.appendChild(listItem);
    });
    expanded.append(intro, list);
  }

  function renderChangeGroups(module) {
    const container = elements["change-groups"];
    container.replaceChildren();
    const order = ["added", "modified", "removed", "unchanged"];
    const grouped = new Map(order.map((status) => [status, []]));
    module.changes.forEach((change) => grouped.get(change.status).push(change));

    order.forEach((status) => {
      const changes = grouped.get(status);
      if (!changes.length) return;
      const group = document.createElement("div");
      group.className = "change-group";

      const heading = document.createElement("div");
      heading.className = "change-group-heading";
      heading.appendChild(createChangeBadge(status));
      const title = document.createElement("h3");
      title.textContent = `${changes.length} 处${CHANGE_LABELS[status]}内容`;
      heading.appendChild(title);

      const list = document.createElement("ul");
      list.className = "change-list";
      changes.forEach((change) => {
        const item = document.createElement("li");
        item.className = "change-item";
        const symbol = document.createElement("code");
        const location = text(change.location.symbol || change.location.file);
        symbol.textContent = location || change.title;
        const explanation = document.createElement("p");
        explanation.textContent = location && location !== change.title
          ? `${change.title}：${change.rationale}`
          : change.rationale;
        item.append(symbol, explanation);
        if (Array.isArray(change.dependencies) && change.dependencies.length > 0) {
          const dependencies = document.createElement("div");
          dependencies.className = "change-dependencies";
          change.dependencies.forEach((dependency) => {
            const row = document.createElement("div");
            row.className = "change-dependency";
            row.appendChild(createChangeBadge(dependency.status));
            const edge = document.createElement("code");
            edge.textContent = dependency.kind === "include"
              ? `#include: ${dependency.from} → ${dependency.to}`
              : `${dependency.from} → ${dependency.to}`;
            row.appendChild(edge);
            dependencies.appendChild(row);
          });
          item.appendChild(dependencies);
        }
        list.appendChild(item);
      });

      group.append(heading, list);
      container.appendChild(group);
    });

    if (!module.changes.length) {
      const empty = document.createElement("p");
      empty.className = "summary-copy";
      empty.textContent = "这个模块只作为调用路径背景展示，没有直接代码修改。";
      container.appendChild(empty);
    }
  }

  function pseudocodeChanges(module) {
    return module.changes.filter((change) => {
      const pseudo = change.pseudocode;
      return pseudo && (text(pseudo.before) || text(pseudo.after));
    });
  }

  function renderPseudocode(module) {
    const container = elements["pseudocode-grid"];
    container.replaceChildren();
    const changes = pseudocodeChanges(module);
    if (!changes.length) {
      const empty = document.createElement("p");
      empty.className = "summary-copy pseudocode-empty";
      empty.textContent = "这个模块不需要新增主干逻辑，具体约束已经写在上面的修改项中。";
      container.appendChild(empty);
      return;
    }

    if (!state.pseudocodeChangeId || !changes.some((change) => change.id === state.pseudocodeChangeId)) {
      state.pseudocodeChangeId = changes[0].id;
    }

    if (changes.length > 1) {
      const tabs = document.createElement("div");
      tabs.className = "pseudocode-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "选择伪代码修改项");
      changes.forEach((change) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pseudocode-tab";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(change.id === state.pseudocodeChangeId));
        button.textContent = change.title;
        button.addEventListener("click", () => {
          state.pseudocodeChangeId = change.id;
          renderPseudocode(module);
        });
        tabs.appendChild(button);
      });
      container.appendChild(tabs);
    }

    const selected = changes.find((change) => change.id === state.pseudocodeChangeId) || changes[0];
    const language = text(selected.pseudocode.language, "伪代码");
    container.append(
      createCodePanel("修改前", language, text(selected.pseudocode.before, "// 当前没有对应逻辑")),
      createCodePanel("计划修改后", language, text(selected.pseudocode.after, "// 删除这段逻辑"))
    );
  }

  function createCodePanel(label, language, codeText) {
    const panel = document.createElement("article");
    panel.className = "code-panel";
    const header = document.createElement("header");
    header.className = "code-panel-header";
    const title = document.createElement("strong");
    title.textContent = label;
    const badge = document.createElement("span");
    badge.className = "change-badge";
    badge.textContent = language;
    header.append(title, badge);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeText;
    pre.appendChild(code);
    panel.append(header, pre);
    return panel;
  }

  function updateModuleNavigation(index) {
    const modules = state.review.modules;
    const previous = modules[index - 1];
    const next = modules[index + 1];
    elements["previous-module"].disabled = !previous;
    elements["previous-module"].textContent = previous ? `← ${previous.name}` : "← 已是第一个模块";
    elements["next-module"].disabled = !next;
    elements["next-module"].textContent = next ? `${next.name} →` : "已是最后一个模块";
    elements["previous-module"].dataset.targetModule = previous?.id || "";
    elements["next-module"].dataset.targetModule = next?.id || "";
  }

  async function submitDecision(decision) {
    if (state.savingDecision) return;
    const module = moduleById(state.selectedModuleId);
    if (!module) return;
    if (!Number.isInteger(state.revision) || state.revision < 1 || state.staleReview) {
      elements["decision-message"].textContent = "计划版本已变化，请先点右上角“刷新”并重新查看这个模块。";
      setDecisionControlsDisabled(true);
      return;
    }
    const comment = elements["decision-comment"].value.trim();
    if (decision === "changes_requested" && !comment) {
      elements["decision-message"].textContent = "请先写明需要调整的地方，AI 才知道如何重新规划。";
      elements["decision-comment"].focus();
      return;
    }

    state.savingDecision = true;
    setDecisionControlsDisabled(true);
    elements["decision-message"].textContent = "正在保存审核结果……";
    try {
      const response = await fetch(DECISIONS_ENDPOINT, {
        method: "POST",
        headers: reviewHeaders({ json: true }),
        body: JSON.stringify({
          moduleId: module.id,
          decision,
          comment,
          expectedRevision: state.revision
        })
      });
      if (response.status === 409) {
        state.staleReview = true;
        state.revisionsLoaded = false;
        throw new Error("计划已经更新，请刷新后重新审核当前模块");
      }
      if (!response.ok) throw new Error(`服务返回 ${response.status}`);
      const result = normalizeDecisionResponse(await response.json(), {
        expectedReviewId: state.review.id,
        expectedModuleId: module.id
      });
      module.approval = result.approval;
      state.review.status = result.reviewStatus;
      state.revision = result.revision;
      updateDecisionStatus(module);
      renderProgress();
      elements["decision-message"].textContent = result.approval.decision === "approved"
        ? "已记录：这个模块可以按当前计划执行。"
        : "已记录调整意见，AI 可以据此重新生成这个模块。";
    } catch (error) {
      elements["decision-message"].textContent = `保存失败：${error instanceof Error ? error.message : "请稍后重试"}`;
    } finally {
      state.savingDecision = false;
      setDecisionControlsDisabled(state.staleReview || state.savingDecision);
    }
  }

  function setDecisionControlsDisabled(disabled) {
    elements["approve-button"].disabled = disabled;
    elements["request-changes-button"].disabled = disabled;
    elements["decision-comment"].disabled = disabled;
  }

  function bindEvents() {
    elements["retry-button"].addEventListener("click", fetchReview);
    elements["refresh-review-button"].addEventListener("click", fetchReview);
    elements["revision-history"].addEventListener("toggle", (event) => {
      if (event.currentTarget.open) fetchRevisions();
    });
    elements["start-review-button"].addEventListener("click", () => {
      const next = state.review.modules.find((module) => module.approval.decision === "pending")
        || state.review.modules[0];
      openModule(next.id);
    });
    elements["breadcrumb-overview"].addEventListener("click", () => openOverview());
    elements["back-overview"].addEventListener("click", () => openOverview());
    elements["previous-module"].addEventListener("click", (event) => {
      const moduleId = event.currentTarget.dataset.targetModule;
      if (moduleId) openModule(moduleId);
    });
    elements["next-module"].addEventListener("click", (event) => {
      const moduleId = event.currentTarget.dataset.targetModule;
      if (moduleId) openModule(moduleId);
    });
    elements["approve-button"].addEventListener("click", () => submitDecision("approved"));
    elements["request-changes-button"].addEventListener("click", () => submitDecision("changes_requested"));
    window.addEventListener("hashchange", routeFromHash);
    window.addEventListener("resize", layoutArchitectureGraph, { passive: true });
  }

  function init() {
    cacheElements();
    bindEvents();
    fetchReview();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
