const PDF_WORKER_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const JSZip = window.JSZip;
const pdfjsLib = window.pdfjsLib;

if (!JSZip || !pdfjsLib) {
  const summary = document.querySelector("#summary");
  if (summary) {
    summary.innerHTML = "<span>依赖加载失败，请检查网络或稍后重试。</span>";
  }
  throw new Error("依赖加载失败：请检查 JSZip / pdf.js CDN 是否可访问");
}

pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_CDN;

const state = {
  tasks: [],
  running: false,
  scale: 2,
  quality: 0.92,
  downloadingAll: false,
};

const dom = {
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  convertBtn: document.querySelector("#convertBtn"),
  downloadAllBtn: document.querySelector("#downloadAllBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  taskList: document.querySelector("#taskList"),
  summary: document.querySelector("#summary"),
  scaleSelect: document.querySelector("#scaleSelect"),
  qualityRange: document.querySelector("#qualityRange"),
  qualityValue: document.querySelector("#qualityValue"),
};

init();

function init() {
  bindUploadEvents();
  bindControls();
  render();
}

function bindUploadEvents() {
  dom.dropzone.addEventListener("click", (event) => {
    if (event.target === dom.fileInput) {
      return;
    }
    dom.fileInput.click();
  });

  dom.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      dom.fileInput.click();
    }
  });

  dom.fileInput.addEventListener("change", () => {
    addFiles(dom.fileInput.files);
    dom.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dom.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dom.dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dom.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dom.dropzone.classList.remove("dragover");
    });
  });

  dom.dropzone.addEventListener("drop", (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) {
      addFiles(files);
    }
  });
}

function bindControls() {
  dom.scaleSelect.addEventListener("change", () => {
    state.scale = Number(dom.scaleSelect.value);
  });

  dom.qualityRange.addEventListener("input", () => {
    const raw = Number(dom.qualityRange.value);
    state.quality = raw / 100;
    dom.qualityValue.textContent = `${raw}%`;
  });

  dom.convertBtn.addEventListener("click", async () => {
    await convertAll();
  });

  dom.downloadAllBtn.addEventListener("click", async () => {
    await downloadAllAsZip();
  });

  dom.clearBtn.addEventListener("click", () => {
    clearAllTasks();
  });

  dom.taskList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const taskId = button.dataset.taskId;
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    if (button.dataset.action === "download-file") {
      await downloadSingleTask(task);
      return;
    }

    if (button.dataset.action === "download-page") {
      const imageIndex = Number(button.dataset.imageIndex);
      downloadSinglePage(task, imageIndex);
    }
  });
}

function addFiles(fileList) {
  const incoming = Array.from(fileList).filter(
    (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name),
  );
  if (!incoming.length) {
    return;
  }

  const signatures = new Set(state.tasks.map(buildFileSignature));
  const newTasks = [];

  for (const file of incoming) {
    const signature = `${file.name}-${file.size}-${file.lastModified}`;
    if (signatures.has(signature)) {
      continue;
    }
    signatures.add(signature);
    newTasks.push({
      id: buildTaskId(),
      file,
      status: "pending",
      progress: 0,
      totalPages: 0,
      processedPages: 0,
      images: [],
      error: "",
      zipping: false,
    });
  }

  if (!newTasks.length) {
    return;
  }

  state.tasks.push(...newTasks);
  render();
}

async function convertAll() {
  if (state.running) {
    return;
  }

  const queue = state.tasks.filter((task) => task.status === "pending" || task.status === "error");
  if (!queue.length) {
    return;
  }

  state.running = true;
  render();

  for (const task of queue) {
    await convertTask(task);
    render();
  }

  state.running = false;
  render();
}

async function convertTask(task) {
  task.status = "processing";
  task.error = "";
  task.progress = 0;
  task.totalPages = 0;
  task.processedPages = 0;
  releaseTaskImages(task);
  task.images = [];
  render();

  try {
    const bytes = await task.file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/",
    });
    const pdf = await loadingTask.promise;

    task.totalPages = pdf.numPages;
    render();

    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: state.scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error("无法创建 canvas 上下文");
      }

      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await canvasToBlob(canvas, "image/jpeg", state.quality);
      if (!blob) {
        throw new Error("页面导出 JPG 失败");
      }

      const baseName = createBaseName(task.file.name);
      const imageName = `${baseName}_p${String(pageNo).padStart(3, "0")}.jpg`;
      task.images.push({
        name: imageName,
        pageNo,
        blob,
        url: URL.createObjectURL(blob),
        width: canvas.width,
        height: canvas.height,
      });

      task.processedPages = pageNo;
      task.progress = Math.round((pageNo / pdf.numPages) * 100);
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
      render();
      await nextFrame();
    }

    await pdf.cleanup();
    await pdf.destroy();
    task.status = "done";
    task.progress = 100;
  } catch (error) {
    task.status = "error";
    task.error = error instanceof Error ? error.message : String(error);
  }
}

async function downloadSingleTask(task) {
  if (task.zipping || task.status !== "done" || !task.images.length) {
    return;
  }

  task.zipping = true;
  render();

  try {
    const zip = new JSZip();
    for (const image of task.images) {
      zip.file(image.name, image.blob);
    }
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    triggerDownload(blob, `${createBaseName(task.file.name)}.zip`);
  } finally {
    task.zipping = false;
    render();
  }
}

function downloadSinglePage(task, imageIndex) {
  const image = task.images[imageIndex];
  if (!image) {
    return;
  }
  triggerDownload(image.blob, image.name);
}

async function downloadAllAsZip() {
  if (state.downloadingAll) {
    return;
  }

  const doneTasks = state.tasks.filter((task) => task.status === "done" && task.images.length > 0);
  if (!doneTasks.length) {
    return;
  }

  state.downloadingAll = true;
  render();

  try {
    const zip = new JSZip();
    const folderNames = new Map();

    for (const task of doneTasks) {
      const base = createBaseName(task.file.name);
      const index = (folderNames.get(base) || 0) + 1;
      folderNames.set(base, index);
      const folderName = index > 1 ? `${base}_${index}` : base;
      const folder = zip.folder(folderName);
      if (!folder) {
        continue;
      }
      for (const image of task.images) {
        folder.file(image.name, image.blob);
      }
    }

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    triggerDownload(blob, `pdf-images-${stamp}.zip`);
  } finally {
    state.downloadingAll = false;
    render();
  }
}

function clearAllTasks() {
  for (const task of state.tasks) {
    releaseTaskImages(task);
  }
  state.tasks = [];
  render();
}

function releaseTaskImages(task) {
  for (const image of task.images) {
    URL.revokeObjectURL(image.url);
  }
}

function render() {
  renderSummary();
  renderTaskList();
  renderButtons();
}

function renderSummary() {
  if (!state.tasks.length) {
    dom.summary.innerHTML = "<span>未添加任务</span>";
    return;
  }

  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.status === "done").length;
  const running = state.tasks.filter((task) => task.status === "processing").length;
  const failed = state.tasks.filter((task) => task.status === "error").length;
  const pending = state.tasks.filter((task) => task.status === "pending").length;

  dom.summary.innerHTML = `
    <span>总任务: <strong>${total}</strong></span>
    <span>待转换: <strong>${pending}</strong></span>
    <span>转换中: <strong>${running}</strong></span>
    <span>完成: <strong>${done}</strong></span>
    <span>失败: <strong>${failed}</strong></span>
  `;
}

function renderTaskList() {
  if (!state.tasks.length) {
    dom.taskList.innerHTML = "";
    return;
  }

  dom.taskList.innerHTML = state.tasks
    .map((task) => {
      const preview = task.images
        .slice(0, 4)
        .map(
          (image, index) => `
            <figure class="preview-item">
              <img src="${image.url}" alt="第 ${image.pageNo} 页预览" loading="lazy" />
              <figcaption>
                <span>第 ${image.pageNo} 页</span>
                <button
                  type="button"
                  class="btn-mini"
                  data-action="download-page"
                  data-task-id="${task.id}"
                  data-image-index="${index}"
                >
                  下载本页
                </button>
              </figcaption>
            </figure>
          `,
        )
        .join("");

      const moreCount = task.images.length > 4 ? task.images.length - 4 : 0;
      const statusLabel = getStatusLabel(task.status);
      const safeName = escapeHtml(task.file.name);

      return `
        <article class="task-card">
          <div class="task-top">
            <div>
              <h3 title="${safeName}">${safeName}</h3>
              <p>${formatBytes(task.file.size)} · ${task.totalPages || "-"} 页</p>
            </div>
            <span class="status status-${task.status}">${statusLabel}</span>
          </div>

          <div class="progress-wrap" aria-label="progress">
            <div class="progress-track">
              <span style="width: ${task.progress}%"></span>
            </div>
            <span class="progress-text">${task.progress}% (${task.processedPages}/${task.totalPages || 0})</span>
          </div>

          ${
            task.error
              ? `<p class="error-text">转换失败: ${escapeHtml(task.error)}</p>`
              : ""
          }

          <div class="task-actions">
            <button
              type="button"
              class="btn-secondary"
              data-action="download-file"
              data-task-id="${task.id}"
              ${task.status !== "done" || !task.images.length || task.zipping ? "disabled" : ""}
            >
              ${task.zipping ? "打包中..." : "下载该 PDF"}
            </button>
          </div>

          ${
            preview
              ? `<div class="preview-grid">${preview}</div>${
                  moreCount ? `<p class="more-pages">另有 ${moreCount} 页可在打包内下载</p>` : ""
                }`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function renderButtons() {
  const hasTasks = state.tasks.length > 0;
  const hasPending = state.tasks.some((task) => task.status === "pending" || task.status === "error");
  const hasDone = state.tasks.some((task) => task.status === "done" && task.images.length > 0);

  dom.convertBtn.disabled = state.running || !hasPending;
  dom.convertBtn.textContent = state.running ? "转换中..." : "开始转换";

  dom.downloadAllBtn.disabled = state.running || !hasDone || state.downloadingAll;
  dom.downloadAllBtn.textContent = state.downloadingAll ? "打包中..." : "打包下载全部";

  dom.clearBtn.disabled = state.running || !hasTasks;
}

function triggerDownload(blob, fileName) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function buildTaskId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildFileSignature(task) {
  return `${task.file.name}-${task.file.size}-${task.file.lastModified}`;
}

function createBaseName(name) {
  const noExt = name.replace(/\.[^.]+$/, "");
  return noExt
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function getStatusLabel(status) {
  if (status === "pending") {
    return "待转换";
  }
  if (status === "processing") {
    return "转换中";
  }
  if (status === "done") {
    return "已完成";
  }
  if (status === "error") {
    return "失败";
  }
  return status;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
