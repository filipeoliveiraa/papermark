/**
 * Triggers a reliable file download that works across all browsers,
 * including iOS Safari, Chrome, and Brave.
 *
 * The standard approach of creating an <a> element and calling click()
 * with a cross-origin URL fails on many browsers (especially mobile)
 * because:
 * 1. The `download` attribute is ignored for cross-origin URLs
 * 2. `window.open()` is blocked by popup blockers in async callbacks
 * 3. iOS WebKit requires user activation for navigation, which expires
 *    after an async operation like fetch()
 *
 * This utility fetches the file as a blob and creates a same-origin
 * blob URL, which always respects the `download` attribute.
 */
export async function triggerBlobDownload(
  url: string,
  fileName: string,
): Promise<void> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = fileName;
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
    document.body.removeChild(link);
  }, 100);
}
