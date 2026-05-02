/**
 * Walks up from `element` (exclusive) looking for the nearest ancestor
 * whose computed `overflow-y` is `auto` or `scroll`, AND which has a
 * positive `clientHeight`. Returns that ancestor.
 *
 * If no such ancestor is found, returns `null`. Callers should fall back
 * to `window.innerHeight` or skip auto-fit in that case.
 *
 * Why "positive clientHeight": detached elements or display:none ancestors
 * report 0 here; we treat those as "not measurable" and continue walking.
 *
 * @param element - The starting element. Walking begins at element.parentElement.
 * @returns The first matching ancestor, or null if none found before
 *   reaching the document root.
 */
export function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element.parentElement;
  while (current !== null) {
    const styles = getComputedStyle(current);
    const overflowY = styles.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.clientHeight > 0) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}
