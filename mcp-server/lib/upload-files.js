// The files an upload step gives to a file input, read here: the extension, inside Chrome,
// cannot read the disk. Their content goes to the page in base64, which puts them in the
// input (extension/src/dom/file-input.ts) — on the machine running IziTest Agent, the same
// files a person would pick there.

import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';

// All the files of one step: sent over the WebSocket, then into the page.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.xml': 'application/xml', '.html': 'text/html', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** The MIME type a browser gives a file of this name: what an `accept="image/*"` checks. */
export function mimeTypeOf(path) {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** The paths of an upload step's params: `file` for one, `files` for several. */
export function uploadPathsOf(params = {}) {
  if (Array.isArray(params.files)) return params.files;
  return params.file ? [params.file] : [];
}

/** Absolute paths: a relative one is read from the server's working directory. */
export function absolutePaths(paths) {
  return paths.map((path) => resolve(String(path)));
}

/** `[{ name, type, base64 }]` for the files at `paths`; an error naming a missing one. */
export async function readUploadFiles(paths) {
  const files = [];
  let total = 0;
  for (const path of absolutePaths(paths)) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`No file to upload at ${path}`);
    total += info.size;
    if (total > MAX_UPLOAD_BYTES) {
      throw new Error(`Too much to upload in one step: over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB in all`);
    }
    files.push({ name: basename(path), type: mimeTypeOf(path), base64: (await readFile(path)).toString('base64') });
  }
  return files;
}

/**
 * For generated code: a comment when the step gives a file by a path of the machine that
 * recorded it (what upload_file records), which CI will not have. '' otherwise.
 */
export function recordedPathNote(step) {
  const paths = [...uploadPathsOf(step.params), step.variable?.defaultValue].filter(Boolean);
  return paths.some(path => isAbsolute(String(path)))
    ? '// FIXME: a file of the machine that recorded this test — put it in the project, and give its path from where the tests run'
    : '';
}
