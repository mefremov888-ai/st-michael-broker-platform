/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // 29.09: статика лендинга /v2 (картинки, шрифты, svg) отдавалась с
  // Cache-Control: max-age=0 — браузер тянул слайды заново при каждом заходе
  // при ~150–200 КБ/с с сервера. Имена файлов стабильные, при замене картинки
  // меняем имя или ждём неделю.
  async headers() {
    return [
      {
        source: '/v2/:dir(img|fonts|svg)/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=604800, stale-while-revalidate=86400' }],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL || 'http://localhost:4000'}/:path*`,
      },
      {
        source: '/files/:path*',
        destination: `${process.env.PROD_HOST || 'http://localhost:4000'}/files/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
