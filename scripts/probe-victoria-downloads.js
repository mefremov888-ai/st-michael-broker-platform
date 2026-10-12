// Public-source diagnostic only. Never print signed download URLs.
const { execFileSync } = require('node:child_process');
const paths = [
  '/Версия ИИ/Зорге 9/Виды/Видео/Вид с коптера на закате — 02.mov',
  '/Версия ИИ/Квартал Серебряный бор/Динамика строительства/2026.09 Сентябрь/Ход строительства — 21.jpg',
];
async function main() {
  for (const path of paths) {
    const result = { path };
    try {
      const endpoint = new URL('https://cloud-api.yandex.net/v1/disk/public/resources/download');
      endpoint.searchParams.set('public_key', 'https://disk.yandex.ru/d/Pf1bqSQkEG62sw');
      endpoint.searchParams.set('path', path);
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
      result.apiStatus = response.status;
      if (response.ok) {
        const { href } = await response.json();
        const target = new URL(href);
        if (target.protocol !== 'https:') throw new Error('Unsafe protocol');
        const get = await fetch(href, { headers: { Range: 'bytes=0-63' }, signal: AbortSignal.timeout(30000) });
        result.nodeStatus = get.status;
        if (get.body) await get.body.cancel();
        try {
          result.curlResult = execFileSync('curl', ['--silent', '--range', '0-63', '--connect-timeout', '10', '--max-time', '30', '--output', '/dev/null', '--write-out', '%{http_code} %{size_download}', href], { encoding: 'utf8', timeout: 35000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        } catch (error) { result.curlResult = String(error.stdout || '').trim(); result.curlFailed = true; }
      }
    } catch { result.probeFailed = true; }
    console.log(JSON.stringify(result));
  }
}
main();
