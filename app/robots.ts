import type { MetadataRoute } from "next";

// Espace familial privé : aucune indexation par les moteurs de recherche.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
