import { useLayoutEffect, useRef, type RefObject } from "react";

/** A separate native scroll track keeps OS dragging and track clicks while
 * letting the reading viewport extend below the track's bottom edge. */
export function TimelineScrollbar({
  viewportRef,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const extentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const extent = extentRef.current;
    if (!viewport || !track || !extent) return;
    let syncedTop = 0;

    const syncFromViewport = () => {
      const range = viewport.scrollHeight - viewport.clientHeight;
      const trackRange = track.scrollHeight - track.clientHeight;
      track.scrollTop = range > 0 ? viewport.scrollTop / range * trackRange : 0;
      // Native scroll positions can round to device pixels.
      syncedTop = track.scrollTop;
    };
    const resize = () => {
      extent.style.height = `${viewport.clientHeight > 0
        ? track.clientHeight * viewport.scrollHeight / viewport.clientHeight
        : 0}px`;
      syncFromViewport();
    };
    const syncFromTrack = () => {
      if (Math.abs(track.scrollTop - syncedTop) < 1) return;
      const range = track.scrollHeight - track.clientHeight;
      if (range > 0) {
        viewport.scrollTop = track.scrollTop / range
          * (viewport.scrollHeight - viewport.clientHeight);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    observer.observe(track);
    // The virtual list's measured extent changes as rows expand or stream.
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    viewport.addEventListener("scroll", syncFromViewport);
    track.addEventListener("scroll", syncFromTrack);
    resize();
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", syncFromViewport);
      track.removeEventListener("scroll", syncFromTrack);
    };
  }, [viewportRef]);

  return (
    <div ref={trackRef} className="timeline-scrollbar" aria-hidden="true" tabIndex={-1}>
      <div ref={extentRef} />
    </div>
  );
}
