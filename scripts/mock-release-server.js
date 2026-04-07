"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const host = process.env.MOCK_RELEASE_SERVER_HOST || "127.0.0.1";
const port = Number(process.env.MOCK_RELEASE_SERVER_PORT || "5000");
const apiKey = process.env.MOCK_RELEASE_SERVER_API_KEY || "test-master-key";
const storeRoot = path.join(process.cwd(), ".tmp", "mock-release-server");

const uploads = new Map();
const releases = new Map();
const aliases = new Map();

function json(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  response.end(body);
}

function text(response, statusCode, body, contentType = "application/octet-stream") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function releaseKey(scope, project, releaseId) {
  return `${scope}/${project}/${releaseId}`;
}

function aliasKey(scope, project, aliasName) {
  return `${scope}/${project}/${aliasName}`;
}

function filePathFor(scope, project, releaseId, fileName) {
  return path.join(storeRoot, "files", scope, project, releaseId, fileName);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function requireAuth(request, response) {
  if (request.headers.authorization !== `Bearer ${apiKey}`) {
    json(response, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function parseRoute(requestUrl) {
  return new URL(requestUrl, `http://${host}:${port}`);
}

async function handle(request, response) {
  const requestUrl = parseRoute(request.url || "/");
  const pathname = requestUrl.pathname;
  const parts = pathname.split("/").filter(Boolean);

  if (request.method === "GET" && pathname === "/healthz") {
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && parts.length === 6 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "software") {
    const scope = parts[3];
    const project = parts[4];
    const releaseOrAlias = parts[5];
    const releaseId = aliases.get(aliasKey(scope, project, releaseOrAlias)) || releaseOrAlias;
    const release = releases.get(releaseKey(scope, project, releaseId));
    if (!release) {
      json(response, 404, { error: "not_found" });
      return;
    }
    json(response, 200, release);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && parts.length === 5 && parts[0] === "download") {
    const scope = parts[1];
    const project = parts[2];
    const releaseOrAlias = parts[3];
    const fileName = parts[4];
    const releaseId = aliases.get(aliasKey(scope, project, releaseOrAlias)) || releaseOrAlias;
    const filePath = filePathFor(scope, project, releaseId, fileName);

    if (!fs.existsSync(filePath)) {
      if (request.method === "HEAD") {
        response.writeHead(404);
        response.end();
      } else {
        json(response, 404, { error: "not_found" });
      }
      return;
    }

    response.writeHead(302, {
      Location: `http://${host}:${port}/signed-download/${encodeURIComponent(scope)}/${encodeURIComponent(project)}/${encodeURIComponent(releaseId)}/${encodeURIComponent(fileName)}`,
    });
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && parts.length === 5 && parts[0] === "signed-download") {
    const scope = decodeURIComponent(parts[1]);
    const project = decodeURIComponent(parts[2]);
    const releaseId = decodeURIComponent(parts[3]);
    const fileName = decodeURIComponent(parts[4]);
    const filePath = filePathFor(scope, project, releaseId, fileName);

    if (!fs.existsSync(filePath)) {
      if (request.method === "HEAD") {
        response.writeHead(404);
        response.end();
      } else {
        json(response, 404, { error: "not_found" });
      }
      return;
    }

    if (request.method === "HEAD") {
      json(response, 403, { error: "method_mismatch" });
      return;
    }

    const body = fs.readFileSync(filePath);
    text(response, 200, body);
    return;
  }

  if (request.method === "POST" && parts.length === 8 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "software" && parts[5] === "releases" && parts[7] === "files") {
    if (!requireAuth(request, response)) {
      return;
    }

    const scope = parts[3];
    const project = parts[4];
    const releaseId = parts[6];
    const payload = JSON.parse((await readBody(request)).toString("utf8") || "{}");
    const fileName = payload.filename;
    const contentType = payload.content_type || "application/octet-stream";
    const uploadId = `${scope}-${project}-${releaseId}-${fileName}`;

    uploads.set(uploadId, {
      scope,
      project,
      releaseId,
      fileName,
      contentType,
    });

    const key = releaseKey(scope, project, releaseId);
    if (!releases.has(key)) {
      releases.set(key, {
        scope,
        project,
        release_id: releaseId,
        files: [],
      });
    }

    json(response, 200, {
      uploadMethod: "PUT",
      uploadUrl: `http://${host}:${port}/storage/${encodeURIComponent(uploadId)}`,
      requiredHeaders: {
        "Content-Type": contentType,
      },
      downloadUrl: `/download/${encodeURIComponent(scope)}/${encodeURIComponent(project)}/${encodeURIComponent(releaseId)}/${encodeURIComponent(fileName)}`,
      s3Bucket: "mock-bucket",
      s3Key: `${scope}/${project}/${releaseId}/${fileName}`,
    });
    return;
  }

  if (request.method === "PUT" && parts.length === 2 && parts[0] === "storage") {
    const uploadId = decodeURIComponent(parts[1]);
    const upload = uploads.get(uploadId);
    if (!upload) {
      json(response, 404, { error: "not_found" });
      return;
    }

    const body = await readBody(request);
    const filePath = filePathFor(upload.scope, upload.project, upload.releaseId, upload.fileName);
    ensureParent(filePath);
    fs.writeFileSync(filePath, body);

    const release = releases.get(releaseKey(upload.scope, upload.project, upload.releaseId));
    if (!release.files.includes(upload.fileName)) {
      release.files.push(upload.fileName);
    }

    response.writeHead(200);
    response.end();
    return;
  }

  if (request.method === "PUT" && parts.length === 7 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "software" && parts[5] === "aliases") {
    if (!requireAuth(request, response)) {
      return;
    }

    const scope = parts[3];
    const project = parts[4];
    const aliasName = parts[6];
    const payload = JSON.parse((await readBody(request)).toString("utf8") || "{}");
    aliases.set(aliasKey(scope, project, aliasName), payload.release_id);
    json(response, 200, {
      scope,
      project,
      alias: aliasName,
      release_id: payload.release_id,
    });
    return;
  }

  json(response, 404, { error: "not_found" });
}

fs.mkdirSync(storeRoot, { recursive: true });

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    json(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

server.listen(port, host, () => {
  process.stdout.write(`mock release server listening on http://${host}:${port}\n`);
});
