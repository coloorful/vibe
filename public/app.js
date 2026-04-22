const repoForm = document.getElementById("repo-form");
const uploadForm = document.getElementById("upload-form");
const saveForm = document.getElementById("save-form");
const fileInput = document.getElementById("file-input");
const fileList = document.getElementById("file-list");
const logOutput = document.getElementById("log-output");
const historyList = document.getElementById("history-list");
const statusSummary = document.getElementById("status-summary");
const syncButton = document.getElementById("sync-btn");
const backMainButton = document.getElementById("back-main-btn");
const remoteUrlInput = document.getElementById("remote-url");

let selectedFiles = [];

function setLogs(lines, message) {
  const merged = [];
  if (message) {
    merged.push(message);
  }
  if (Array.isArray(lines) && lines.length) {
    merged.push(...lines);
  }
  logOutput.textContent = merged.length ? merged.join("\n") : "等待操作...";
}

function renderHistory(history) {
  if (!history.length) {
    historyList.innerHTML = "<li>还没有可切换的版本记录</li>";
    return;
  }

  historyList.innerHTML = history
    .map(
      (item) => `
        <li>
          <button type="button" data-ref="${item.hash}">
            <strong>${item.subject}</strong>
            <small>${item.hash} · ${item.relativeTime || ""} ${item.decorations || ""}</small>
          </button>
        </li>
      `
    )
    .join("");
}

function renderStatus(summary) {
  if (!summary || !summary.repoReady) {
    statusSummary.innerHTML = `
      <strong>还没有本地项目</strong>
      <p>先填写项目名称并创建。</p>
    `;
    renderHistory([]);
    return;
  }

  if (summary.remoteUrl) {
    remoteUrlInput.value = summary.remoteUrl;
  }

  const changed = summary.changedFiles.length
    ? `<ul>${summary.changedFiles.map((item) => `<li>${item}</li>`).join("")}</ul>`
    : "<p>当前没有待保存变化</p>";

  statusSummary.innerHTML = `
    <strong>项目：${summary.activeRepo}</strong>
    <p>当前位置：${summary.detached ? `历史版本 ${summary.head}` : `主线 ${summary.branch}`}</p>
    <p>远程仓库：${summary.remoteUrl || "暂未绑定"}</p>
    <p>待保存变化：</p>
    ${changed}
  `;

  renderHistory(summary.history || []);
}

async function callApi(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  return response.json();
}

async function refreshStatus() {
  const result = await callApi("/api/status");
  renderStatus(result.summary);
}

function collectFiles(fileCollection) {
  return Array.from(fileCollection || []).map((file) => ({
    file,
    displayPath: file.webkitRelativePath || file.name
  }));
}

async function encodeFile(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function performAction(url, payload) {
  const result = await callApi(url, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  setLogs(result.logs, result.message);
  renderStatus(result.summary);
}

fileInput.addEventListener("change", () => {
  selectedFiles = collectFiles(fileInput.files);

  if (!selectedFiles.length) {
    fileList.innerHTML = "";
    return;
  }

  fileList.innerHTML = selectedFiles
    .slice(0, 12)
    .map((item) => `<li>${item.displayPath}</li>`)
    .join("");

  if (selectedFiles.length > 12) {
    fileList.insertAdjacentHTML(
      "beforeend",
      `<li>另外还有 ${selectedFiles.length - 12} 个文件</li>`
    );
  }
});

repoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await performAction("/api/init-repo", {
    repoName: document.getElementById("repo-name").value.trim(),
    remoteUrl: remoteUrlInput.value.trim()
  });
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFiles.length) {
    setLogs([], "请先选择文件或文件夹。");
    return;
  }

  setLogs([], "正在读取文件并写入本地项目，请稍候...");
  const files = [];

  for (const item of selectedFiles) {
    files.push({
      path: item.displayPath,
      contentBase64: await encodeFile(item.file)
    });
  }

  await performAction("/api/upload-files", { files });
});

saveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await performAction("/api/save-version", {
    message: document.getElementById("commit-message").value.trim()
  });
});

syncButton.addEventListener("click", async () => {
  await performAction("/api/sync-remote", {
    message: document.getElementById("commit-message").value.trim(),
    remoteUrl: remoteUrlInput.value.trim()
  });
});

backMainButton.addEventListener("click", async () => {
  await performAction("/api/checkout-version", { ref: "main" });
});

historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-ref]");
  if (!button) {
    return;
  }

  await performAction("/api/checkout-version", {
    ref: button.dataset.ref
  });
});

refreshStatus().catch((error) => {
  setLogs([], error.message);
});
