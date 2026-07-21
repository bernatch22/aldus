/**
 * Markdown.tsx — renderer de markdown sin dependencias + reveal por rAF para el
 * streaming del chat. Portado del signwax (components/Markdown.tsx), adaptado a
 * la paleta de Aldus (--ink / --line / --muted). Cubre lo que el modelo emite:
 * headings, bold/italic, code inline y fenced, links, listas, tablas GFM.
 * Renderiza a elementos React (nada de dangerouslySetInnerHTML) → el texto del
 * modelo no puede inyectar HTML.
 */
import { Fragment, cloneElement, isValidElement, useEffect, useRef, useState } from 'react';

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${k++}`;
    if (tok.startsWith('`')) {
      nodes.push(<code key={key} className="ai-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>);
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (link) {
        nodes.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
      } else {
        nodes.push(tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const RE_FENCE = /^```/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_UL = /^\s*[-*+]\s+/;
const RE_OL = /^\s*\d+\.\s+/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

type Align = 'left' | 'center' | 'right';
function parseAligns(sep: string): Align[] {
  return splitRow(sep).map(c => {
    const l = c.startsWith(':'); const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : 'left';
  });
}

export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  // `lines[i]!`: cada acceso está guardado por `i < lines.length` en la misma
  // expresión — noUncheckedIndexedAccess no puede verlo, el runtime sí.
  while (i < lines.length) {
    const line = lines[i]!;

    if (RE_FENCE.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i]!.trim())) { buf.push(lines[i]!); i++; }
      i++;
      blocks.push(<pre key={key++} className="ai-pre"><code>{buf.join('\n')}</code></pre>);
      continue;
    }

    const h = RE_HEADING.exec(line);
    if (h) {
      const Tag = (`h${Math.min(h[1]!.length + 2, 6)}`) as keyof React.JSX.IntrinsicElements;
      blocks.push(<Tag key={key} className="ai-h">{renderInline(h[2]!, `h${key++}`)}</Tag>);
      i++;
      continue;
    }

    if (RE_UL.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && RE_UL.test(lines[i]!)) {
        const content = lines[i]!.replace(RE_UL, '');
        items.push(<li key={items.length}>{renderInline(content, `ul${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(<ul key={key++} className="ai-list">{items}</ul>);
      continue;
    }

    if (RE_OL.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && RE_OL.test(lines[i]!)) {
        const content = lines[i]!.replace(RE_OL, '');
        items.push(<li key={items.length}>{renderInline(content, `ol${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(<ol key={key++} className="ai-list">{items}</ol>);
      continue;
    }

    // Tabla GFM: fila de header con pipes seguida de un separador.
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]!)) {
      const headers = splitRow(line);
      const aligns = parseAligns(lines[i + 1]!);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const tk = key++;
      blocks.push(
        <div key={tk} className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr>{headers.map((hd, c) => <th key={c} style={{ textAlign: aligns[c] ?? 'left' }}>{renderInline(hd, `th${tk}-${c}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((rw, ri) => (
                <tr key={ri}>
                  {headers.map((_, c) => <td key={c} style={{ textAlign: aligns[c] ?? 'left' }}>{renderInline(rw[c] ?? '', `td${tk}-${ri}-${c}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const para: string[] = [];
    while (
      i < lines.length && lines[i]!.trim() !== '' &&
      !RE_FENCE.test(lines[i]!.trim()) && !RE_HEADING.test(lines[i]!) &&
      !RE_UL.test(lines[i]!) && !RE_OL.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    const pk = key++;
    blocks.push(
      <p key={pk} className="ai-p">
        {para.map((l, idx) => (
          <Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(l, `p${pk}-${idx}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  if (caret) {
    const cursor = <span key="caret" className="ai-cursor" />;
    const lastIdx = blocks.length - 1;
    const lastBlock = blocks[lastIdx];
    if (isValidElement(lastBlock)) {
      const kids = (lastBlock.props as { children?: React.ReactNode }).children;
      const merged = [...(Array.isArray(kids) ? kids : kids != null ? [kids] : []), cursor];
      blocks[lastIdx] = cloneElement(lastBlock, undefined, ...merged);
    } else {
      blocks.push(cursor);
    }
  }

  return <div className="ai-md">{blocks}</div>;
}

export const MD_STYLES = `
.ai-md > :first-child { margin-top: 0; }
.ai-md > :last-child { margin-bottom: 0; }
.ai-p, .ai-list { margin: 0 0 7px; }
.ai-list { padding-left: 18px; }
.ai-md li { margin: 2px 0; }
.ai-h { margin: 6px 0 4px; font-size: 13px; font-weight: 650; line-height: 1.4; }
.ai-md a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.ai-code { background: color-mix(in srgb, var(--ink) 7%, transparent); padding: 1px 5px; border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ai-pre { background: color-mix(in srgb, var(--ink) 5%, transparent); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 10px; margin: 0 0 7px; overflow-x: auto; }
.ai-pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre; }
.ai-cursor { display: inline-block; width: 6px; height: 13px; margin-left: 1px;
  background: var(--muted); vertical-align: -1px; border-radius: 1px;
  animation: aiBlink 1.05s steps(1) infinite; }
@keyframes aiBlink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
.ai-table-wrap { overflow-x: auto; margin: 0 0 8px; }
.ai-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.ai-table th, .ai-table td { border: 1px solid var(--line); padding: 5px 9px; line-height: 1.4; vertical-align: top; }
.ai-table th { background: color-mix(in srgb, var(--ink) 5%, transparent); font-weight: 600; color: var(--ink); }
.ai-table tr:nth-child(even) td { background: color-mix(in srgb, var(--ink) 2.5%, transparent); }
`;

// Suavizado del reveal por rAF (portado de AiChat / pinecall ChatView): la
// longitud mostrada se acerca al target buffereado para que el texto fluya a
// ritmo parejo sin importar cómo caen los chunks de red.
const SMOOTH_SEC = 0.28;
const MIN_CPS = 24;
const MAX_CPS = 340;

/**
 * Markdown con reveal de caracteres por requestAnimationFrame. Mientras `active`,
 * el substring visible se acerca al `text` completo (que crece con los tokens),
 * dando un tipeo suave + un caret parpadeante al final. Con `active` false se
 * muestra todo de una.
 */
export function StreamingMarkdown({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(active ? 0 : text.length);
  const shownFloat = useRef(active ? 0 : text.length);
  const raf = useRef<number>();
  const prevLen = useRef(text.length);

  // Si el texto se achicó (reset de hilo / nodo reusado), reiniciar.
  if (text.length < prevLen.current) { shownFloat.current = 0; }
  prevLen.current = text.length;

  useEffect(() => {
    if (!active) {
      shownFloat.current = text.length;
      setShown(text.length);
      return;
    }
    let prevTs = 0;
    const tick = (ts: number) => {
      const target = text.length;
      const dt = prevTs ? Math.min((ts - prevTs) / 1000, 0.05) : 0;
      prevTs = ts;
      const gap = target - shownFloat.current;
      if (gap > 0) {
        const cps = Math.max(MIN_CPS, Math.min(MAX_CPS, gap / SMOOTH_SEC));
        shownFloat.current = Math.min(target, shownFloat.current + cps * dt);
        setShown(Math.floor(shownFloat.current));
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [text, active]);

  const visible = active ? text.slice(0, shown) : text;
  return <Markdown text={visible} caret={active} />;
}
