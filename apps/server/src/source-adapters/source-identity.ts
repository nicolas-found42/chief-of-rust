/** Conservative retrieval identity. Paths, meaningful queries and query order survive. */
export function canonicalSourceUrl(value: string): string {
  try {
    let url = new URL(value);
    for (let depth = 0; depth < 4; depth += 1) {
      if (
        !["bing.com", "www.bing.com"].includes(url.hostname) ||
        url.pathname !== "/news/apiclick.aspx"
      )
        break;
      const target = url.searchParams.get("url");
      if (!target) break;
      const destination = new URL(target);
      if (!["https:", "http:"].includes(destination.protocol)) break;
      url = destination;
    }
    if (!["https:", "http:"].includes(url.protocol)) return value;
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return value;
  }
}
