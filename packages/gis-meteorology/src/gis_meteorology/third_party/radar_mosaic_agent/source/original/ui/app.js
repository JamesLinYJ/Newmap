const apiBase = "http://127.0.0.1:5055";

const strategies = {
  max: {
    key: "max",
    badge: "推荐方案",
    title: "最大反射率拼接",
    text: "结合当前站点规模、业务时效要求与展示目标，建议优先采用最大反射率拼接作为当前任务的默认策略。",
    reasons: [
      "当前站点规模较小，规则直接，最容易快速形成稳定结果。",
      "对强回波保留效果明显，适合汇报和教学演示。",
      "适合作为智能体默认保底方案，便于后续接入更复杂算法。"
    ],
    latency: "4 min",
    stations: "3",
    summary: "最大反射率拼接",
  },
  weighted: {
    key: "weighted",
    badge: "增强方案",
    title: "距离加权拼接",
    text: "当任务更强调图面连续性与重叠区平滑过渡时，可优先考虑距离加权拼接作为增强策略。",
    reasons: [
      "重叠区衔接更柔和，画面展示更精致。",
      "适合后续站点数量变多时继续扩展。",
      "比最大值拼接更适合做展示型成图。"
    ],
    latency: "5 min",
    stations: "3",
    summary: "距离加权拼接",
  },
  quality: {
    key: "quality",
    badge: "业务升级",
    title: "质量评分拼接",
    text: "基于回波强度与站点距离构建质量评分，优先保留质量更高的像元结果。",
    reasons: [
      "可以把质量控制和拼图决策放进同一条链路。",
      "更接近真正业务系统的算法选择逻辑。",
      "适合后续接入异常站点剔除和置信评分。"
    ],
    latency: "6 min",
    stations: "2-3",
    summary: "质量评分拼接",
  },
  strict: {
    key: "strict",
    badge: "时效优先",
    title: "严格同步拼接",
    text: "严格缩小站点参与的时间容差窗口，优先保证拼图时次的一致性。",
    reasons: [
      "时次最严谨，适合做对比实验和流程评估。",
      "更强调时间一致性，适合科研方法说明。",
      "代价是某些时次可能牺牲覆盖完整度。"
    ],
    latency: "3-4 min",
    stations: "2-3",
    summary: "严格同步拼接",
  },
};

let currentDataset = "default";
let currentStrategy = "max";
let currentProduct = "reflectivity";
let productCatalog = [
  { key: "reflectivity", label: "反射率场", short_label: "反射率", unit: "dBZ" },
];

const recommendationBadge = document.getElementById("recommendationBadge");
const recommendationTitle = document.getElementById("recommendationTitle");
const recommendationText = document.getElementById("recommendationText");
const metricStations = document.getElementById("metricStations");
const metricLatency = document.getElementById("metricLatency");
const metricReasons = document.getElementById("metricReasons");
const reasonList = document.getElementById("reasonList");
const recommendBtn = document.getElementById("recommendBtn");
const launchBtn = document.getElementById("launchBtn");
const compareBtn = document.getElementById("compareBtn");
const goalMode = document.getElementById("goalMode");
const timeStrategy = document.getElementById("timeStrategy");
const previewImage = document.getElementById("previewImage");
const summaryStrategy = document.getElementById("summaryStrategy");
const clockValue = document.getElementById("clockValue");
const summaryTarget = document.getElementById("summaryTarget");
const summaryStationCount = document.getElementById("summaryStationCount");
const summaryStations = document.getElementById("summaryStations");
const currentDatasetLabel = document.getElementById("currentDatasetLabel");
const currentProductLabel = document.getElementById("currentProductLabel");
const executionStrategy = document.getElementById("executionStrategy");
const targetTimeInput = document.getElementById("targetTime");
const datasetSelect = document.getElementById("datasetSelect");
const levelIndex = document.getElementById("levelIndex");
const stationTableBody = document.getElementById("stationTableBody");
const logList = document.getElementById("logList");
const compareResult = document.getElementById("compareResult");
const connectBox = document.getElementById("connectBox");
const connectText = document.getElementById("connectText");
const toast = document.getElementById("toast");
const algoOptions = document.querySelectorAll(".algo-option[data-strategy]");
const productPicker = document.getElementById("productPicker");

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setConnectionState(online, message) {
  connectBox.classList.toggle("online", online);
  connectBox.classList.toggle("offline", !online);
  connectText.textContent = message;
}

function syncAlgorithmSelection(strategyKey) {
  algoOptions.forEach((button) => {
    button.classList.toggle("active", button.dataset.strategy === strategyKey);
  });
}

function syncProductSelection(productKey) {
  productPicker.querySelectorAll(".algo-option[data-product]").forEach((button) => {
    button.classList.toggle("active", button.dataset.product === productKey);
  });
}

function renderRecommendation(data) {
  currentStrategy = data.key || currentStrategy;
  recommendationBadge.textContent = data.badge;
  recommendationTitle.textContent = data.title;
  recommendationText.textContent = data.text;
  metricStations.textContent = data.stations;
  metricLatency.textContent = data.latency;
  metricReasons.textContent = String(data.reasons.length);
  summaryStrategy.textContent = data.summary || data.title;
  executionStrategy.textContent = data.summary || data.title;
  reasonList.innerHTML = data.reasons
    .map((reason, index) => `<article><h4>原因 ${index + 1}</h4><p>${reason}</p></article>`)
    .join("");
  syncAlgorithmSelection(currentStrategy);
}

function renderStations(stations) {
  stationTableBody.innerHTML = stations
    .map(
      (item) => `
        <tr>
          <td>${item.station}</td>
          <td>${item.latest_time}</td>
          <td><span class="table-status">正常</span></td>
        </tr>
      `
    )
    .join("");

  summaryStationCount.textContent = `${stations.length} 站`;
  summaryStations.textContent = stations.map((item) => item.station).join(" / ");
}

function renderTimeOptions(options, selectedValue) {
  targetTimeInput.innerHTML = options
    .map((item) => `<option value="${item.value}" ${item.value === selectedValue ? "selected" : ""}>${item.label}</option>`)
    .join("");
}

function renderDatasetOptions(options, selectedKey) {
  datasetSelect.innerHTML = options
    .map((item) => `<option value="${item.key}" ${item.key === selectedKey ? "selected" : ""}>${item.label}</option>`)
    .join("");
  const selected = options.find((item) => item.key === selectedKey);
  currentDatasetLabel.textContent = selected ? selected.label : selectedKey;
}

function renderLogs(logs) {
  const source = logs && logs.length ? logs : [{ time: "--:--", message: "等待任务执行。" }];
  logList.innerHTML = source
    .map((item) => `<article class="log-item"><span class="log-time">${item.time}</span><p>${item.message}</p></article>`)
    .join("");
}

function renderCompare(items) {
  compareResult.innerHTML = items
    .map((item) => `<p><strong>${item.name}</strong>${item.recommended === "yes" ? "（推荐）" : ""}：${item.summary}</p>`)
    .join("");
}

function renderProductLabel() {
  const selected = productCatalog.find((item) => item.key === currentProduct);
  currentProductLabel.textContent = selected ? selected.label : currentProduct;
}

function renderProductOptions(products) {
  if (products && products.length) {
    productCatalog = products;
  }
  productPicker.innerHTML = productCatalog
    .map((item) => {
      const unit = item.unit ? item.unit : "无量纲";
      return `
        <button class="algo-option ${item.key === currentProduct ? "active" : ""}" data-product="${item.key}" type="button">
          <strong>${item.label}</strong>
          <span>${item.short_label} · ${unit}</span>
        </button>
      `;
    })
    .join("");

  productPicker.querySelectorAll(".algo-option[data-product]").forEach((button) => {
    button.addEventListener("click", () => {
      currentProduct = button.dataset.product;
      syncProductSelection(currentProduct);
      renderProductLabel();
      showToast(`已切换拼图产品：${currentProductLabel.textContent}`);
    });
  });
}

async function loadDashboard(datasetKey = currentDataset, isInit = false) {
  // 首次加载时显示载入状态
  if (isInit) {
    clockValue.textContent = "正在连接...";
  }

  const healthRes = await fetch(`${apiBase}/health`);
  if (!healthRes.ok) throw new Error("后台未响应");
  setConnectionState(true, "后台服务连接正常");

  currentDataset = datasetKey;

  // 切换数据集时显示加载提示
  clockValue.textContent = "正在加载...";
  summaryTarget.textContent = "数据加载中...";

  const res = await fetch(`${apiBase}/api/dashboard?dataset=${encodeURIComponent(datasetKey)}`);
  const data = await res.json();

  clockValue.textContent = data.latest_time;
  summaryTarget.textContent = `目标时次 ${data.latest_time}`;

  // 只在首次初始化时构建数据集下拉框，避免切换时重建导致选中状态异常
  if (isInit) {
    renderDatasetOptions(data.datasets, data.dataset);
  } else {
    currentDatasetLabel.textContent = data.datasets.find((d) => d.key === data.dataset)?.label || data.dataset;
  }

  renderTimeOptions(data.time_options, data.default_target_time);
  renderProductOptions(data.products);
  renderProductLabel();
  previewImage.src = `${apiBase}${data.preview_image}?t=${Date.now()}`;
  renderStations(data.stations);
  renderLogs(data.logs);
}

async function fetchRecommendation() {
  const payload = {
    goal_mode: goalMode.value,
    time_strategy: timeStrategy.value,
  };
  const res = await fetch(`${apiBase}/api/recommend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  const merged = { ...strategies[data.key], ...data };
  renderRecommendation(merged);
  await refreshLogs();
  showToast(`已生成建议：${merged.title}`);
}

async function runTask() {
  const payload = {
    dataset: currentDataset,
    target_time: targetTimeInput.value,
    time_tolerance_sec: 300,
    boundary_mode: "county",
    strategy: currentStrategy,
    product: currentProduct,
    level_index: Number(levelIndex.value || 0),
  };

  launchBtn.disabled = true;
  launchBtn.textContent = "生成中...";
  try {
    const res = await fetch(`${apiBase}/api/run-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "任务执行失败");
    previewImage.src = `${apiBase}${data.image_url}?t=${Date.now()}`;
    summaryTarget.textContent = `目标时次 ${data.target_time}`;
    recommendationText.textContent = `${recommendationText.textContent.split(" 已完成")[0]} 已完成一次真实拼图执行，参与站点: ${data.stations.join(", ")}。`;
    renderLogs(data.logs);
    showToast(`拼图已生成（产品：${data.product_label || currentProductLabel.textContent}，算法：${currentStrategy}）`);
  } catch (error) {
    recommendationText.textContent = `任务执行失败: ${error.message}`;
    await refreshLogs();
    showToast(`执行失败：${error.message}`);
  } finally {
    launchBtn.disabled = false;
    launchBtn.textContent = "发起任务调度";
  }
}

async function runCompare() {
  compareBtn.disabled = true;
  compareBtn.textContent = "生成中...";
  try {
    const res = await fetch(`${apiBase}/api/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal_mode: goalMode.value,
        time_strategy: timeStrategy.value,
      }),
    });
    const data = await res.json();
    renderCompare(data.items);
    await refreshLogs();
    showToast("算法对比已生成");
  } finally {
    compareBtn.disabled = false;
    compareBtn.textContent = "生成算法对比";
  }
}

async function refreshLogs() {
  const res = await fetch(`${apiBase}/api/logs`);
  const data = await res.json();
  renderLogs(data.logs);
}

datasetSelect.addEventListener("change", async () => {
  await loadDashboard(datasetSelect.value);
  showToast(`已切换到数据集：${datasetSelect.options[datasetSelect.selectedIndex].text}`);
});

/* ---- 数据集导入 ---- */
const importDatasetBtn = document.getElementById("importDatasetBtn");
const importDialog = document.getElementById("importDialog");
const importFolderPath = document.getElementById("importFolderPath");
const importLabel = document.getElementById("importLabel");
const importConfirmBtn = document.getElementById("importConfirmBtn");
const importCancelBtn = document.getElementById("importCancelBtn");
const scanFoldersBtn = document.getElementById("scanFoldersBtn");
const scanResults = document.getElementById("scanResults");

importDatasetBtn.addEventListener("click", () => {
  importDialog.style.display = importDialog.style.display === "none" ? "block" : "none";
});

importCancelBtn.addEventListener("click", () => {
  importDialog.style.display = "none";
  importFolderPath.value = "";
  importLabel.value = "";
  scanResults.style.display = "none";
});

importConfirmBtn.addEventListener("click", async () => {
  const path = importFolderPath.value.trim();
  if (!path) { showToast("请输入文件夹路径"); return; }
  importConfirmBtn.disabled = true;
  importConfirmBtn.textContent = "导入中...";
  try {
    const res = await fetch(`${apiBase}/api/dashboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", path, label: importLabel.value.trim() || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "导入失败"); return; }
    showToast(`已导入: ${data.label} (${data.station_count}站, ${data.file_count}文件)`);
    importDialog.style.display = "none";
    importFolderPath.value = "";
    importLabel.value = "";
    await loadDashboard(data.key, true);
  } catch (e) {
    showToast("导入失败: " + e.message);
  } finally {
    importConfirmBtn.disabled = false;
    importConfirmBtn.textContent = "导入";
  }
});

scanFoldersBtn.addEventListener("click", async () => {
  scanFoldersBtn.disabled = true;
  scanFoldersBtn.textContent = "扫描中...";
  try {
    // 直接调用已有接口，不依赖新路由
    const res = await fetch(`${apiBase}/api/dashboard?dataset=default`);
    const dashboard = await res.json();
    // 从已有数据集列表中构建扫描结果
    const folders = dashboard.datasets.map(ds => ({
      key: ds.key,
      label: ds.label,
      path: '',
      file_count: 0,
      status: '已导入'
    }));
    const data = { folders };
    if (data.folders.length === 0) {
      scanResults.innerHTML = "<p class='import-scan-hint'>未发现可导入的文件夹</p>";
    } else {
      scanResults.innerHTML = data.folders.map(f => `
        <div class="scan-item">
          <span>📁 ${f.label} <small style="color:var(--ink-soft)">(${f.file_count}文件)</small></span>
          ${f.status === "已导入"
            ? "<span style='color:var(--success);font-size:11px'>✓ 已导入</span>"
            : `<button class='button primary scan-item-import' data-path='${f.path}' data-key='${f.key}'>导入</button>`
          }
        </div>
      `).join("");
      // 绑定导入按钮
      scanResults.querySelectorAll(".scan-item-import").forEach(btn => {
        btn.addEventListener("click", async () => {
          const fp = btn.dataset.path;
          const fk = btn.dataset.key;
          btn.disabled = true; btn.textContent = "导入中...";
          try {
            const r = await fetch(`${apiBase}/api/dashboard`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "add", path: fp, key: fk }),
            });
            const d = await r.json();
            if (r.ok) {
              showToast(`已导入: ${d.label}`);
              await loadDashboard(fk, true);
              importDialog.style.display = "none";
            } else {
              showToast(d.error || "导入失败");
            }
          } catch (e) {
            showToast("导入失败: " + e.message);
          }
        });
      });
    }
    scanResults.style.display = "block";
  } catch (e) {
    showToast("扫描失败");
  } finally {
    scanFoldersBtn.disabled = false;
    scanFoldersBtn.textContent = "🔍 扫描可用数据";
  }
});

algoOptions.forEach((button) => {
  button.addEventListener("click", () => {
    currentStrategy = button.dataset.strategy;
    syncAlgorithmSelection(currentStrategy);
    const preset = strategies[currentStrategy];
    executionStrategy.textContent = preset.summary || preset.title;
    showToast(`已切换执行算法：${preset.title}`);
  });
});

recommendBtn.addEventListener("click", fetchRecommendation);
compareBtn.addEventListener("click", runCompare);
// launchBtn 的绑定在对比模式包装 runTask 之后

/* ---- 对比模式 ---- */
let compareMode = false;
let comparePosition = 50;
let compareDragging = false;
let compareReferenceLoaded = false;
let lastComparisonData = null;

const toggleCompareBtn = document.getElementById("toggleCompareBtn");
const normalPreview = document.getElementById("normalPreview");
const comparePanel = document.getElementById("comparePanel");
const referenceFileInput = document.getElementById("referenceFileInput");
const referenceUrlInput = document.getElementById("referenceUrlInput");
const loadReferenceUrlBtn = document.getElementById("loadReferenceUrlBtn");
const compareUploadBtn = document.getElementById("compareUploadBtn");
const compareManualUpload = document.getElementById("compareManualUpload");
const compareWrapper = document.getElementById("compareWrapper");
const compareOverlay = document.getElementById("compareOverlay");
const compareHandleBar = document.getElementById("compareHandleBar");
const compareHandleGrip = document.getElementById("compareHandleGrip");
const compareReferenceImg = document.getElementById("compareReferenceImg");
const compareGeneratedImg = document.getElementById("compareGeneratedImg");
const compareRefInfo = document.getElementById("compareRefInfo");
const compareAutoBadge = document.getElementById("compareAutoBadge");
const compareStats = document.getElementById("compareStats");
const statRmse = document.getElementById("statRmse");
const statMae = document.getElementById("statMae");
const statCorr = document.getElementById("statCorr");
const statBias = document.getElementById("statBias");
const statGenMean = document.getElementById("statGenMean");
const statRefMean = document.getElementById("statRefMean");

// Tabs
const compareTabSlider = document.getElementById("compareTabSlider");
const compareTabDetail = document.getElementById("compareTabDetail");
const compareTabs = document.getElementById("compareTabs");
const viewFullComparisonBtn = document.getElementById("viewFullComparisonBtn");

// Modal
const compareModal = document.getElementById("compareModal");
const compareModalImg = document.getElementById("compareModalImg");
const compareModalClose = document.getElementById("compareModalClose");

function updateCompareClip(position) {
  const pct = Math.max(2, Math.min(98, position));
  comparePosition = pct;
  compareOverlay.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  compareHandleBar.style.left = `${pct}%`;
}

function switchCompareTab(tabName) {
  compareTabs.querySelectorAll(".compare-tab").forEach((t) => t.classList.remove("active"));
  compareTabs.querySelector(`[data-tab="${tabName}"]`)?.classList.add("active");
  compareTabSlider.style.display = tabName === "slider" ? "block" : "none";
  compareTabDetail.style.display = tabName === "detail" ? "block" : "none";
}

function openCompareModal() {
  if (lastComparisonData?.comparison_image_url) {
    compareModalImg.src = `${apiBase}${lastComparisonData.comparison_image_url}?t=${Date.now()}`;
    compareModal.style.display = "flex";
  } else {
    showToast("暂无对比图数据，请先执行拼图任务");
  }
}

function closeCompareModal() {
  compareModal.style.display = "none";
}

function loadReferenceFromFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("请选择图片文件");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    compareReferenceImg.src = reader.result;
    compareReferenceLoaded = true;
    updateCompareClip(comparePosition);
    showToast(`已加载参考图：${file.name}`);
  };
  reader.onerror = () => showToast("读取文件失败");
  reader.readAsDataURL(file);
}

function loadReferenceFromUrl(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) {
    showToast("请输入图片URL");
    return;
  }
  const finalUrl = trimmed.startsWith("http") && !trimmed.includes("127.0.0.1")
    ? `${apiBase}/api/proxy-image?url=${encodeURIComponent(trimmed)}`
    : trimmed;
  compareReferenceImg.src = finalUrl;
  compareReferenceImg.onload = () => {
    compareReferenceLoaded = true;
    compareReferenceImg.onload = null;
    compareReferenceImg.onerror = null;
    updateCompareClip(comparePosition);
    showToast("已加载参考图");
  };
  compareReferenceImg.onerror = () => {
    compareReferenceImg.onerror = null;
    compareReferenceImg.onload = null;
    showToast("图片加载失败，请检查URL是否可访问");
  };
}

function populateComparisonFromBackend(data) {
  lastComparisonData = data;
  if (!data || !data.reference_image_url) return;

  const refUrl = `${apiBase}${data.reference_image_url}?t=${Date.now()}`;
  compareReferenceImg.src = refUrl;
  compareGeneratedImg.src = previewImage.src;
  compareReferenceLoaded = true;

  compareAutoBadge.textContent = "🤖 NC参考自动匹配";
  compareAutoBadge.style.background = "rgba(46, 139, 87, 0.12)";
  compareAutoBadge.style.color = "#2e8b57";
  compareRefInfo.textContent = `${data.nc_file} | 高度${data.nc_level_height_km?.toFixed(1)}km`;

  if (data.stats) {
    const s = data.stats;
    statRmse.textContent = s.rmse != null ? s.rmse.toFixed(2) : "--";
    statMae.textContent = s.mae != null ? s.mae.toFixed(2) : "--";
    statCorr.textContent = s.correlation != null ? s.correlation.toFixed(4) : "--";
    statBias.textContent = s.bias != null ? (s.bias >= 0 ? "+" : "") + s.bias.toFixed(2) : "--";
    statGenMean.textContent = s.gen_mean != null ? s.gen_mean.toFixed(1) : "--";
    statRefMean.textContent = s.ref_mean != null ? s.ref_mean.toFixed(1) : "--";
    compareStats.style.display = "flex";
  }

  // 显示详情按钮
  if (data.comparison_image_url) {
    viewFullComparisonBtn.style.display = "";
  }

  if (!compareMode) {
    setCompareMode(true);
  } else {
    updateCompareClip(comparePosition);
  }
}

function setCompareMode(active) {
  compareMode = active;
  if (active) {
    if (!compareReferenceLoaded && !lastComparisonData) {
      // 没有任何对比数据，显示提示
      showToast("请先执行拼图任务，对比将自动生成");
      return;
    }
    normalPreview.style.display = "none";
    comparePanel.style.display = "block";
    toggleCompareBtn.textContent = "🔍 退出对比模式";
    toggleCompareBtn.classList.add("active");
    if (!compareReferenceLoaded) {
      compareReferenceImg.src = "";
    }
    if (!compareGeneratedImg.src || compareGeneratedImg.src === window.location.href) {
      compareGeneratedImg.src = previewImage.src;
    }
    switchCompareTab("slider");
    updateCompareClip(comparePosition);
  } else {
    normalPreview.style.display = "block";
    comparePanel.style.display = "none";
    toggleCompareBtn.textContent = "🔍 开启对比模式";
    toggleCompareBtn.classList.remove("active");
  }
}

function handleCompareStart(e) {
  e.preventDefault();
  compareDragging = true;
  compareHandleGrip.style.transform = "translate(-50%, -50%) scale(1.08)";
  document.body.style.cursor = "ew-resize";
}

function handleCompareMove(e) {
  if (!compareDragging) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const rect = compareWrapper.getBoundingClientRect();
  const position = ((clientX - rect.left) / rect.width) * 100;
  updateCompareClip(position);
}

function handleCompareEnd() {
  if (!compareDragging) return;
  compareDragging = false;
  compareHandleGrip.style.transform = "translate(-50%, -50%)";
  document.body.style.cursor = "";
}

function attachCompareEvents() {
  compareHandleGrip.addEventListener("mousedown", handleCompareStart);
  compareHandleGrip.addEventListener("touchstart", handleCompareStart, { passive: false });
  document.addEventListener("mousemove", handleCompareMove);
  document.addEventListener("touchmove", handleCompareMove, { passive: false });
  document.addEventListener("mouseup", handleCompareEnd);
  document.addEventListener("touchend", handleCompareEnd);
  compareHandleBar.addEventListener("mousedown", handleCompareStart);
  compareHandleBar.addEventListener("touchstart", handleCompareStart, { passive: false });
}

// 事件绑定
toggleCompareBtn.addEventListener("click", () => setCompareMode(!compareMode));

compareTabs.querySelectorAll(".compare-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchCompareTab(tab.dataset.tab));
});

viewFullComparisonBtn.addEventListener("click", openCompareModal);
compareModalClose.addEventListener("click", closeCompareModal);
compareModal.addEventListener("click", (e) => {
  if (e.target === compareModal) closeCompareModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && compareModal.style.display !== "none") closeCompareModal();
});

compareUploadBtn.addEventListener("click", () => {
  const manual = compareManualUpload;
  manual.style.display = manual.style.display === "none" ? "flex" : "none";
});
referenceFileInput.addEventListener("change", () => {
  const file = referenceFileInput.files[0];
  if (file) loadReferenceFromFile(file);
});
loadReferenceUrlBtn.addEventListener("click", () => {
  loadReferenceFromUrl(referenceUrlInput.value);
});
referenceUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadReferenceFromUrl(referenceUrlInput.value);
});

// ---- 包装 runTask：任务完成后自动加载 NC 对比 ----
runTask = async function () {
  launchBtn.disabled = true;
  launchBtn.textContent = "生成中...";
  try {
    const payload = {
      dataset: currentDataset,
      target_time: targetTimeInput.value,
      time_tolerance_sec: 300,
      boundary_mode: "county",
      strategy: currentStrategy,
      product: currentProduct,
      level_index: Number(levelIndex.value || 0),
    };
    const res = await fetch(`${apiBase}/api/run-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "任务执行失败");
    previewImage.src = `${apiBase}${data.image_url}?t=${Date.now()}`;
    summaryTarget.textContent = `目标时次 ${data.target_time}`;
    recommendationText.textContent = `${recommendationText.textContent.split(" 已完成")[0]} 已完成一次真实拼图执行，参与站点: ${data.stations.join(", ")}。`;
    renderLogs(data.logs);
    showToast(`拼图已生成（产品：${data.product_label || currentProductLabel.textContent}，算法：${currentStrategy}）`);

    // 自动加载 NC 对比
    if (data.comparison) {
      populateComparisonFromBackend(data.comparison);
      showToast(`对比完成：RMSE=${data.comparison.stats?.rmse?.toFixed(2) || "--"}`);
    } else {
      compareStats.style.display = "none";
      viewFullComparisonBtn.style.display = "none";
      compareAutoBadge.textContent = "⚠ 未找到匹配NC";
      compareAutoBadge.style.background = "rgba(200, 150, 50, 0.12)";
      compareAutoBadge.style.color = "#b8860b";
      compareRefInfo.textContent = "可手动上传参考图对比";
    }
  } catch (error) {
    recommendationText.textContent = `任务执行失败: ${error.message}`;
    await refreshLogs();
    showToast(`执行失败：${error.message}`);
  } finally {
    launchBtn.disabled = false;
    launchBtn.textContent = "发起任务调度";
  }
};

launchBtn.addEventListener("click", runTask);

attachCompareEvents();
updateCompareClip(comparePosition);

renderRecommendation(strategies.max);
renderProductOptions(productCatalog);
renderProductLabel();
syncAlgorithmSelection(currentStrategy);
syncProductSelection(currentProduct);
loadDashboard("default", true).catch((error) => {
  setConnectionState(false, "后台连接失败，请先启动本地服务");
  recommendationText.textContent = `平台初始化失败: ${error.message}`;
});
