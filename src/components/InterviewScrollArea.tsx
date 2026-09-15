import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  resolveInterviewFollow,
  resolveInterviewScrollbarThumb,
  resolveInterviewScrollTop,
  type InterviewScrollbarThumb,
} from "../helpers/interviewScrollbar";

interface InterviewScrollAreaProps {
  contentClassName?: string;
  scrollbarSide?: "left" | "right";
  // "always" pins the view to new content even after scrolling away from it;
  // "atBottom" follows only while the view already sits at the bottom, so an
  // earlier line being read is never yanked away.
  followContent?: "always" | "atBottom";
  // Changing it jumps to the bottom at once, ahead of the content it announces.
  scrollToBottomKey?: number;
  children: ReactNode;
}

const readScrollMetrics = (viewport: HTMLElement) => ({
  scrollTop: viewport.scrollTop,
  scrollHeight: viewport.scrollHeight,
  clientHeight: viewport.clientHeight,
});

// On macOS the Interview window lets wheel events through to the app beneath,
// so its content never scrolls itself: the native bar is hidden and this bar is
// the one place that does (data-interview-hit makes the window catch the pointer
// there, see InterviewWindow).
export default function InterviewScrollArea({
  contentClassName,
  scrollbarSide = "right",
  followContent = "atBottom",
  scrollToBottomKey,
  children,
}: InterviewScrollAreaProps) {
  const scrollbarOnLeft = scrollbarSide === "left";
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; grabOffset: number } | null>(null);
  const [thumb, setThumb] = useState<InterviewScrollbarThumb | null>(null);

  const syncThumb = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;
    setThumb(resolveInterviewScrollbarThumb(readScrollMetrics(viewport), track.clientHeight));
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const handleResize = () => {
      // A held thumb is never pulled out from under the pointer.
      const following = followContent === "always" || followRef.current;
      if (following && !dragRef.current) viewport.scrollTop = viewport.scrollHeight;
      syncThumb();
    };
    const handleScroll = () => {
      const metrics = readScrollMetrics(viewport);
      followRef.current = resolveInterviewFollow(
        followRef.current,
        lastScrollTopRef.current,
        metrics
      );
      lastScrollTopRef.current = metrics.scrollTop;
      syncThumb();
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, [followContent, syncThumb]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
  }, [scrollToBottomKey]);

  const scrollToPointer = (clientY: number, grabOffset: number) => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;
    const thumbOffset = clientY - track.getBoundingClientRect().top - grabOffset;
    viewport.scrollTop = resolveInterviewScrollTop(
      thumbOffset,
      readScrollMetrics(viewport),
      track.clientHeight
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !thumb) return;
    event.preventDefault();
    const pointerInThumb =
      event.clientY - event.currentTarget.getBoundingClientRect().top - thumb.offset;
    // Grabbing the thumb keeps the grab point under the pointer; pressing the
    // track centers the thumb there and continues as a drag.
    const grabOffset =
      pointerInThumb >= 0 && pointerInThumb <= thumb.size ? pointerInThumb : thumb.size / 2;
    dragRef.current = { pointerId: event.pointerId, grabOffset };
    event.currentTarget.setPointerCapture(event.pointerId);
    scrollToPointer(event.clientY, grabOffset);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) scrollToPointer(event.clientY, drag.grabOffset);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop += event.deltaY;
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        className={`scrollbar-hidden absolute inset-0 overflow-y-auto overflow-x-hidden py-3 ${
          scrollbarOnLeft ? "pl-5 pr-3" : "pl-3 pr-5"
        }`}
      >
        <div ref={contentRef} className={contentClassName}>
          {children}
        </div>
      </div>
      <div
        ref={trackRef}
        data-interview-hit
        aria-hidden="true"
        className={`group absolute bottom-1.5 top-1.5 w-4 ${scrollbarOnLeft ? "left-0.5" : "right-0.5"} ${
          thumb ? "" : "invisible"
        }`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-white/[0.06] transition-[width] group-hover:w-1.5" />
        {thumb && (
          <div
            className="pointer-events-none absolute left-1/2 w-1 -translate-x-1/2 rounded-full bg-white/25 transition-[width,background-color] group-hover:w-1.5 group-hover:bg-white/55"
            style={{ top: thumb.offset, height: thumb.size }}
          />
        )}
      </div>
    </div>
  );
}
