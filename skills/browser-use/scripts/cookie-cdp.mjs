import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function normalizeDomain(value) {
  const domain = value.trim().toLowerCase().replace(/^\.+/, '');
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) {
    throw new Error(`Invalid domain: ${value}`);
  }
  return domain;
}

export function domainAllowed(cookieDomain, allowedDomains) {
  const domain = cookieDomain.toLowerCase().replace(/^\.+/, '');
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function rewriteWebSocketEndpoint(rawUrl, cdpUrl) {
  const socketUrl = new URL(rawUrl);
  const endpoint = new URL(cdpUrl);
  socketUrl.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.host = endpoint.host;
  return socketUrl.toString();
}

export async function webSocketUrlFromCdpUrl(cdpUrl, timeoutMs = 10_000) {
  const endpoint = new URL(cdpUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('CDP URL must use http or https');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP version endpoint returned HTTP ${response.status}`);
    const version = await response.json();
    if (!version?.webSocketDebuggerUrl) throw new Error('CDP version response did not contain a WebSocket URL');
    return rewriteWebSocketEndpoint(version.webSocketDebuggerUrl, cdpUrl);
  } finally {
    clearTimeout(timeout);
  }
}

export async function webSocketUrlFromUserDataDir(userDataDir) {
  const lines = (await readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
  const port = lines[0]?.trim();
  const socketPath = lines[1]?.trim();
  if (!/^\d+$/.test(port || '') || !socketPath?.startsWith('/')) {
    throw new Error(`Invalid DevToolsActivePort in ${userDataDir}`);
  }
  return `ws://127.0.0.1:${port}${socketPath}`;
}

export async function cdpRequest(webSocketUrl, method, params = {}, timeoutMs = 10_000) {
  if (typeof WebSocket !== 'function') throw new Error('This script requires Node.js with global WebSocket support');
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error(`CDP WebSocket connection failed during ${method}`));
    });
  });
}

export function toCookieParam(cookie) {
  const param = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) param.sameSite = cookie.sameSite;
  if (['Low', 'Medium', 'High'].includes(cookie.priority)) param.priority = cookie.priority;
  if (['Unset', 'NonSecure', 'Secure'].includes(cookie.sourceScheme)) param.sourceScheme = cookie.sourceScheme;
  if (Number.isInteger(cookie.sourcePort)) param.sourcePort = cookie.sourcePort;
  if (cookie.partitionKey?.topLevelSite) {
    param.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
    };
  }
  if (cookie.expires > 0) param.expires = cookie.expires;
  return param;
}

export function cookieKey(cookie) {
  const partition = cookie.partitionKey?.topLevelSite
    ? `${cookie.partitionKey.topLevelSite}\0${Boolean(cookie.partitionKey.hasCrossSiteAncestor)}`
    : '';
  return `${cookie.domain}\0${cookie.path}\0${cookie.name}\0${partition}`;
}

// Keeps one socket open so a few calls can share a target session.
export async function cdpSession(webSocketUrl, callback, timeoutMs = 10_000) {
  if (typeof WebSocket !== 'function') throw new Error('This script requires Node.js with global WebSocket support');
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => fail(new Error('CDP WebSocket closed')));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out opening CDP WebSocket; approve Chrome\'s remote debugging prompt if it is showing'));
      socket.close();
    }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP WebSocket connection failed')); });
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  try {
    return await callback(send);
  } finally {
    socket.close();
  }
}
