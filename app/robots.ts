import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  return {
    // "/super-admin" without a slash also covers the step-up page.
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard/", "/super-admin", "/account", "/ticket/", "/team/", "/submit/", "/attend/", "/crew/", "/order/", "/*/*/team/", "/join/", "/verify/"] },
    // Crawlers require an absolute sitemap URL; leave it out rather than emit a relative one.
    ...(baseUrl ? { sitemap: `${baseUrl}/sitemap.xml` } : {}),
  };
}
