// Vercel Edge Function ，修复 HTML 跳转
 export const config = { runtime: 'edge' };
 
 export default async function handler(req) {
   const url = new URL(req.url);
   const pathname = url.pathname;
   const search = url.search;
   const parts = pathname.split('/').filter(Boolean);
   
   if (parts.length < 2)
     return new Response('用法: /协议/域名/路径', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
 
   const protocol = parts[0];
   const targetHost = parts[1];
   const targetPath = parts.length > 2 ? '/' + parts.slice(2).join('/') : '';
   const targetUrl = `${protocol}://${targetHost}${targetPath}${search}`;
 
   try {
     const resp = await fetch(targetUrl, {
       headers: {
         'User-Agent': req.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
         'Accept': req.headers.get('Accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
         'Accept-Language': req.headers.get('Accept-Language') || '',
       },
       redirect: 'manual',
     });
 
     // 处理重定向
     if (resp.status >= 300 && resp.status < 400) {
       const location = resp.headers.get('location');
       if (location) {
         let newLoc;
         if (location.startsWith('/'))
           newLoc = `/${protocol}/${targetHost}${location}`;
         else if (location.startsWith(`${protocol}://${targetHost}`))
           newLoc = location.replace(`${protocol}://${targetHost}`, `/${protocol}/${targetHost}`);
         else
           newLoc = location;
         return Response.redirect(new URL(newLoc, url.origin), resp.status);
       }
     }
 
     // 构造响应头（跳过编码类头）
     const contentType = resp.headers.get('Content-Type') || '';
     const headers = new Headers();
     const skip = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie']);
     for (const [k, v] of resp.headers)
       if (!skip.has(k.toLowerCase())) headers.set(k, v);
 
     let body = await resp.text();
 
     // ── HTML 内容改写 ──
     if (contentType.includes('text/html')) {
       const proxyPrefix = `/${protocol}/${targetHost}`;
       const baseHref = `${url.protocol}//${url.host}${proxyPrefix}/`;
 
       // ① 注入/替换 <base> 标签（修复相对路径）
       if (/<base\s/i.test(body))
         body = body.replace(/<base[^>]*\/?>/gi, `<base href="${baseHref}">`);
       else if (/<head[^>]*>/i.test(body))
         body = body.replace(/<head[^>]*>/i, $0 => `${$0}\n<base href="${baseHref}">`);
       else if (/<html[^>]*>/i.test(body))
         body = body.replace(/<html[^>]*>/i, $0 => `${$0}<head><base href="${baseHref}"></head>`);
 
       // ② 改写同域名绝对路径 href/src
       const escHost = targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
       body = body.replace(new RegExp(`(href=["'])${protocol}:\\/\\/${escHost}(/|(?=["']))`, 'gi'), `$1${proxyPrefix}/`);
       body = body.replace(new RegExp(`(src=["'])${protocol}:\\/\\/${escHost}(/|(?=["']))`, 'gi'), `$1${proxyPrefix}/`);
     }
 
     return new Response(body, { status: resp.status, headers });
   } catch (err) {
     return new Response(`代理错误: ${err.message}`, { status: 502 });
   }
 }
