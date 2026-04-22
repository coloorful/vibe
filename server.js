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
        reject(new Error("Request body is too large. Please upload files in smaller batches."));
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
    throw new Error("Please enter a project name.");
  }

  return cleaned.toLowerCase();
}

function sanitizeRelativePath(inputPath) {
  const normalized = String(inputPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (!normalized || normalized.includes("..")) {
    throw new Error(`Illegal file path: ${inputPath}`);
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

      reject(new Error(stderr.trim() || stdout.trim() || `git exited with code ${code}`));
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
    logs.push(`Create local folder: ${repoPath}`);
    await runGit(["init", "-b", "main"], repoPath);
    await runGit(["config", "user.name", "Git Beginner Studio"], repoPath);
    await runGit(["config", "user.email", "git-beginner-studio@local.dev"], repoPath);
    logs.push("Local Git repository initialized");
  } else {
    logs.push("Repository already exists, skipped initialization");
  }

  if (remoteUrl) {
    await ensureRemote(repoPath, remoteUrl);
    logs.push(`Remote origin bound: ${remoteUrl}`);
  }

  await writeState({ activeRepo: repoName, remoteUrl });

  sendJson(res, 200, {
    ok: true,
    message: "Local repository is ready.",
    logs,
    summary: await getRepoSummary()
  });
}

async function handleUploadFiles(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "Please create a local project first."
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) {
    throw new Error("Please choose files before uploading.");
  }

  const logs = [];
  for (const file of files) {
    const relativePath = sanitizeRelativePath(file.path || file.name);
    const targetPath = path.join(repoPath, relativePath);

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, Buffer.from(String(file.contentBase64 || ""), "base64"));
    logs.push(`Write file: ${relativePath}`);
  }

  sendJson(res, 200, {
    ok: true,
    message: `Uploaded ${files.length} file(s) into the local project.`,
    logs,
    summary: await getRepoSummary()
  });
}

async function handleSaveVersion(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "Please create a local project first."
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const commitMessage = String(body.message || "").trim() || "Save a new local version";
  const logs = [];

  logs.push("Step 1/3: Check whether the project has new changes");
  const beforeStatus = await runGit(["status", "--short"], repoPath);
  if (!beforeStatus.stdout.trim()) {
    sendJson(res, 200, {
      ok: true,
      message: "No new changes found. Nothing to save right now.",
      logs,
      summary: await getRepoSummary()
    });
    return;
  }

  logs.push("Step 2/3: Collect all current changes");
  await runGit(["add", "."], repoPath);

  logs.push(`Step 3/3: Save one version record: ${commitMessage}`);
  await runGit(["commit", "-m", commitMessage], repoPath);

  sendJson(res, 200, {
    ok: true,
    message: "A new local Git version has been saved.",
    logs,
    summary: await getRepoSummary()
  });
}

async function handleSyncRemote(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "Please create a local project first."
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const state = await readState();
  const remoteUrl = String(body.remoteUrl || "").trim() || state.remoteUrl;
  const commitMessage = String(body.message || "").trim() || "Auto save before remote sync";
  const logs = [];

  if (!remoteUrl) {
    sendJson(res, 400, {
      ok: false,
      message: "Please fill in the remote repository address first."
    });
    return;
  }

  logs.push("Step 1/4: Check whether there are local changes");
  const beforeStatus = await runGit(["status", "--short"], repoPath);

  if (beforeStatus.stdout.trim()) {
    logs.push("Step 2/4: Collect all changes into this sync");
    await runGit(["add", "."], repoPath);
    logs.push(`Step 3/4: Save a local version before pushing: ${commitMessage}`);
    await runGit(["commit", "-m", commitMessage], repoPath);
  } else {
    logs.push("Step 2/4: No local changes, skip local save");
    logs.push("Step 3/4: Continue with remote sync");
  }

  await ensureRemote(repoPath, remoteUrl);
  await writeState({ ...state, remoteUrl });

  logs.push("Step 4/4: Push main branch to remote origin");
  await runGit(["push", "-u", "origin", "main"], repoPath);

  sendJson(res, 200, {
    ok: true,
    message: "Local project has been synchronized to the remote repository.",
    logs,
    summary: await getRepoSummary()
  });
}

async function handleCheckoutVersion(req, res) {
  const repoPath = await getActiveRepoPath();
  if (!repoPath) {
    sendJson(res, 400, {
      ok: false,
      message: "Please create a local project first."
    });
    return;
  }

  const body = JSON.parse((await readRequestBody(req)) || "{}");
  const ref = String(body.ref || "").trim();

  if (!ref) {
    throw new Error("Please choose a version to switch to.");
  }

  const dirty = await runGit(["status", "--short"], repoPath);
  if (dirty.stdout.trim()) {
    sendJson(res, 400, {
      ok: false,
      message: "You still have unsaved changes. Save them first, then switch versions."
    });
    return;
  }

  const logs = [];
  if (ref === "main") {
    await runGit(["switch", "main"], repoPath);
    logs.push("Switched back to the main line");
  } else {
    await runGit(["checkout", "--detach", ref], repoPath);
    logs.push(`Switched to historical version ${ref}`);
  }

  sendJson(res, 200, {
    ok: true,
    message: "Version switch complete.",
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
      message: error.message || "Server error."
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
