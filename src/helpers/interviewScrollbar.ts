// Geometry for the Interview window's custom scrollbars (InterviewScrollArea).

export const INTERVIEW_SCROLLBAR_MIN_THUMB = 24;

// Content still counts as "at the bottom" this close to it, so a fractional
// scroll position does not stop the view from following new content.
const FOLLOW_THRESHOLD = 16;

export interface InterviewScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface InterviewScrollbarThumb {
  size: number;
  offset: number;
}

export function resolveInterviewScrollbarThumb(
  metrics: InterviewScrollMetrics,
  trackHeight: number
): InterviewScrollbarThumb | null {
  const maxScroll = metrics.scrollHeight - metrics.clientHeight;
  if (maxScroll <= 0 || trackHeight <= 0) return null;
  const size = Math.min(
    trackHeight,
    Math.max(
      INTERVIEW_SCROLLBAR_MIN_THUMB,
      (metrics.clientHeight / metrics.scrollHeight) * trackHeight
    )
  );
  const scrollTop = Math.min(Math.max(metrics.scrollTop, 0), maxScroll);
  return { size, offset: (scrollTop / maxScroll) * (trackHeight - size) };
}

export function resolveInterviewScrollTop(
  thumbOffset: number,
  metrics: InterviewScrollMetrics,
  trackHeight: number
): number {
  const thumb = resolveInterviewScrollbarThumb(metrics, trackHeight);
  if (!thumb) return 0;
  const travel = trackHeight - thumb.size;
  if (travel <= 0) return metrics.scrollTop;
  const offset = Math.min(Math.max(thumbOffset, 0), travel);
  return (offset / travel) * (metrics.scrollHeight - metrics.clientHeight);
}

export function isInterviewScrolledToBottom(metrics: InterviewScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= FOLLOW_THRESHOLD;
}

// Whether the view keeps following new content after a scroll event. The event
// can land after more content arrived, so a scroll that moved down (the view's
// own jump to the bottom) never detaches it; only moving up away from the bottom does.
export function resolveInterviewFollow(
  following: boolean,
  previousScrollTop: number,
  metrics: InterviewScrollMetrics
): boolean {
  const atBottom = isInterviewScrolledToBottom(metrics);
  return metrics.scrollTop < previousScrollTop ? atBottom : following || atBottom;
}
