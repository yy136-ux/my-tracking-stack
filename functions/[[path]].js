export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  // 下面这行不要动，这是去你的主站抓取真实商品页面的核心
  const targetUrl = 'https://www.ahemyes.com' + url.pathname + url.search; 
  
  // 1. 从你的真实网站获取页面内容
  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': context.request.headers.get('User-Agent') || '',
      'Accept': context.request.headers.get('Accept') || ''
    }
  });
  
  const contentType = response.headers.get('Content-Type') || '';
  // 如果不是 HTML 页面（比如图片、CSS、JS），直接原样返回
  if (!contentType.includes('text/html')) {
    return response; 
  }

  let html = await response.text();

  // 2. 净化页面内容（把敏感词替换成中性词）
  html = html.replace(/vibrator/gi, 'massager')
             .replace(/g-spot/gi, 'wellness')
             .replace(/gspot/gi, 'wellness')
             .replace(/sex toy/gi, 'personal care')
             .replace(/sex/gi, 'care')
             .replace(/adult/gi, 'personal')
             .replace(/dildo/gi, 'device');

  // 3. 替换页面里所有指向主域名的链接，确保用户在 go.ahemyes.com 上持续浏览
  html = html.replace(/https:\/\/www\.ahemyes\.com/gi, 'https://go.ahemyes.com');
  html = html.replace(/https:\/\/ahemyes\.com/gi, 'https://go.ahemyes.com');

  // 4. 返回净化后的页面给用户和 Meta 爬虫
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
