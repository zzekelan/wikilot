import { useEffect, useRef, useState } from "react";
import {
  openHttpPdfRangeTransport,
  type HttpPdfRangeTransport,
} from "./http-pdf-range-transport";

export function useHttpPdfRangeTransport(
  sourceUrl: string,
  sourceSize: number,
  onFailure: (error: Error) => void,
): HttpPdfRangeTransport | null {
  const [transport, setTransport] = useState<HttpPdfRangeTransport | null>(null);
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;

  useEffect(() => {
    const controller = new AbortController();
    let active: HttpPdfRangeTransport | null = null;
    setTransport(null);
    void openHttpPdfRangeTransport(
      sourceUrl,
      sourceSize,
      controller.signal,
      (error) => failureRef.current(error),
    ).then((next) => {
      if (controller.signal.aborted) next.abort();
      else {
        active = next;
        setTransport(next);
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        failureRef.current(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return () => {
      controller.abort();
      active?.abort();
    };
  }, [sourceSize, sourceUrl]);

  return transport;
}
