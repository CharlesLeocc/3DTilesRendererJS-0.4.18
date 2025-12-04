import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';

const __filename = fileURLToPath( import.meta.url );
const __dirname = path.dirname( __filename );

// 可选 SOCKS5 代理（例如 v2rayN 默认本地端口 10808）
// 如需自定义，可设置环境变量 SOCKS_PROXY，例如：
//   set SOCKS_PROXY=socks5h://127.0.0.1:10808
const SOCKS_PROXY_URL = process.env.SOCKS_PROXY || 'socks5h://127.0.0.1:10808';
const socksAgent = SOCKS_PROXY_URL ? new SocksProxyAgent( SOCKS_PROXY_URL ) : null;

// 简单的本地 Google 瓦片缓存代理服务
// 前端会请求： http://localhost:8080/proxy?url=<真实的GoogleURL>
// 本服务会：
//   1. 解析 url 参数得到真实 Google URL
//   2. 以该 URL 为 key（使用 sha1）生成本地缓存文件路径
//   3. 如果缓存存在则直接返回缓存内容
//   4. 如果不存在则向 Google 请求，边写缓存边把数据返回给前端

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const CACHE_DIR = path.join(__dirname, 'tile-cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function urlToCachePath(urlString) {
  const hash = crypto.createHash('sha1').update(urlString).digest('hex');
  return path.join(CACHE_DIR, hash);
}

function sendError(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

const server = http.createServer(async (req, res) => {
  // CORS 允许前端示例访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  console.log('[proxy] incoming request', {
    method: req.method,
    path: reqUrl.pathname,
    rawUrl: req.url,
    fullUrl: reqUrl.toString(),
  });

  if (reqUrl.pathname !== '/proxy') {
    sendError(res, 404, 'Not Found');
    return;
  }

  const googleUrl = reqUrl.searchParams.get('url');
  if (!googleUrl) {
    sendError(res, 400, 'Missing url param');
    return;
  }

  console.log('[proxy] target google url:', googleUrl);
  const target = new URL(googleUrl);
  const pathname = target.pathname;
  let cachePath = null;

  // 是否缓存 .glb 或 tileset json（*.json）
  if (pathname.endsWith('.glb')) {

    // 规范化缓存 key：去掉 key / session 参数，这样不同 session / key 复用同一文件
    const cacheKeyUrl = new URL(target.toString());
    cacheKeyUrl.searchParams.delete('key');
    cacheKeyUrl.searchParams.delete('session');
    const cacheKey = cacheKeyUrl.toString();
    cachePath = urlToCachePath(cacheKey);
    console.log('[proxy] cache key url:', cacheKey);

  } else if (pathname.endsWith('.json')) {

    // 冻结所有 tileset json：按规范化后的 URL 生成稳定缓存文件
    const cacheKeyUrl = new URL(target.toString());
    cacheKeyUrl.searchParams.delete('key');
    cacheKeyUrl.searchParams.delete('session');
    const cacheKey = cacheKeyUrl.toString();
    cachePath = urlToCachePath(`json:${cacheKey}`);
    console.log('[proxy] json cache key url:', cacheKey);

  }

  // 如果缓存已存在，直接读取并返回
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      console.log('[proxy] cache hit', cachePath);
      const stat = fs.statSync(cachePath);
      res.statusCode = 200;
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Content-Length', stat.size);
      if (pathname.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      // 不强制设置其他类型的 Content-Type，浏览器会按内容嗅探；
      // 如果你需要精确类型，可以额外存 meta
      const readStream = fs.createReadStream(cachePath);
      readStream.on('error', err => {
        console.error('Read cache error:', err);
        if (!res.headersSent) {
          sendError(res, 500, 'Read cache error');
        } else {
          res.destroy();
        }
      });
      readStream.pipe(res);
      return;
    } catch (e) {
      console.error('Cache read exception:', e);
      // 继续向 Google 请求
    }
  }

  // 未命中缓存：向 Google 请求并写入缓存
  let upstreamReq;
  try {
    const useProxy = !!socksAgent && target.protocol === 'https:';
    if (useProxy) {
      console.log('[proxy] using socks proxy', SOCKS_PROXY_URL);
    }

    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      agent: useProxy ? socksAgent : undefined,
    };

    const httpModule = target.protocol === 'https:' ? https : http;

    upstreamReq = httpModule.request(options, upstreamRes => {
      res.statusCode = upstreamRes.statusCode || 502;
      // 透传 Content-Type 等常见头
      const contentType = upstreamRes.headers['content-type'];
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }

      const tmpPath = cachePath ? cachePath + '.tmp' : null;
      const fileStream = cachePath ? fs.createWriteStream(tmpPath) : null;

      upstreamRes.on('data', chunk => {
        if (fileStream) {
          fileStream.write(chunk);
        }
        res.write(chunk);
      });

      upstreamRes.on('end', () => {
        if (fileStream) {
          fileStream.end(() => {
            // 写完再 rename，避免半截文件被当成缓存
            fs.rename(tmpPath, cachePath, err => {
              if (err) {
                console.error('Rename cache file error:', err);
              }
            });
          });
        }
        res.end();
      });

      upstreamRes.on('error', err => {
        console.error('Upstream response error:', err);
        if (fileStream) {
          fileStream.destroy();
        }
        if (!res.headersSent) {
          sendError(res, 502, 'Upstream response error');
        } else {
          res.destroy();
        }
      });
    });

    upstreamReq.on('error', err => {
      const msg = err && err.message ? err.message : String(err);
      const code = err && err.code ? err.code : undefined;
      const isConnRefused = code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg);
      if (isConnRefused && SOCKS_PROXY_URL) {
        console.error('[proxy] upstream request error: cannot connect via SOCKS proxy', SOCKS_PROXY_URL, '-', msg);
      } else {
        console.error('Upstream request error:', err);
      }
      if (!res.headersSent) {
        const clientMessage = isConnRefused ? 'Upstream request error: cannot reach Google (connection refused)' : 'Upstream request error';
        sendError(res, 502, clientMessage);
      } else {
        res.destroy();
      }
    });

    upstreamReq.end();
  } catch (e) {
    console.error('Proxy exception:', e);
    sendError(res, 400, 'Invalid url param');
  }
});

server.listen(PORT, () => {
  console.log(`Google tiles proxy server listening on http://192.168.10.119:${PORT}/proxy`);
});
