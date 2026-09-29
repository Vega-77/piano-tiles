import { useEffect, useRef, useState } from 'react';

const EVENTS = ['pointerdown', 'pointerup', 'pointercancel', 'touchcancel'] as const;
const KEPT = 9;

/** Whether the page was opened with `?input`, which shows what the screen is sending it. */
export function wantsInputLog(search: string = window.location.search): boolean {
  return new URLSearchParams(search).has('input');
}

/**
 * A small readout of the touches the page receives, for finding out why a device's touches don't do what they should
 * (open the game with `?input` on the end of the address): every finger that goes down, comes up or is taken away by
 * the browser, where it landed, and how many are down. It only listens, so it changes nothing about the game.
 */
export function InputLog() {
  const [lines, setLines] = useState<string[]>([]);
  const [down, setDown] = useState(0);
  const fingers = useRef(new Set<number>());

  useEffect(() => {
    const seen = (e: Event) => {
      const p = e as PointerEvent;
      const kind = e.type.replace('pointer', '');
      if (e.type === 'pointerdown') fingers.current.add(p.pointerId);
      else fingers.current.delete(p.pointerId);
      const at = e.target instanceof Element ? `${e.target.tagName.toLowerCase()}${e.target.classList.length ? '.' + e.target.classList[0] : ''}` : '?';
      const who = e.type.startsWith('touch') ? '' : ` ${p.pointerType} #${p.pointerId} x${Math.round(p.clientX)} y${Math.round(p.clientY)} on ${at}`;
      setDown(fingers.current.size);
      setLines((old) => [`${(e.timeStamp / 1000).toFixed(2)} ${kind}${who}`, ...old].slice(0, KEPT));
    };
    // (Capturing, so nothing on the page can hide an event from it.)
    for (const name of EVENTS) window.addEventListener(name, seen, true);
    return () => {
      for (const name of EVENTS) window.removeEventListener(name, seen, true);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 bg-black/75 p-1 font-mono text-[10px] leading-tight text-lime-300" aria-hidden>
      <p className="font-bold">fingers down: {down}</p>
      {lines.map((line, i) => (
        <p key={`${i}-${line}`} className="truncate">
          {line}
        </p>
      ))}
    </div>
  );
}
