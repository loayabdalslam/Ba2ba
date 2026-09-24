import { useEffect, useRef, useState } from 'react';

type Line = { text: string; kind: 'input' | 'output' | 'highlight' };

// Illustrative walkthrough of the real CLI (output abridged).
const SCRIPT: Line[] = [
  { text: 'pip install bee2bee', kind: 'input' },
  { text: 'Successfully installed bee2bee-4.0.0', kind: 'output' },
  { text: 'ollama pull llama3.2', kind: 'input' },
  { text: 'bee2bee serve-ollama --model llama3.2 --region egypt --public-host node.example.com', kind: 'input' },
  { text: 'Loading ollama model \'llama3.2\'...', kind: 'output' },
  { text: 'Node peer-3f9c1e0a… running', kind: 'output' },
  { text: 'P2P address: ws://node.example.com:4003', kind: 'output' },
  { text: 'HTTP API: http://0.0.0.0:4002 (API key in ~/.bee2bee/api_key)', kind: 'output' },
  { text: 'Register on the dashboard: https://coithub.org/register?link=…', kind: 'highlight' },
];

export function AnimatedTerminal() {
  const [lines, setLines] = useState<Line[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setLines(SCRIPT);
      return;
    }
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setLines(SCRIPT.slice(0, i));
      if (i >= SCRIPT.length) window.clearInterval(id);
    }, 700);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  return (
    <div ref={box} className="w-full bg-[#050505] border border-white/5 rounded-[24px] p-6 font-mono text-xs md:text-[13px] text-gray-300 h-[360px] overflow-y-auto" aria-label="Example terminal session">
      <div className="flex gap-2 mb-6">
        <span className="w-3 h-3 rounded-full bg-red-500" />
        <span className="w-3 h-3 rounded-full bg-yellow-500" />
        <span className="w-3 h-3 rounded-full bg-green-500" />
      </div>
      <div className="space-y-2 leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={l.kind === 'input' ? 'text-emerald-400 font-semibold' : l.kind === 'highlight' ? 'text-amber-300 break-all' : ''}>
            {l.kind === 'input' && <span className="text-gray-600 mr-2">$</span>}
            <span className="whitespace-pre-wrap">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
