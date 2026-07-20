/**
 * Returns the pod URL for a given table ID.
 * Centralised here so URL format changes only need to be made in one place.
 */
export function getPodUrl(tableId: string): string {
  return `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/pod.html?table=${tableId}`;
}
