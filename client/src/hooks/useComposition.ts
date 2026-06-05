import { useRef } from "react";
import type { CompositionEvent, CompositionEventHandler, KeyboardEvent, KeyboardEventHandler } from "react";
import { usePersistFn } from "./usePersistFn";

export interface UseCompositionReturn<
  T extends HTMLInputElement | HTMLTextAreaElement,
> {
  onCompositionStart: CompositionEventHandler<T>;
  onCompositionEnd: CompositionEventHandler<T>;
  onKeyDown: KeyboardEventHandler<T>;
  isComposing: () => boolean;
}

export interface UseCompositionOptions<
  T extends HTMLInputElement | HTMLTextAreaElement,
> {
  onKeyDown?: KeyboardEventHandler<T>;
  onCompositionStart?: CompositionEventHandler<T>;
  onCompositionEnd?: CompositionEventHandler<T>;
}

type TimerResponse = ReturnType<typeof setTimeout>;

export function useComposition<
  T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement,
>(options: UseCompositionOptions<T> = {}): UseCompositionReturn<T> {
  const {
    onKeyDown: originalOnKeyDown,
    onCompositionStart: originalOnCompositionStart,
    onCompositionEnd: originalOnCompositionEnd,
  } = options;

  const composingRef = useRef(false);
  const clearTimerRef = useRef<TimerResponse | null>(null);
  const fallbackTimerRef = useRef<TimerResponse | null>(null);

  const onCompositionStart = usePersistFn((event: CompositionEvent<T>) => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }

    composingRef.current = true;
    originalOnCompositionStart?.(event);
  });

  const onCompositionEnd = usePersistFn((event: CompositionEvent<T>) => {
    // Delay clearing the composition flag so Safari can finish delivering key events.
    clearTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = setTimeout(() => {
        composingRef.current = false;
      });
    });

    originalOnCompositionEnd?.(event);
  });

  const onKeyDown = usePersistFn((event: KeyboardEvent<T>) => {
    // Ignore Escape and Enter while IME composition is still active.
    if (
      composingRef.current &&
      (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey))
    ) {
      event.stopPropagation();
      return;
    }

    originalOnKeyDown?.(event);
  });

  const isComposing = usePersistFn(() => composingRef.current);

  return {
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
    isComposing,
  };
}
