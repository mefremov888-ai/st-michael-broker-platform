/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
