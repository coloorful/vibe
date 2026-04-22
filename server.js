const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const host = "127.0.0.1";
const port = 3000;
const appRoot = __dirname;
const publicRoot = path.join(appRoot, "public");
const workspaceRoot = path.join(appRoot, "workspace");
const reposRoot = path.join(workspaceRoot, "repos");
const stateFile = path.join(workspaceRoot, "state.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function ensureAppFolders() {
  await fsp.mkdir(publicRoot, { recursive: true });
  await fsp.mkdir(reposRoot, { recursive: true });

  try {
    await fsp.access(stateFile);
  } catch {
    await writeState({ activeRepo: null, remoteUrl: "" });
  }
}

async function readState() {
  const raw = await fsp.readFile(stateFile, "utf8");
  return JSON.parse(raw);
}

async function writeState(state) {
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(payload);
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) {
        reject(new Error("上传内容过大，请分批上传文件。"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function safeRepoName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!cleaned) {
    throw new Error("请填写项目名称。");
  }

  return cleaned.toLowerCase();
}

function sanitizeRelativePath(inputPath) {
  const normalized = String(inputPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (!normalized || normalized.includes("..")) {
    throw new Error(`文件路径不合法: ${inputPath}`);
  }

  return normalized;
}

function exists(targetPath) {
  return fsp
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code
        });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `git 退出码 ${code}`));
    });
  });
}

async function getActiveRepoPath() {
  const state = await readState();
  if (!state.activeRepo) {
    return null;
  }

  const repoPath = path.join(reposRoot, state.activeRepo);
  if (!(await exists(repoPath))) {
    await writeState({ ...state, activeRepo: null });
    return null;
  }

  return repoPath;
}

async function ensureRemote(repoPath, remoteUrl) {
  try {
    await runGit(["remote", "add", "origin", remoteUrl], repoPath);
  } catch {
    await runGit(["remote", "set-url", "origin", remoteUrl], repoPath);
  }
}

function parseHistory(stdout) {
  if (!stdout) {
    return [];
  }

  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, subject, relativeTime, decorations] = line.split("|");
    return {
      hash,
      subject,
      relativeTime,
      decorations
    };
  });
}

async function getRepoSummary() {
  const repoPath = await getActiveRepoPath();
  const state = await readState();

  if (!repoPath) {
    return {
      activeRepo: null,
      repoReady: false,
      branch: null,
      head: "",
      detached: false,
      remoteUrl: state.remoteUrl || "",
      changedFiles: [],
      history: []
    };
  }

  const activeRepo = path.basename(repoPath);
  const branchResult = await runGit(["branch", "--show-current"], repoPath);
  const headResult = await runGit(["rev-parse", "--short", "HEAD"], repoPath).catch(
    () => ({ stdout: "" })
  );
  const statusResult = await runGit(["status", "--short"], repoPath);
  const remoteResult = await runGit(["remote", "get-url", "origin"], repoPath).catch(
    () => ({ stdout: state.remoteUrl || "" })
  );
  const historyResult = await runGit(
    ["log", "--pretty=format:%h|%s|%cr|%d", "-12"],
    repoPath
  ).catch(() => ({ stdout: "" }));

  return {
    activeRepo,
    repoReady: true,
    branch: branchResult.stdout || "HEAD",
    head: headResult.stdout || "",
    detached: !branchResult.stdout,
    remoteUrl: remoteResult.stdout || "",
    changedFiles: statusResult.stdout
      ? statusResult.stdout.split(/\r?\n/).filter(Boolean)
      : [],
    history: parseHistory(historyResult.stdout)
  };
}

async function handleInitRepo(req, res) {
  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const repoName = safeRepoName(body.repoName);
  const remoteUrl = String(body.remoteUrl || "").trim();
  const repoPath = path.join(reposRoot, repoName);
  const gitPath = path.join(repoPath, ".git");
  const logs = [];

  await fsp.mkdir(repoPath, { recursive: true });

  if (!(await exists(gitPath))) {
    logs.push(`创建本地项目目录: ${repoPath}`);
    await runGit(["init", "-b", "main"], repoPath);
    await runGit(["config", "user.name", "Git Beginner Studio"], repoPath);
    await runGit(["config", "user.email", "git-beginner-studio@local.dev"], repoPath);
    logs.push("本地 Git 仓库初始化完成");
  } else {
    logs.push("仓库已存在，跳过初始化");
  }

  if (remoteUrl) {
    await ensureRemote(repoPath, remoteUrl);
    logs.push(`已绑定远程仓库: ${remoteUrl}`);
  }

  await writeState({ activeRepo: repoName, remoteUrl });

  sendJson(res, 200, {
    ok: true,
    message: "本地仓库已准备完成。",
    logs,
    summary: await getRepoSummary()
  });
}

async function handleUploadFiles(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "请先创建一个本地项目。"
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) {
    throw new Error("请先选择要上传的文件。");
  }

  const logs = [];
  for (const file of files) {
    const relativePath = sanitizeRelativePath(file.path || file.name);
    const targetPath = path.join(repoPath, relativePath);

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, Buffer.from(String(file.contentBase64 || ""), "base64"));
    logs.push(`写入文件: ${relativePath}`);
  }

  sendJson(res, 200, {
    ok: true,
    message: `已写入 ${files.length} 个文件到本地项目。`,
    logs,
    summary: await getRepoSummary()
  });
}

async function handleSaveVersion(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "请先创建一个本地项目。"
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const commitMessage = String(body.message || "").trim() || "保存一次本地版本";
  const logs = [];

  logs.push("步骤 1/3: 检查当前项目是否有新变化");
  const beforeStatus = await runGit(["status", "--short"], repoPath);
  if (!beforeStatus.stdout.trim()) {
    sendJson(res, 200, {
      ok: true,
      message: "当前没有新变化，不需要保存新版本。",
      logs,
      summary: await getRepoSummary()
    });
    return;
  }

  logs.push("步骤 2/3: 收集当前全部变化");
  await runGit(["add", "."], repoPath);

  logs.push(`步骤 3/3: 生成版本记录: ${commitMessage}`);
  await runGit(["commit", "-m", commitMessage], repoPath);

  sendJson(res, 200, {
    ok: true,
    message: "新的本地版本已保存。",
    logs,
    summary: await getRepoSummary()
  });
}

async function handleSyncRemote(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "请先创建一个本地项目。"
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const state = await readState();
  const remoteUrl = String(body.remoteUrl || "").trim() || state.remoteUrl;
  const commitMessage = String(body.message || "").trim() || "远程同步前自动保存版本";
  const logs = [];

  if (!remoteUrl) {
    sendJson(res, 400, {
      ok: false,
      message: "请先填写远程仓库地址。"
    });
    return;
  }

  logs.push("步骤 1/4: 检查本地是否存在未保存变化");
  const beforeStatus = await runGit(["status", "--short"], repoPath);

  if (beforeStatus.stdout.trim()) {
    logs.push("步骤 2/4: 自动收集全部变化");
    await runGit(["add", "."], repoPath);
    logs.push(`步骤 3/4: 推送前自动保存版本: ${commitMessage}`);
    await runGit(["commit", "-m", commitMessage], repoPath);
  } else {
    logs.push("步骤 2/4: 当前没有新变化，跳过本地保存");
    logs.push("步骤 3/4: 直接继续远程同步");
  }

  await ensureRemote(repoPath, remoteUrl);
  await writeState({ ...state, remoteUrl });

  logs.push("步骤 4/4: 推送主线版本到远程仓库 origin/main");
  await runGit(["push", "-u", "origin", "main"], repoPath);

  sendJson(res, 200, {
    ok: true,
    message: "本地项目已同步到远程仓库。",
    logs,
    summary: await getRepoSummary()
  });
}

async function handleCheckoutVersion(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "请先创建一个本地项目。"
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const ref = String(body.ref || "").trim();

  if (!ref) {
    throw new Error("请选择一个要切换的版本。");
  }

  const dirty = await runGit(["status", "--short"], repoPath);
  if (dirty.stdout.trim()) {
    sendJson(res, 400, {
      ok: false,
      message: "当前还有未保存变化，请先保存，再切换版本。"
    });
    return;
  }

  const logs = [];
  if (ref === "main") {
    await runGit(["switch", "main"], repoPath);
    logs.push("已回到主线版本");
  } else {
    await runGit(["checkout", "--detach", ref], repoPath);
    logs.push(`已切换到历史版本 ${ref}`);
  }

  sendJson(res, 200, {
    ok: true,
    message: "版本切换完成。",
    logs,
    summary: await getRepoSummary()
  });
}

async function handleRepoHistory(req, res) {
  sendJson(res, 200, {
    ok: true,
    summary: await getRepoSummary()
  });
}

async function handleStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicRoot, safePath);

  if (!filePath.startsWith(publicRoot)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream"
    });
    res.end(content);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

async function route(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/status") {
      sendJson(res, 200, { ok: true, summary: await getRepoSummary() });
      return;
    }

    if (req.method === "POST" && req.url === "/api/init-repo") {
      await handleInitRepo(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/upload-files") {
      await handleUploadFiles(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/save-version") {
      await handleSaveVersion(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/sync-remote") {
      await handleSyncRemote(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/checkout-version") {
      await handleCheckoutVersion(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/api/history") {
      await handleRepoHistory(req, res);
      return;
    }

    await handleStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error.message || "服务异常。"
    });
  }
}

ensureAppFolders()
  .then(() => {
    const server = http.createServer(route);
    server.listen(port, host, () => {
      console.log(`Git Beginner Studio running at http://${host}:${port}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
