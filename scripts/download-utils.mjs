const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchJson(url, {
  label = "请求",
  headers,
  timeoutMs = 30000,
  retries = 3,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        throw new Error(`${label}失败：HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      console.warn(
        `${label}失败（${attempt}/${retries}）：${errorMessage(error)}；${attempt * 2} 秒后重试`,
      );
      await pause(attempt * 2000);
    }
  }
  throw new Error(`${label}失败，已重试 ${retries} 次：${errorMessage(lastError)}`);
}

export async function downloadBuffer(url, {
  label = "文件",
  headers,
  expectedSize = 0,
  timeoutMs = 180000,
  retries = 3,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}`);

      const headerSize = Number(response.headers.get("content-length"));
      const total = Number.isFinite(headerSize) && headerSize > 0
        ? headerSize
        : expectedSize;
      if (!response.body) {
        const bytes = Buffer.from(await response.arrayBuffer());
        console.log(`${label}：${formatBytes(bytes.length)} 下载完成`);
        return bytes;
      }

      const reader = response.body.getReader();
      const chunks = [];
      let downloaded = 0;
      let lastReportAt = Date.now();
      let lastReportBytes = 0;
      let lastPercent = -1;
      console.log(`开始下载 ${label}${total ? `（${formatBytes(total)}）` : ""}`);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        downloaded += chunk.length;

        const now = Date.now();
        const percent = total ? Math.min(100, Math.floor(downloaded / total * 100)) : -1;
        const shouldReport = process.stdout.isTTY
          ? now - lastReportAt >= 500
          : percent >= 0
            ? percent >= lastPercent + 5
            : now - lastReportAt >= 2000;
        if (shouldReport) {
          const elapsed = Math.max(1, now - lastReportAt) / 1000;
          const speed = (downloaded - lastReportBytes) / elapsed;
          const progress = total
            ? `${Math.min(100, downloaded / total * 100).toFixed(1)}%`
            : formatBytes(downloaded);
          const line = `  ${progress} · ${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ""} · ${formatBytes(speed)}/s`;
          if (process.stdout.isTTY) process.stdout.write(`\r${line}`);
          else console.log(line);
          lastReportAt = now;
          lastReportBytes = downloaded;
          if (percent >= 0) lastPercent = percent;
        }
      }
      if (process.stdout.isTTY) process.stdout.write("\r");
      const bytes = Buffer.concat(chunks);
      console.log(`${label} 下载完成：${formatBytes(bytes.length)}`);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      console.warn(
        `${label}下载失败（${attempt}/${retries}）：${errorMessage(error)}；${attempt * 2} 秒后重新下载`,
      );
      await pause(attempt * 2000);
    }
  }
  throw new Error(`${label}下载失败，已重试 ${retries} 次：${errorMessage(lastError)}`);
}
