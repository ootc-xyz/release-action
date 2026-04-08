"use strict";

const fs = require("node:fs");
const path = require("node:path");

function getInput(name, options = {}) {
  const canonicalKey = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const legacyCompatKey = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  const value = process.env[canonicalKey] ?? process.env[legacyCompatKey] ?? "";
  if (options.required && value.trim() === "") {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value.trim();
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`, "utf8");
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function normalizeBoolean(value, name) {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be a boolean-like value, got: ${value}`);
}

function parseAliases(aliasName, aliasesInput) {
  const items = [];

  if (aliasName) {
    items.push(aliasName);
  }

  if (aliasesInput) {
    items.push(...aliasesInput.split(/[\n,]/));
  }

  const normalized = [];
  const seen = new Set();

  for (const item of items) {
    const alias = item.trim();
    if (!alias || seen.has(alias)) {
      continue;
    }
    seen.add(alias);
    normalized.push(alias);
  }

  return normalized;
}

function parseTargetName(targetName) {
  const segments = targetName.split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error(`target-name must be in scope/project form, got: ${targetName}`);
  }
  return {
    softwareScope: segments[0],
    softwareProject: segments[1],
  };
}

function ensureBasename(fileName) {
  if (path.basename(fileName) !== fileName) {
    throw new Error(`file-name must be a basename, got: ${fileName}`);
  }
}

function joinUrl(baseUrl, relativePath) {
  return new URL(relativePath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed: ${options.method || "GET"} ${url} -> ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
  }

  if (text === "") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response from ${url}, got: ${text}`);
  }
}

async function requestNoBody(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed: ${options.method || "GET"} ${url} -> ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
  }
}

async function verifyDownloadUrl(url) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    return;
  }

  if (response.ok) {
    return;
  }

  const text = await response.text();
  throw new Error(`Download verification failed: ${url} -> ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
}

async function main() {
  const releaseServerUrl = getInput("release-server-url", { required: true });
  const apiKey = getInput("api-key", { required: true });
  const targetName = getInput("target-name", { required: true });
  const releaseId = getInput("release-id", { required: true });
  const filePath = getInput("file-path", { required: true });
  const inputFileName = getInput("file-name");
  const contentType = getInput("content-type") || "application/octet-stream";
  const aliasName = getInput("alias");
  const aliasesInput = getInput("aliases");
  const verify = normalizeBoolean(getInput("verify") || "true", "verify");

  const { softwareScope, softwareProject } = parseTargetName(targetName);

  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const fileName = inputFileName || path.basename(filePath);
  ensureBasename(fileName);
  const aliases = parseAliases(aliasName, aliasesInput);

  const uploadSessionUrl = joinUrl(
    releaseServerUrl,
    `/api/v1/software/${encodeURIComponent(softwareScope)}/${encodeURIComponent(softwareProject)}/releases/${encodeURIComponent(releaseId)}/files`,
  );

  const uploadResponse = await requestJson(uploadSessionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: fileName,
      content_type: contentType,
    }),
  });

  if (!uploadResponse || typeof uploadResponse.uploadUrl !== "string" || typeof uploadResponse.downloadUrl !== "string") {
    throw new Error("Release server response is missing uploadUrl or downloadUrl");
  }

  const uploadUrl = uploadResponse.uploadUrl;
  const uploadHeaders = {};
  for (const [key, value] of Object.entries(uploadResponse.requiredHeaders || {})) {
    if (value != null && value !== "") {
      uploadHeaders[key] = String(value);
    }
  }

  info(`Presigned upload created for ${targetName}@${releaseId}/${fileName}`);

  const uploadResult = await fetch(uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: fs.readFileSync(filePath),
  });

  if (!uploadResult.ok) {
    const text = await uploadResult.text();
    throw new Error(`Upload failed: PUT ${uploadUrl} -> ${uploadResult.status} ${uploadResult.statusText}${text ? `\n${text}` : ""}`);
  }

  info("Upload completed");

  const releaseDownloadUrl = joinUrl(releaseServerUrl, uploadResponse.downloadUrl);
  const aliasDownloadUrls = [];

  for (const alias of aliases) {
    const aliasUrl = joinUrl(
      releaseServerUrl,
      `/api/v1/software/${encodeURIComponent(softwareScope)}/${encodeURIComponent(softwareProject)}/aliases/${encodeURIComponent(alias)}`,
    );

    await requestJson(aliasUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ release_id: releaseId }),
    });

    aliasDownloadUrls.push(joinUrl(
      releaseServerUrl,
      `/download/${encodeURIComponent(softwareScope)}/${encodeURIComponent(softwareProject)}/${encodeURIComponent(alias)}/${encodeURIComponent(fileName)}`,
    ));

    info(`Alias updated: ${alias}`);
  }

  if (verify) {
    const releaseMetadataUrl = joinUrl(
      releaseServerUrl,
      `/api/v1/software/${encodeURIComponent(softwareScope)}/${encodeURIComponent(softwareProject)}/${encodeURIComponent(releaseId)}`,
    );
    await requestNoBody(releaseMetadataUrl);
    await verifyDownloadUrl(releaseDownloadUrl);

    for (let i = 0; i < aliases.length; i += 1) {
      const alias = aliases[i];
      const aliasMetadataUrl = joinUrl(
        releaseServerUrl,
        `/api/v1/software/${encodeURIComponent(softwareScope)}/${encodeURIComponent(softwareProject)}/${encodeURIComponent(alias)}`,
      );
      await requestNoBody(aliasMetadataUrl);
      await verifyDownloadUrl(aliasDownloadUrls[i]);
    }

    info("Verification completed");
  }

  setOutput("download-url", releaseDownloadUrl);
  setOutput("release-download-url", releaseDownloadUrl);
  setOutput("alias-download-url", aliasDownloadUrls[0] || "");
  setOutput("alias-download-urls", aliasDownloadUrls.join("\n"));
  setOutput("upload-url", uploadUrl);
  setOutput("file-name", fileName);

  info(`Release URL: ${releaseDownloadUrl}`);
  for (const aliasDownloadUrl of aliasDownloadUrls) {
    info(`Alias URL: ${aliasDownloadUrl}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
