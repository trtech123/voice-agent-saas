/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@vam/database"],
  typescript: {
    ignoreBuildErrors: true,
  },
  output: "standalone",
};

export default nextConfig;
