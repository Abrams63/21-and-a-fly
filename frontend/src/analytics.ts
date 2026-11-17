// Visit counting with Umami (no cookies, no personal data), only when the server is configured for it.

interface AnalyticsConfig {
  src: string;
  websiteId: string;
  domains: string;
}

async function loadAnalytics(): Promise<void> {
  const response = await fetch("/api/analytics");
  if (!response.ok) return;
  const config = (await response.json()) as AnalyticsConfig | null;
  if (!config) return;
  const script = document.createElement("script");
  script.defer = true;
  script.src = config.src;
  script.dataset.websiteId = config.websiteId;
  // Visits from localhost or a preview domain are not counted.
  script.dataset.domains = config.domains;
  document.head.append(script);
}

loadAnalytics().catch(() => {});
