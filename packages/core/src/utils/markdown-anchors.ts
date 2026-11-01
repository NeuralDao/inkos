/**
 * Build stable, distinct Markdown section anchors for headings in one document.
 * Unicode letters and marks are preserved so Cyrillic headings remain useful
 * source identifiers instead of collapsing to the same fallback anchor.
 */
export function uniqueMarkdownAnchors(
  headings: ReadonlyArray<string>,
  fallback: string,
): string[] {
  const used = new Set<string>();

  return headings.map((heading) => {
    const base = heading
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      || fallback;

    let anchor = base;
    let suffix = 2;
    while (used.has(anchor)) {
      anchor = `${base}-${suffix++}`;
    }
    used.add(anchor);
    return anchor;
  });
}
