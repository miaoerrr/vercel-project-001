// Vercel Edge Function — 反向代理，修复 HTML + JS 跳转
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const search = url.search;

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    return new Response('Usage: /protocol/domain/path', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const protocol = parts[0];
  const targetHost = parts[1];
  const targetPath = parts.length > 2 ? '/' + parts.slice(2).join('/') : '';
  const targetUrl = `${protocol}://${targetHost}${targetPath}${search}`;

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          req.headers.get('User-Agent') ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept:
          req.headers.get('Accept') ||
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': req.headers.get('Accept-Language') || '',
      },
      redirect: 'manual',
    });

    // ── 1. 处理服务端 302 重定向 ─────────────────────────
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (location) {
        let newLoc;
        if (location.startsWith('/')) {
          newLoc = `/${protocol}/${targetHost}${location}`;
        } else if (
          location.startsWith(`${protocol}://${targetHost}`)
        ) {
          newLoc = location.replace(
            `${protocol}://${targetHost}`,
            `/${protocol}/${targetHost}`,
          );
        } else {
          newLoc = location;
        }
        return Response.redirect(
          new URL(newLoc, url.origin),
          resp.status,
        );
      }
    }

    const contentType = resp.headers.get('Content-Type') || '';

    const headers = new Headers();
    const skip = new Set([
      'content-encoding',
      'content-length',
      'transfer-encoding',
      'set-cookie',
    ]);
    for (const [k, v] of resp.headers) {
      if (!skip.has(k.toLowerCase())) headers.set(k, v);
    }

    let body = await resp.text();
    const proxyPrefix = `/${protocol}/${targetHost}`;

    // ── 仅对 HTML 做改写 ────────────────────────────────
    if (contentType.includes('text/html')) {
      const baseHref = `${url.protocol}//${url.host}${proxyPrefix}/`;

      // ① base 标签 — 让 <a href="/path">、<form action="/path"> 正确解析
      if (/<base\s/i.test(body)) {
        body = body.replace(
          /<base[^>]*\/?>/gi,
          `<base href="${baseHref}">`,
        );
      } else if (/<head[^>]*>/i.test(body)) {
        body = body.replace(
          /<head[^>]*>/i,
          ($0) => `${$0}\n<base href="${baseHref}">`,
        );
      } else if (/<html[^>]*>/i.test(body)) {
        body = body.replace(
          /<html[^>]*>/i,
          ($0) => `${$0}<head><base href="${baseHref}"></head>`,
        );
      }

      const escHost = targetHost.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );

      // ② 改写同域名的绝对路径 href/src
      body = body.replace(
        new RegExp(
          `(href=["'])${protocol}:\\/\\/${escHost}(/|(?=["']))`,
          'gi',
        ),
        `$1${proxyPrefix}/`,
      );
      body = body.replace(
        new RegExp(
          `(src=["'])${protocol}:\\/\\/${escHost}(/|(?=["']))`,
          'gi',
        ),
        `$1${proxyPrefix}/`,
      );

      // ③ 改写 canonical / alternate 等 link URL
      body = body.replace(
        new RegExp(
          `(<link[^>]*href=["'])${protocol}:\\/\\/${escHost}(/|(?=["']))`,
          'gi',
        ),
        `$1${proxyPrefix}/`,
      );

      // ═══ ④ 修复 JS 导航：location.href / window.open ═══
      // 这些不受 <base> 影响，必须直接改写 URL

      // location.href = '/path'  →  location.href = '/https/domain/path'
      body = body.replace(
        /((?:location|window\.location|document\.location|self\.location|top\.location)\s*\.?\s*(?:href\s*)?=\s*['"])(\/[^'"]*)['"]/gi,
        (_m, prefix, p) => {
          if (p.startsWith('//') || p.startsWith(proxyPrefix)) return _m;
          if (p.startsWith('/')) return `${prefix}${proxyPrefix}${p}"`;
          return _m;
        },
      );

      // window.open('/path')  →  window.open('/https/domain/path')
      body = body.replace(
        /((?:window|self|top)\.open\s*\(\s*['"])(\/[^'"]*)['"]/gi,
        (_m, prefix, p) => {
          if (p.startsWith('//') || p.startsWith(proxyPrefix)) return _m;
          if (p.startsWith('/')) return `${prefix}${proxyPrefix}${p}"`;
          return _m;
        },
      );

      // location.assign('/path')  →  location.assign('/https/domain/path')
      body = body.replace(
        /((?:window|document|self|top)\.location\.assign\s*\(\s*['"])(\/[^'"]*)['"]/gi,
        (_m, prefix, p) => {
          if (p.startsWith('//') || p.startsWith(proxyPrefix)) return _m;
          if (p.startsWith('/')) return `${prefix}${proxyPrefix}${p}"`;
          return _m;
        },
      );
    }

    return new Response(body, {
      status: resp.status,
      headers,
    });
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 });
  }
}
