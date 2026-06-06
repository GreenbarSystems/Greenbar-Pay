/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "26mb" }, // §2.6: 25 MB upload cap + headroom
  },
};

export default nextConfig;
