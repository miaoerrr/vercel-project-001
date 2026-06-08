// Vercel Edge Function — 反向代理，直接改写所有相对路径为绝对代理路径
export const config = { runtime: 'edge' };

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
        } else if (location.startsWith(`${protocol}://${targetHost}`)) {
          newLoc = location.replace(`${protocol}://${targetHost}`, `/${protocol}/${targetHost}`);
        } else {
          newLoc = location;
        }
        return Response.redirect(new URL(newLoc, url.origin), resp.status);
      }
    }

    const contentType = resp.headers.get('Content-Type') || '';
    const headers = new Headers();
    const skip = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie']);
    for (const [k, v] of resp.headers) {
      if (!skip.has(k.toLowerCase())) headers.set(k, v);
    }

    let body = await resp.text();
    const proxyPrefix = `/${protocol}/${targetHost}`;

    if (contentType.includes('text/html')) {
      const baseHref = `${url.protocol}//${url.host}${proxyPrefix}/`;

      // ═══ ① base 标签（辅助后备）═══════════════════════
      if (/<base\s/i.test(body)) {
        body = body.replace(/<base[^>]*\/?>/gi, `<base href="${baseHref}">`);
      } else if (/<head[^>]*>/i.test(body)) {
        body = body.replace(/<head[^>]*>/i, $0 => `${$0}\n<base href="${baseHref}">`);
      }

      // ═══ ② 直接改写所有相对 href/src/action ═══════════
      // 核心：不再依赖 <base>，直接让所有路径变成绝对代理路径
      // 例如: href="/signin" → href="/https/v2ex.com/signin"
      // 使用 \2 反向引用确保引号匹配
      const attrNames = 'href|src|action|formaction|data-href|data-src|data-url';
      body = body.replace(
        new RegExp(`((?:${attrNames})=)(["'])([^"']*?)\\2`, 'gi'),
        (_m, prefix, quote, value) => {
          if (
            value.startsWith('/') &&
            !value.startsWith('//') &&
            !value.startsWith(proxyPrefix) &&
            !value.includes(':')
          ) {
            return `${prefix}${quote}${proxyPrefix}${value}${quote}`;
          }
          return _m;
        }
      );

      // ═══ ③ 改写同域名的绝对 URL ════════════════════════
      const escHost = targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = body.replace(
        new RegExp(`(href=["'])${protocol}:\\/\\/${escHost}(/|(?=["']))`, 'gi'),
        `$1${proxyPrefix}/`
      );
      body = body.replace(
        new RegExp(`(src=["'])${protocol}:\\/\\/${escHost}(/|(?=["']))`, 'gi'),
        `$1${proxyPrefix}/`
      );

      // ═══ ④ 修复 JS 导航 ════════════════════════════════
      // location.href = '/path' → location.href = '/https/domain/path'
      body = body.replace(
        /((?:location|window\.location|document\.location|self\.location|top\.location)\s*\.?\s*(?:href\s*)?=\s*)(["'])(\/[^"']*?)\2/gi,
        (_m, prefix, quote, path) => {
          if (path.startsWith('//') || path.startsWith(proxyPrefix)) return _m;
          return `${prefix}${quote}${proxyPrefix}${path}${quote}`;
        }
      );
      // window.open('/path') → window.open('/https/domain/path')
      body = body.replace(
        /((?:window|self|top)\.open\s*\(\s*)(["'])(\/[^"']*?)\2/gi,
        (_m, prefix, quote, path) => {
          if (path.startsWith('//') || path.startsWith(proxyPrefix)) return _m;
          return `${prefix}${quote}${proxyPrefix}${path}${quote}`;
        }
      );
      // location.assign('/path') → location.assign('/https/domain/path')
      body = body.replace(
        /((?:window|document|self|top)\.location\.assign\s*\(\s*)(["'])(\/[^"']*?)\2/gi,
        (_m, prefix, quote, path) => {
          if (path.startsWith('//') || path.startsWith(proxyPrefix)) return _m;
          return `${prefix}${quote}${proxyPrefix}${path}${quote}`;
        }
      );
    }

    return new Response(body, { status: resp.status, headers });
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 });
  }
}
