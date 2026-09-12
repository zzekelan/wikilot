/** Reveal only the element that actually scrolls, including portalled surfaces. */
export function observeScrolling(root: Document): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const onScroll = (event: Event) => {
    const element = event.target === root ? root.scrollingElement : event.target;
    if (!(element instanceof Element)) return;
    clearTimeout(timers.get(element));
    element.setAttribute("data-scrolling", "");
    timers.set(element, setTimeout(() => {
      element.removeAttribute("data-scrolling");
      timers.delete(element);
    }, 800));
  };
  root.addEventListener("scroll", onScroll, true);
  return () => {
    root.removeEventListener("scroll", onScroll, true);
    for (const [element, timer] of timers) {
      clearTimeout(timer);
      element.removeAttribute("data-scrolling");
    }
  };
}
